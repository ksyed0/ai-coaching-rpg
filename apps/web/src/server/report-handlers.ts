import { isValidSessionId, REPORT_SENTENCES } from "@acr/events";
import { guard, isId, readBody, sessionIdOf, failure } from "./console-sessions";
import { fail, ok } from "./envelope";
import { checkFetchSite, checkOrigin, requestAddress } from "./guards";
import type { Deps } from "./handlers";
import { LauncherError, type ReportLinkInfo, type WriteOutcome } from "./launcher-client";
import { seal, unseal } from "./seal";

// Participant report links. A participant opens a link (token in the URL fragment), the page POSTs the token to /report/enter, and the
// BFF trades it with the control service for a credential that it keeps ONLY inside a sealed, HttpOnly cookie. Reads then take the
// credential id from that cookie and nothing else: the browser never sees the id, and no body, query or header can name one.
// Nothing here logs or echoes a token, credential id, role, session id or address. Every answer is private: no-store, no-referrer.

export const REPORT_COOKIE = "__Host-scenecoach-report";
/**
 * The enter throttle's role slot: more than 5 failed tokens in 60 s from one address block it for 60 s (the join's limits). `*` cannot
 * appear in a scenario role id, so it never shares a bucket with a join.
 */
const ENTER_ROLE = "*report-enter";
/**
 * Reads are throttled in two ways, so a room of participants behind one shared address never shares a budget:
 * - READ_FAIL_ROLE (in the enter throttle's table, the join's limits): a read that fails BEFORE reaching control (no cookie, or a
 *   forged, tampered, expired or wrong-purpose one) is a failure of its address; more than 5 in 60 s block that address for 60 s.
 * - READ_CRED_ROLE (in the read throttle's table, 60 reads in 60 s): a valid read is counted against its CREDENTIAL, keyed on the
 *   unsealed credential id (an in-memory key only: never logged, never returned). The 61st read in a minute is refused.
 * The role slots start with `*`, which no scenario role id can contain, so no read key collides with an enter or a join key.
 */
const READ_FAIL_ROLE = "*report-read-fail";
const READ_CRED_ROLE = "*report-read-cred";
const MAX_TOKEN_CHARS = 64;
const MAX_ENTER_BODY_BYTES = 512;

/** The control service's fixed conflict sentences, shared through @acr/events. Anything else is shown as the generic one. */
export const KNOWN_CONFLICTS: ReadonlySet<string> = new Set([
  REPORT_SENTENCES.linkAlreadyActive,
  REPORT_SENTENCES.aiLinkRefused,
  REPORT_SENTENCES.notReady,
  REPORT_SENTENCES.noReport,
]);
const GENERIC_CONFLICT = "That action is not possible right now.";
const UNAVAILABLE = REPORT_SENTENCES.reportUnavailable;

/** Every response of this module carries the no-referrer policy (the envelope already sets no-store). */
const priv = (res: Response): Response => {
  res.headers.set("Referrer-Policy", "no-referrer");
  res.headers.set("Cache-Control", "no-store");
  return res;
};
const forbidden = () => priv(fail(403, "forbidden", "This request was refused."));
const badRequest = () => priv(fail(400, "bad_request", "The request could not be read."));
const unavailable = () => priv(fail(503, "unavailable", UNAVAILABLE));
const neutral = (headers?: Record<string, string>) => priv(fail(404, "not_found", "Not found.", headers ? { headers } : undefined));
const throttled = (retryMs: number) =>
  priv(fail(429, "rate_limited", "Too many attempts. Wait a minute and try again.", { headers: { "Retry-After": String(Math.max(1, Math.ceil(retryMs / 1000))) } }));

/** Runs a handler; an unexpected throw is a private 500 that logs only the error's name. */
async function safely(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    console.error(`web: report request failed: ${err instanceof Error ? err.name : "error"}`);
    return priv(fail(500, "internal", "Something went wrong. Try again."));
  }
}

// ---- cookie ----

export type ReportCookie = { sessionId: string; credentialId: string; role: string; expiresAt: number };

const cookieHeader = (value: string, maxAgeSeconds: number) => `${REPORT_COOKIE}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
const CLEAR_COOKIE = cookieHeader("", 0);

function readCookie(req: Request): string | null {
  for (const part of (req.headers.get("Cookie") ?? "").split(";")) {
    const p = part.trim();
    if (p.startsWith(`${REPORT_COOKIE}=`)) return p.slice(REPORT_COOKIE.length + 1);
  }
  return null;
}

const isReportCookie = (v: unknown): v is ReportCookie => {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.sessionId === "string" && isValidSessionId(c.sessionId) &&
    typeof c.credentialId === "string" && c.credentialId.length > 0 && c.credentialId.length <= MAX_TOKEN_CHARS &&
    typeof c.role === "string" && c.role.length > 0 &&
    typeof c.expiresAt === "number"
  );
};

// ---- participant routes ----

/**
 * POST /api/v1/report/enter { token }. Origin and Fetch-Metadata first (a forged cross-site POST cannot sign a victim into someone
 * else's report), then the per-address failure throttle (the join's: more than 5 failures in 60 s block the address for 60 s), then
 * the control service. A blocked address gets 429 `rate_limited` with `Retry-After` (it reveals only this caller's own failure count);
 * a refused token (unknown, expired, revoked, malformed or the wrong size) is the same neutral 404 whatever the reason.
 */
export function handleReportEnter(req: Request, deps: Deps): Promise<Response> {
  return safely(async () => {
    if (!checkOrigin(req, deps.config.publicOrigin) || !checkFetchSite(req)) return forbidden();
    const address = requestAddress(req);
    if (address === null) return badRequest();
    const throttle = deps.reportEnterThrottle;
    // A block says only that THIS address has failed too often (not whether any token is good), so it may be named: a visitor behind a
    // shared address is told to wait instead of "Not found".
    const blocked = throttle.blockedForMs(address, ENTER_ROLE);
    if (blocked > 0) return throttled(blocked);
    const body = await readBody(req, ["token"], MAX_ENTER_BODY_BYTES);
    if (body === null || typeof body.token !== "string") return badRequest();
    // A token of the wrong size cannot be a link: refused (and charged) without troubling the control service.
    const refuse = () => {
      if (throttle.blockedForMs(address, ENTER_ROLE) === 0) throttle.fail(address, ENTER_ROLE);
      return neutral();
    };
    if (body.token.length < 1 || body.token.length > MAX_TOKEN_CHARS) return refuse();
    if (!deps.launcher) return unavailable();
    let found;
    try {
      found = await deps.launcher.exchangeReportToken(body.token);
    } catch (err) {
      if (err instanceof LauncherError && (err.reason === "not_found" || err.reason === "bad_request")) return refuse();
      return unavailable();
    }
    const now = deps.now();
    const remainingMs = found.expiresAt - now;
    // Under a second left: a cookie could not honestly live that long (Max-Age is whole seconds, at least 1), so refuse.
    if (remainingMs < 1000) return refuse();
    const cookie: ReportCookie = { sessionId: found.sessionId, credentialId: found.credentialId, role: found.role, expiresAt: found.expiresAt };
    const maxAge = Math.floor(remainingMs / 1000);
    return priv(ok({}, { headers: { "Set-Cookie": cookieHeader(seal(cookie, deps.config.cookieKeys, now, "rpt"), maxAge) } }));
  });
}

/**
 * GET /api/v1/report. The credential comes from the sealed cookie only. A cookie that is missing, forged, expired or sealed for another
 * audience is the neutral 404; a credential the control service no longer honours (revoked, expired) is the same 404 and the cookie is
 * cleared; a control failure is a 503 and the cookie stays (it is not evidence of anything).
 */
export function handleReportGet(req: Request, deps: Deps): Promise<Response> {
  return safely(async () => {
    const address = requestAddress(req);
    if (address === null) return badRequest();
    const failures = deps.reportEnterThrottle;
    const blocked = failures.blockedForMs(address, READ_FAIL_ROLE);
    if (blocked > 0) return throttled(blocked);
    const token = readCookie(req);
    const c = token === null ? null : unseal<unknown>(token, deps.config.cookieKeys, deps.now(), "rpt");
    if (!isReportCookie(c)) {
      failures.fail(address, READ_FAIL_ROLE);
      return neutral();
    }
    // A valid cookie: the credential's own budget (a revoked credential still counts, so a stale tab cannot poll either).
    const perCredential = deps.reportThrottle;
    const credBlocked = perCredential.blockedForMs(c.credentialId, READ_CRED_ROLE);
    if (credBlocked > 0) return throttled(credBlocked);
    perCredential.fail(c.credentialId, READ_CRED_ROLE);
    const justBlocked = perCredential.blockedForMs(c.credentialId, READ_CRED_ROLE);
    if (justBlocked > 0) return throttled(justBlocked);
    if (!deps.launcher) return unavailable();
    try {
      const read = await deps.launcher.readReport(c.sessionId, c.credentialId);
      // The expiry comes from the sealed cookie (the credential's own expiresAt), so the page can say how long the link works.
      return priv(ok({ ...read, availableUntil: new Date(c.expiresAt).toISOString() }));
    } catch (err) {
      if (err instanceof LauncherError && err.reason === "not_found") return neutral({ "Set-Cookie": CLEAR_COOKIE });
      return unavailable();
    }
  });
}

// ---- participant writes ----

/** The write throttle's role slot (in the per-credential table, `reportWriteThrottle`): 30 writes in 60 s per credential. */
const WRITE_CRED_ROLE = "*report-write-cred";
const MAX_RATINGS_BODY_BYTES = 64 * 1024;
const MAX_RESPONSE_BODY_BYTES = 16 * 1024;
const RATING_KEYS: readonly string[] = ["ratings"];
const RESPONSE_KEYS: readonly string[] = ["criterion", "text", "dispute"];

/**
 * Fixed sentences for each refusal. Control's own text is never shown. Note: the page does not show these; it branches on the HTTP status and
 * `data.state` and uses MESSAGES (apps/web/src/lib/messages.ts). They are the envelope's `error.message` for other API clients only.
 */
const WRITE_SENTENCES: Record<string, string> = {
  closed: "This report is closed, so it can no longer be changed.",
  not_released: "This report is not open for changes yet.",
  withdrawn: "This report was withdrawn.",
  too_many: "There are too many responses already.",
  // The page's old_schema sentence is MESSAGES.reportOldSchema, the same wording as WRITE_OLD_SCHEMA in services/control/src/participant-writes.ts; this one is not shown.
  old_schema: "This report was made by an older version and cannot take changes.",
  invalid: "That could not be saved. Check what you entered.",
  busy: "The report is busy. Try again in a moment.",
};

/** The body as text, or "too_big" once it passes the cap (the rest is not read). */
export async function readCapped(req: Request, maxBytes: number): Promise<string | "too_big" | null> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return "too_big";
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeAnswer(out: WriteOutcome): Response | null {
  switch (out.state) {
    case "ok":
      return null;
    case "throttled":
      return throttled(out.retryAfterMs);
    case "invalid":
      return priv(fail(400, "invalid", WRITE_SENTENCES.invalid!, undefined, { state: "invalid" }));
    case "busy":
      return priv(fail(503, "busy", WRITE_SENTENCES.busy!, { headers: { "Retry-After": "2" } }, { state: "busy" }));
    case "too_large":
      return priv(fail(413, "payload_too_large", "That is too large to save.", undefined, { state: "too_large" }));
    default:
      return priv(fail(409, "conflict", WRITE_SENTENCES[out.state]!, undefined, { state: out.state }));
  }
}

type WriteKind = "rate" | "respond";

function handleReportWrite(req: Request, deps: Deps, kind: WriteKind): Promise<Response> {
  return safely(async () => {
    if (!checkOrigin(req, deps.config.publicOrigin) || !checkFetchSite(req)) return forbidden();
    const address = requestAddress(req);
    if (address === null) return badRequest();
    const failures = deps.reportEnterThrottle;
    const blocked = failures.blockedForMs(address, READ_FAIL_ROLE);
    if (blocked > 0) return throttled(blocked);
    const token = readCookie(req);
    const c = token === null ? null : unseal<unknown>(token, deps.config.cookieKeys, deps.now(), "rpt");
    if (!isReportCookie(c)) {
      failures.fail(address, READ_FAIL_ROLE);
      return neutral();
    }
    const writes = deps.reportWriteThrottle;
    const credBlocked = writes.blockedForMs(c.credentialId, WRITE_CRED_ROLE);
    if (credBlocked > 0) return throttled(credBlocked);
    writes.fail(c.credentialId, WRITE_CRED_ROLE);
    const justBlocked = writes.blockedForMs(c.credentialId, WRITE_CRED_ROLE);
    if (justBlocked > 0) return throttled(justBlocked);

    const type = (req.headers.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
    if (type !== "application/json") return badRequest();
    const text = await readCapped(req, kind === "rate" ? MAX_RATINGS_BODY_BYTES : MAX_RESPONSE_BODY_BYTES);
    if (text === "too_big") return priv(fail(413, "payload_too_large", "That is too large to save.", undefined, { state: "too_large" }));
    if (text === null) return badRequest();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return badRequest();
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) return badRequest();
    const b = body as Record<string, unknown>;
    // Any key beyond the route's own (a `role` above all) is refused: the role comes from the sealed cookie, never from the body.
    if (!Object.keys(b).every((k) => (kind === "rate" ? RATING_KEYS : RESPONSE_KEYS).includes(k))) return badRequest();
    if (kind === "rate" ? !Array.isArray(b.ratings) : typeof b.text !== "string") return badRequest();
    if (!deps.launcher) return unavailable();

    let outcome: WriteOutcome;
    try {
      outcome =
        kind === "rate"
          ? await deps.launcher.rateReport(c.sessionId, c.credentialId, b.ratings as never)
          : await deps.launcher.respondReport(c.sessionId, c.credentialId, b as never);
    } catch (err) {
      if (err instanceof LauncherError && err.reason === "not_found") return neutral({ "Set-Cookie": CLEAR_COOKIE });
      return unavailable();
    }
    const refused = writeAnswer(outcome);
    if (refused) return refused;
    try {
      const read = await deps.launcher.readReport(c.sessionId, c.credentialId);
      return priv(ok({ ...read, availableUntil: new Date(c.expiresAt).toISOString() }));
    } catch {
      // The write is saved; only the fresh view is missing.
      return priv(ok({ saved: true, state: "retry" }));
    }
  });
}

/** PUT /api/v1/report/self-ratings { ratings } */
export const handleReportRate = (req: Request, deps: Deps): Promise<Response> => handleReportWrite(req, deps, "rate");
/** POST /api/v1/report/responses { criterion?, text, dispute? } */
export const handleReportRespond = (req: Request, deps: Deps): Promise<Response> => handleReportWrite(req, deps, "respond");

// ---- console routes ----

/**
 * What the console may know about a link: dates and whether it is active (by this host's clock, so a link listed at its expiry instant,
 * or under clock skew with control, shows as expired). Never the credential id or the token. No `revoked` flag (BUG-0028): control lists
 * only live credentials and mints the ones it issues, so a revoked one never reaches the console; one would still read as not active.
 */
function linkDto(c: ReportLinkInfo, now: number) {
  return {
    role: c.role,
    createdAt: c.createdAt,
    expiresAt: c.expiresAt,
    ...(c.lastUsedAt !== undefined && { lastUsedAt: c.lastUsedAt }),
    active: c.revokedAt === undefined && c.expiresAt > now,
  };
}

/** A control or launcher failure for the console: conflict sentences only from the closed list, 503 for unavailable, else the console's own mapping. */
function reportFailure(err: unknown): Response {
  if (err instanceof LauncherError) {
    if (err.reason === "conflict") {
      return priv(fail(409, "conflict", err.detail !== undefined && KNOWN_CONFLICTS.has(err.detail) ? err.detail : GENERIC_CONFLICT));
    }
    if (err.reason === "unavailable") return unavailable();
  }
  return priv(failure(err));
}

/** The role segment after /report-links/, kept only when it is a role id. */
function roleOf(req: Request): string | null {
  const parts = new URL(req.url).pathname.split("/");
  const at = parts.indexOf("report-links");
  const raw = at >= 0 ? parts[at + 1] : undefined;
  if (raw === undefined) return null;
  try {
    const role = decodeURIComponent(raw);
    return isId(role) ? role : null;
  } catch {
    return null;
  }
}

/** GET /api/v1/console/sessions/:id/report-links */
export function handleConsoleReportLinks(req: Request, deps: Deps): Promise<Response> {
  return safely(async () => {
    const g = guard(req, deps, false);
    if ("response" in g) return priv(g.response);
    const id = sessionIdOf(req);
    if (id === null) return priv(fail(404, "not_found", "That session was not found."));
    if (!deps.launcher) return unavailable();
    try {
      const now = deps.now();
      const links = await deps.launcher.reportLinks(id);
      return priv(ok({ state: links.state, players: links.players, roles: links.roles.map((r) => ({ role: r.role, credential: r.credential === null ? null : linkDto(r.credential, now), selfRated: r.selfRated, draft: r.draft, ...(r.ai === true ? { ai: true } : {}) })) }));
    } catch (err) {
      return reportFailure(err);
    }
  });
}

/** POST /api/v1/console/sessions/:id/report-links { role }: issues a link; the token is in this response only. */
export function handleConsoleReportLinksIssue(req: Request, deps: Deps): Promise<Response> {
  return safely(async () => {
    const g = guard(req, deps, true);
    if ("response" in g) return priv(g.response);
    const id = sessionIdOf(req);
    if (id === null) return priv(fail(404, "not_found", "That session was not found."));
    const body = await readBody(req, ["role"]);
    if (body === null || !isId(body.role)) return badRequest();
    if (!deps.launcher) return unavailable();
    try {
      const issued = await deps.launcher.issueReportLink(id, body.role);
      return priv(ok({ role: body.role, token: issued.token, credential: linkDto(issued.credential, deps.now()) }));
    } catch (err) {
      return reportFailure(err);
    }
  });
}

/** POST /api/v1/console/sessions/:id/report-links/:role { action: "reissue" | "revoke" } */
export function handleConsoleReportLinkAction(req: Request, deps: Deps): Promise<Response> {
  return safely(async () => {
    const g = guard(req, deps, true);
    if ("response" in g) return priv(g.response);
    const id = sessionIdOf(req);
    const role = roleOf(req);
    if (id === null || role === null) return priv(fail(404, "not_found", "That session was not found."));
    const body = await readBody(req, ["action"]);
    if (body === null || (body.action !== "reissue" && body.action !== "revoke")) return badRequest();
    if (!deps.launcher) return unavailable();
    try {
      if (body.action === "revoke") return priv(ok({ role, revoked: await deps.launcher.revokeReportLink(id, role) }));
      const issued = await deps.launcher.reissueReportLink(id, role);
      return priv(ok({ role, token: issued.token, credential: linkDto(issued.credential, deps.now()) }));
    } catch (err) {
      return reportFailure(err);
    }
  });
}
