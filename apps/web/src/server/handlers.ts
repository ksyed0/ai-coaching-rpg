import { randomUUID } from "node:crypto";
import { CLIENT_ID_MAX_CHARS, isNoticeVersion, isScenarioId, isValidSessionId } from "@acr/events";
import type { Config } from "./config";
import { fail, ok } from "./envelope";
import { checkFetchSite, checkOrigin, requestAddress } from "./guards";
import { ROBOTS_TAG } from "./headers";
import type { LauncherClient } from "./launcher-client";
import { RuntimeError, type RuntimeConnection, type SetTimer } from "./runtime-connection";
import { resolveRuntimeUrl } from "./runtime-lookup";
import { seal, unseal } from "./seal";
import { sseBody } from "./sse";
import { NoStreamError, REMOVED_MESSAGE, SIGNED_OUT_MESSAGE, type SessionCookie, type SseOut, type StreamHub } from "./stream-hub";
import type { JoinThrottle } from "./throttle";
import type { ClientMessage, JoinedFrame } from "./wire";

// The /api/v1 handlers: plain Request -> Response, no Next imports (route files re-export them through routes.ts). Identity comes only
// from the sealed cookie, never from a body or a query. Nothing here logs a code, a credential, a cookie, a name or an address.

export type Deps = {
  config: Config; now: () => number; connect: typeof RuntimeConnection.connect; joinThrottle: JoinThrottle; consoleThrottle: JoinThrottle; consoleGlobalThrottle: JoinThrottle; hub: StreamHub;
  /** Set when LAUNCHER_URL is: each session's runtime is then looked up through the control service (runtime-lookup.ts). */
  launcher?: LauncherClient;
  /** The timer the console's Start wait uses (default: real timers); tests drive it by hand. */
  setTimer?: SetTimer;
};

/** `__Host-`: the browser accepts it only Secure, with Path=/ and no Domain, so a sibling subdomain cannot plant or shadow it. */
export const COOKIE_NAME = "__Host-scenecoach";
export { REMOVED_MESSAGE, SIGNED_OUT_MESSAGE };

const HOUR_MS = 3_600_000;
const RETRY_MS = 3_000;
const MAX_BODY_BYTES = 8 * 1024;
const MAX_JOIN_CODE_CHARS = 64;
const MAX_NAME_CODE_POINTS = 60;
const MAX_SAY_CHARS = 2_000;
/** Sessions whose end a stream has forwarded, remembered so a later refused rejoin reads "ended" rather than "ask for a new code". */
const MAX_ENDED_REMEMBERED = 1_024;

type Answer = { status: number; code: string; message: string };
const A = {
  forbidden: { status: 403, code: "forbidden", message: "This request was refused." },
  badRequest: { status: 400, code: "bad_request", message: "The request could not be read." },
  badName: { status: 400, code: "bad_name", message: "Enter a name of 1 to 60 characters on one line." },
  // The one answer to every refused join: it never tells whether the session, the role or the code was wrong, or the pair is blocked.
  joinRefused: { status: 401, code: "join_refused", message: "That did not work. Check the link and the code, or ask your facilitator for a new code." },
  notAcceptable: { status: 406, code: "not_acceptable", message: "This address is for the session page's live updates." },
  notSignedIn: { status: 401, code: "unauthorized", message: "You are not signed in to this session. If you have not joined yet, use your join link; if you had joined, ask your facilitator." },
  busy: { status: 503, code: "busy", message: "Too many people are connected right now. Try again in a moment." },
  unavailable: { status: 503, code: "unavailable", message: "The session server cannot be reached. Try again in a moment." },
  noStream: { status: 409, code: "no_stream", message: "Open the session page first." },
  refused: { status: 409, code: "refused", message: "The server did not accept that. Try again." },
  internal: { status: 500, code: "internal", message: "Something went wrong. Try again." },
} as const satisfies Record<string, Answer>;

/** The runtime's answers to say, consent, withdraw and leave, each with OUR text (the runtime's own text never reaches the page). */
const SEND_ANSWERS: Record<string, Answer> = {
  rate_limited: { status: 429, code: "rate_limited", message: "Too many messages. Wait a moment and try again." },
  consent_version: { status: 409, code: "consent_version", message: "The notice has changed. Reload the page to read the current one." },
  already_started: { status: 409, code: "already_started", message: "The session has already started." },
  not_started: { status: 409, code: "not_started", message: "The session has not started yet." },
  paused: { status: 409, code: "paused", message: "The session is paused." },
  ended: { status: 409, code: "ended", message: "The session has ended." },
  not_in_scene: { status: 409, code: "not_in_scene", message: "You are not in the current scene." },
  stale_scene: { status: 409, code: "stale_scene", message: "The scene has changed. Read the new scene, then try again." },
  bad_message: A.badRequest,
  bad_json: A.badRequest,
  internal: A.unavailable,
};
/** Join failures that mean the runtime is unreachable or broken, not a refusal: 503, never charged. */
const JOIN_UNAVAILABLE = new Set(["unavailable", "closed", "internal"]);

const answer = (a: Answer, headers?: Record<string, string>) => fail(a.status, a.code, a.message, headers ? { headers } : undefined);
const logFailure = (what: string, err: unknown) => console.error(`web: ${what} failed: ${err instanceof Error ? err.name : "error"}`);

// ---- cookie ----

const cookieHeader = (value: string, maxAgeSeconds: number) => `${COOKIE_NAME}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
const CLEAR_COOKIE = cookieHeader("", 0);

function readCookie(req: Request): string | null {
  for (const part of (req.headers.get("Cookie") ?? "").split(";")) {
    const p = part.trim();
    if (p.startsWith(`${COOKIE_NAME}=`)) return p.slice(COOKIE_NAME.length + 1);
  }
  return null;
}

/** Seals the cookie; Max-Age is what is left of its sealed lifetime, so a reissue never extends it. */
function issueCookie(c: SessionCookie, deps: Deps): string {
  const now = deps.now();
  return cookieHeader(seal(c, deps.config.cookieKeys, now), Math.max(0, Math.floor((c.expiresAt - now) / 1000)));
}

const isSessionCookie = (v: unknown): v is SessionCookie => {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return ["sessionId", "roleId", "participantId", "credential", "logIdentity"].every((k) => typeof c[k] === "string") && typeof c.expiresAt === "number";
};

/**
 * Whether a cookie value holds a seat in `sessionId` (it opens with one of the keys, is unexpired and names that session). The /join
 * page uses it server side to send a seated player to their session instead of asking again for a code that no longer works. It
 * returns only the yes or no: nothing from the cookie reaches the page.
 */
export function seatedIn(token: string | undefined, sessionId: string, keys: Config["cookieKeys"], now: number): boolean {
  if (!token) return false;
  const c = unseal<unknown>(token, keys, now);
  return isSessionCookie(c) && c.sessionId === sessionId;
}

/** The cookie, or the 401 to answer. A cookie that cannot be opened (tampered, other key, expired) is cleared. */
function signedIn(req: Request, deps: Deps): { cookie: SessionCookie } | { response: Response } {
  const token = readCookie(req);
  if (token === null) return { response: answer(A.notSignedIn) };
  const c = unseal<unknown>(token, deps.config.cookieKeys, deps.now());
  if (!isSessionCookie(c)) return { response: answer(A.notSignedIn, { "Set-Cookie": CLEAR_COOKIE }) };
  return { cookie: c };
}

// ---- request bodies ----

/** A JSON object of at most MAX_BODY_BYTES, read without ever holding more; null for anything else. */
export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  if (!req.body) return null;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const v: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 1 to 60 code points after trimming, on one line. The runtime cleans it again (hidden and bidirectional characters). */
function displayName(v: string): string | null {
  const t = v.trim();
  const n = [...t].length;
  return n >= 1 && n <= MAX_NAME_CODE_POINTS && !/[\r\n\t]/.test(v) ? t : null;
}

/** A role id is checked before it is a throttle key: the scenario id shape (lower case, digits, _ and -) and the transport cap. */
const isRoleId = (v: string) => v.length <= CLIENT_ID_MAX_CHARS && isScenarioId(v);

/** The browser's Last-Event-ID (the last seq it holds); anything that is not a plain safe integer resumes from 0. */
function lastSeqOf(v: string | null): number {
  if (v === null || !/^\d{1,16}$/.test(v)) return 0;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : 0;
}

// ---- server-sent events ----

const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream; charset=utf-8",
  // no-transform: no proxy may compress (and so buffer) the stream.
  "Cache-Control": "no-store, no-transform",
  "X-Accel-Buffering": "no",
  "X-Robots-Tag": ROBOTS_TAG,
};
function sseHeaders(setCookie: string | undefined): Headers {
  const h = new Headers(SSE_HEADERS);
  if (setCookie !== undefined) h.set("Set-Cookie", setCookie);
  return h;
}
/**
 * A stream that is over before it starts. `reconnecting` lets the browser's EventSource come back after `retry` with its Last-Event-ID
 * kept (no id is sent here); `signed_out`, `removed`, `ended` and `superseded` are final (the page closes its EventSource).
 */
function sseFinal(event: string, data: unknown = {}, setCookie?: string): Response {
  return new Response(`retry: ${RETRY_MS}\n\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`, { status: 200, headers: sseHeaders(setCookie) });
}

const endedLogs = new WeakMap<StreamHub, Set<string>>();
const endedKey = (c: SessionCookie) => JSON.stringify([c.sessionId, c.logIdentity]);
function markEnded(hub: StreamHub, c: SessionCookie): void {
  let s = endedLogs.get(hub);
  if (!s) { s = new Set(); endedLogs.set(hub, s); }
  s.add(endedKey(c));
  if (s.size > MAX_ENDED_REMEMBERED) s.delete(s.values().next().value!);
}
const hasEnded = (hub: StreamHub, c: SessionCookie) => endedLogs.get(hub)?.has(endedKey(c)) ?? false;

// ---- handlers ----

/**
 * POST /api/v1/join { sessionId, role, joinCode, displayName }. Throttled per (address, role) BEFORE the runtime is contacted; only a
 * refused code is charged, and never while the pair is blocked (or the throttle is saturated). Every refusal is the same answer.
 */
export async function handleJoin(req: Request, deps: Deps): Promise<Response> {
  if (!checkOrigin(req, deps.config.publicOrigin) || !checkFetchSite(req)) return answer(A.forbidden);
  const address = requestAddress(req);
  if (address === null) return answer(A.badRequest);
  const body = await readJson(req);
  if (body === null) return answer(A.badRequest);
  const { sessionId, role, joinCode } = body;
  if (typeof sessionId !== "string" || typeof role !== "string" || typeof joinCode !== "string" || typeof body.displayName !== "string") return answer(A.badRequest);
  const name = displayName(body.displayName);
  if (name === null) return answer(A.badName);
  if (!isValidSessionId(sessionId) || !isRoleId(role) || joinCode.length < 1 || joinCode.length > MAX_JOIN_CODE_CHARS) return answer(A.joinRefused);
  const throttle = deps.joinThrottle;
  if (throttle.blockedForMs(address, role) > 0) return answer(A.joinRefused);

  // Launcher mode: the session's own runtime. An unknown, stopped or ended session is refused like any other join (no code was
  // guessed, so nothing is charged); a launcher that cannot be reached is "unavailable".
  let runtimeUrl: string | null;
  try { runtimeUrl = await resolveRuntimeUrl(deps, sessionId); } catch { return answer(A.unavailable); }
  if (runtimeUrl === null) return answer(A.joinRefused);
  let conn: RuntimeConnection;
  try { conn = await deps.connect(runtimeUrl, address); }
  // 429 is the runtime's own address block: a refusal like any other. Anything else: the runtime is not there.
  catch (err) { return err instanceof RuntimeError && err.code === "rate_limited" ? answer(A.joinRefused) : answer(A.unavailable); }
  // Opaque and minted here: the person's name is the display name, never an id.
  const participantId = randomUUID();
  let joined: JoinedFrame;
  try {
    joined = await conn.joinWithCode({ sessionId, roleId: role, participantId, joinCode, displayName: name });
  } catch (err) {
    if (!(err instanceof RuntimeError)) { logFailure("join", err); return answer(A.internal); }
    if (err.code === "unauthorized") {
      // A request that was in flight when the pair got blocked (or the table saturated) must not charge it again.
      if (throttle.blockedForMs(address, role) === 0) throttle.fail(address, role);
      return answer(A.joinRefused);
    }
    if (err.code === "bad_message") return answer(A.badName); // the only field the runtime refuses that we did not fully check
    return JOIN_UNAVAILABLE.has(err.code) ? answer(A.unavailable) : answer(A.joinRefused);
  } finally {
    // The stream opens its own connection by credential; this one was only for the code.
    conn.close();
  }
  if (typeof joined.credential !== "string" || typeof joined.logIdentity !== "string") return answer(A.internal);
  const now = deps.now();
  const cookie: SessionCookie = {
    sessionId, roleId: role, participantId, credential: joined.credential, logIdentity: joined.logIdentity, expiresAt: now + deps.config.cookieMaxAgeHours * HOUR_MS,
  };
  return ok({ sessionId, roleId: role }, { headers: { "Set-Cookie": issueCookie(cookie, deps) } });
}

/**
 * GET /api/v1/stream?session=<id>. Rejoins by the cookie's credential with the browser's Last-Event-ID and bridges the runtime to SSE
 * through the hub. A cross-site request is refused; an aborted request or a cancelled body closes the runtime socket.
 */
export async function handleStream(req: Request, deps: Deps): Promise<Response> {
  if (!checkFetchSite(req)) return answer(A.forbidden);
  const origin = req.headers.get("Origin");
  if (origin !== null && origin !== deps.config.publicOrigin) return answer(A.forbidden);
  // Only an EventSource (which always sends this) may open a stream: a top-level navigation from another site, in a browser without
  // Sec-Fetch-Site, would otherwise take the seat over from the player's tab.
  if (!(req.headers.get("Accept") ?? "").toLowerCase().includes("text/event-stream")) return answer(A.notAcceptable);
  const address = requestAddress(req);
  if (address === null) return answer(A.badRequest);
  const who = signedIn(req, deps);
  if ("response" in who) return who.response;
  const cookie = who.cookie;
  // The page names its session; a cookie for another one is not signed in here (and is left alone: it is valid there).
  if (new URL(req.url).searchParams.get("session") !== cookie.sessionId) return answer(A.notSignedIn);
  // Before any connection: once open() answers "capacity" the connection is already gone.
  if (!deps.hub.hasCapacity(cookie, address)) return answer(A.busy);

  // A stopped or unknown session, or an unreachable launcher, reads as a runtime that is not there: the browser retries.
  let runtimeUrl: string | null;
  try { runtimeUrl = await resolveRuntimeUrl(deps, cookie.sessionId); } catch { return sseFinal("reconnecting"); }
  if (runtimeUrl === null) return sseFinal("reconnecting");
  let conn: RuntimeConnection;
  try { conn = await deps.connect(runtimeUrl, address); }
  catch { return sseFinal("reconnecting"); }
  let joined: JoinedFrame;
  try {
    joined = await conn.joinWithCredential({ sessionId: cookie.sessionId, roleId: cookie.roleId, participantId: cookie.participantId, credential: cookie.credential, lastSeq: lastSeqOf(req.headers.get("Last-Event-ID")) });
  } catch (err) {
    conn.close();
    const code = err instanceof RuntimeError ? err.code : "unavailable";
    // The runtime revoked the credential (leave, withdrawal, a fresh start) or the session ended (which revokes every credential).
    if (code === "unauthorized") return hasEnded(deps.hub, cookie) ? sseFinal("ended", {}, CLEAR_COOKIE) : sseFinal("signed_out", { message: SIGNED_OUT_MESSAGE }, CLEAR_COOKIE);
    if (code === "session_ended") return sseFinal("ended", {}, CLEAR_COOKIE);
    if (code === "superseded") return sseFinal("superseded");
    // The role's code was reissued while this stream was joining: the credential is revoked, exactly as for a refused one.
    if (code === "reissued") return sseFinal("signed_out", { message: SIGNED_OUT_MESSAGE }, CLEAR_COOKIE);
    // The facilitator removed this player while the stream was joining: same as a revoked credential, with its own message.
    if (code === "removed") return sseFinal("removed", { message: REMOVED_MESSAGE }, CLEAR_COOKIE);
    return sseFinal("reconnecting");
  }
  // Nobody is listening any more.
  if (req.signal.aborted) { conn.close(); return sseFinal("reconnecting"); }
  // The cookie may have expired while the join was in flight (the hub checks again only at its heartbeat).
  if (cookie.expiresAt <= deps.now()) { conn.close(); return answer(A.notSignedIn, { "Set-Cookie": CLEAR_COOKIE }); }

  // From here the connection is ours until the hub takes it: any throw (a cookie that cannot be sealed, a failing open) closes it.
  try {
    // Another log (a fresh start): the hub sends a reset; the cookie is reissued with the new identity, or every reconnect would reset.
    const current: SessionCookie = typeof joined.logIdentity === "string" && joined.logIdentity !== cookie.logIdentity ? { ...cookie, logIdentity: joined.logIdentity } : cookie;
    const setCookie = joined.state?.status === "ended" ? CLEAR_COOKIE : current !== cookie ? issueCookie(current, deps) : undefined;

    const body = sseBody();
    let handle: { close(): void } | null = null;
    const stop = () => handle?.close();
    const out: SseOut = {
      write: (chunk) => {
        if (chunk.startsWith("event: ended\n")) markEnded(deps.hub, current);
        return body.out.write(chunk);
      },
      end: () => { req.signal.removeEventListener("abort", stop); body.out.end(); },
    };
    // The original cookie: its log identity is what tells the hub to reset.
    const opened = deps.hub.open(cookie, address, conn, joined, out);
    if (opened === "capacity") return answer(A.busy); // the hub closed the connection; it is not reused
    handle = opened;
    body.onCancel(stop);
    req.signal.addEventListener("abort", stop, { once: true });
    return new Response(body.stream, { status: 200, headers: sseHeaders(setCookie) });
  } catch (err) {
    conn.close();
    logFailure("stream", err);
    return answer(A.internal);
  }
}

/** say, consent and leave: over the participant's open stream connection (a new connection would supersede the stream). */
async function relay(req: Request, deps: Deps, parse: (req: Request) => Promise<ClientMessage | null>): Promise<Response> {
  if (!checkOrigin(req, deps.config.publicOrigin) || !checkFetchSite(req)) return answer(A.forbidden);
  const who = signedIn(req, deps);
  if ("response" in who) return who.response;
  const m = await parse(req);
  if (m === null) return answer(A.badRequest);
  let reply;
  try { reply = await deps.hub.send(who.cookie, m); }
  catch (err) {
    if (err instanceof NoStreamError) return answer(A.noStream);
    logFailure(m.type, err);
    return answer(A.internal);
  }
  if (reply?.type === "error") return answer(Object.hasOwn(SEND_ANSWERS, reply.code) ? SEND_ANSWERS[reply.code]! : A.refused);
  // Leaving and withdrawing revoke the credential: the cookie can no longer open anything.
  const revoked = m.type === "leave" || m.type === "withdraw_consent";
  return ok({}, revoked ? { headers: { "Set-Cookie": CLEAR_COOKIE } } : undefined);
}

/** POST /api/v1/say { text, expectSceneId? } */
export function handleSay(req: Request, deps: Deps): Promise<Response> {
  return relay(req, deps, async (r) => {
    const b = await readJson(r);
    if (b === null || typeof b.text !== "string" || b.text.length < 1 || b.text.length > MAX_SAY_CHARS) return null;
    const scene = b.expectSceneId;
    if (scene !== undefined && (typeof scene !== "string" || scene.length < 1 || scene.length > CLIENT_ID_MAX_CHARS)) return null;
    return scene === undefined ? { type: "say", text: b.text } : { type: "say", text: b.text, expectSceneId: scene };
  });
}

/** POST /api/v1/consent { noticeVersion } gives consent; { withdraw: true } withdraws it (before the start). */
export function handleConsent(req: Request, deps: Deps): Promise<Response> {
  return relay(req, deps, async (r) => {
    const b = await readJson(r);
    if (b === null) return null;
    if (b.withdraw !== undefined) return b.withdraw === true ? { type: "withdraw_consent" } : null;
    return typeof b.noticeVersion === "string" && isNoticeVersion(b.noticeVersion) ? { type: "consent", noticeVersion: b.noticeVersion } : null;
  });
}

/** POST /api/v1/leave (no body): gives up the seat before the start. */
export function handleLeave(req: Request, deps: Deps): Promise<Response> {
  return relay(req, deps, async () => ({ type: "leave" }));
}
