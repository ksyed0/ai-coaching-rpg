import { isValidSessionId } from "@acr/events";
import { guard, isId, readBody, sessionIdOf, failure } from "./console-sessions";
import { fail, ok } from "./envelope";
import { checkFetchSite, checkOrigin, requestAddress } from "./guards";
import type { Deps } from "./handlers";
import { LauncherError, type ReportLinkInfo } from "./launcher-client";
import { seal, unseal } from "./seal";

// Participant report links. A participant opens a link (token in the URL fragment), the page POSTs the token to /report/enter, and the
// BFF trades it with the control service for a credential that it keeps ONLY inside a sealed, HttpOnly cookie. Reads then take the
// credential id from that cookie and nothing else: the browser never sees the id, and no body, query or header can name one.
// Nothing here logs or echoes a token, credential id, role, session id or address. Every answer is private: no-store, no-referrer.

export const REPORT_COOKIE = "__Host-scenecoach-report";
/** The enter throttle's role slot. `*` cannot appear in a scenario role id, so it never shares a bucket with a join. */
const ENTER_ROLE = "*report-enter";
/** The enter throttle: more than 5 failed tokens in 60 s from one address block it for 60 s (the join's limits). */
const READ_ROLE = "*report-read";
const MAX_TOKEN_CHARS = 64;
const MAX_ENTER_BODY_BYTES = 512;

/** The control service's fixed conflict sentences (reports.ts, report-access.ts). Anything else is shown as the generic one. */
const KNOWN_CONFLICTS: ReadonlySet<string> = new Set([
  "A link is already active for this role.",
  "No reports are ready for this session yet. Run evaluate, then moderate open and release, from the terminal (see the guide).",
  "There is no released report to link for this role.",
]);
const GENERIC_CONFLICT = "That action is not possible right now.";
const UNAVAILABLE = "The report is unavailable. Try again.";

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
 * the control service. Every refusal, blocked or not, is the same neutral 404.
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
    const blocked = deps.reportThrottle.blockedForMs(address, READ_ROLE);
    if (blocked > 0) return throttled(blocked);
    // Every read is counted (the throttle is a rate limit here, not a failure count).
    deps.reportThrottle.fail(address, READ_ROLE);
    const token = readCookie(req);
    if (token === null) return neutral();
    const c = unseal<unknown>(token, deps.config.cookieKeys, deps.now(), "rpt");
    if (!isReportCookie(c)) return neutral();
    if (!deps.launcher) return unavailable();
    try {
      return priv(ok(await deps.launcher.readReport(c.sessionId, c.credentialId)));
    } catch (err) {
      if (err instanceof LauncherError && err.reason === "not_found") return neutral({ "Set-Cookie": CLEAR_COOKIE });
      return unavailable();
    }
  });
}

// ---- console routes ----

/** What the console may know about a link: dates and two booleans. Never the credential id or the token. */
function linkDto(c: ReportLinkInfo, now: number) {
  const revoked = c.revokedAt !== undefined;
  return {
    role: c.role,
    createdAt: c.createdAt,
    expiresAt: c.expiresAt,
    ...(c.lastUsedAt !== undefined && { lastUsedAt: c.lastUsedAt }),
    active: !revoked && c.expiresAt > now,
    revoked,
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
      return priv(ok({ state: links.state, roles: links.roles.map((r) => ({ role: r.role, credential: r.credential === null ? null : linkDto(r.credential, now) })) }));
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
