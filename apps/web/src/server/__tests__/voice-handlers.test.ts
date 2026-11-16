import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config";
import { setEnvelopeClock } from "../envelope";
import { FacilitatorBudget } from "../facilitator-budget";
import { FacilitatorHub } from "../facilitator-hub";
import { COOKIE_NAME, handleVoice, handleVoiceToken, VOICE_TOKEN_THROTTLE, type Deps } from "../handlers";
import { LauncherError, type LauncherClient, type LauncherReason } from "../launcher-client";
import { realTimer } from "../runtime-connection";
import { seal } from "../seal";
import { StreamHub, type SessionCookie } from "../stream-hub";
import { JoinThrottle } from "../throttle";
import type { ClientMessage, JoinedFrame, ServerMessage } from "../wire";
import { asConn, FakeConn, manualTimers, sseRecorder, until } from "./fakes";

// US-0071 (A1b Task 11): POST /api/v1/voice (the voice choice and mute, relayed over the player's own stream connection) and
// POST /api/v1/voice/token (a LiveKit token for the cookie's own seat, from the control service). Identity comes only from the sealed
// cookie; a cross-site write is refused before anything else (the throttle included); the token appears only in its one response body.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ORIGIN = "https://play.example.org";
const KEYS: Config["cookieKeys"] = [{ id: "k1", key: Buffer.alloc(32, 7) }];
const ADDR = "198.51.100.7";
const T0 = 1_900_000_000_000;
const SID = "s-0123456789abcdef";
const LIVEKIT = "wss://voice.example.org";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZWxpdmVyeV9sZWFkLmcwMTIzNDU2NyJ9.U0VDUkVULVNJR05BVFVSRQ";

let clock = T0;
const cookie = (o: Partial<SessionCookie> = {}): SessionCookie => ({ sessionId: SID, roleId: "delivery_lead", participantId: "p-1", credential: "CRED-0123456789abcdef", logIdentity: "log-1", expiresAt: T0 + 3_600_000, ...o });
const sealed = (c: SessionCookie = cookie()) => seal(c, KEYS, clock);
const guarded = { Origin: ORIGIN, "X-Requested-With": "scenecoach", "Content-Type": "application/json" };
const req = (path: string, o: { cookie?: string | null; body?: unknown; headers?: Record<string, string> } = {}) => {
  const c = o.cookie === undefined ? sealed() : o.cookie;
  return new Request(`${ORIGIN}/api/v1/${path}`, {
    method: "POST",
    headers: { "X-Forwarded-For": ADDR, ...(o.headers ?? guarded), ...(c === null ? {} : { Cookie: `${COOKIE_NAME}=${c}` }) },
    ...(o.body === undefined ? {} : { body: typeof o.body === "string" ? o.body : JSON.stringify(o.body) }),
  });
};

type TokenCall = { sessionId: string; roleId: string; participantId: string };
function makeDeps(o: { launcher?: false | ((c: TokenCall) => Promise<{ token: string; expiresAt: number }>); livekitUrl?: string | null } = {}) {
  const timers = manualTimers();
  const hub = new StreamHub({ maxStreams: 10, maxStreamsPerSession: 10, maxStreamsPerAddress: 10, setTimer: timers.setTimer, now: () => clock });
  const config: Config = {
    runtimeUrl: "ws://127.0.0.1:1", publicOrigin: ORIGIN, cookieKeys: KEYS, cookieMaxAgeHours: 12, maxStreams: 10, maxStreamsPerSession: 10, maxStreamsPerAddress: 10,
    ...(o.livekitUrl === null ? {} : { livekitUrl: o.livekitUrl ?? LIVEKIT }),
  };
  const calls: TokenCall[] = [];
  const answer = o.launcher === false ? undefined : (o.launcher ?? (async () => ({ token: JWT, expiresAt: T0 + 600_000 })));
  const launcher = answer && ({ voiceToken: vi.fn(async (sessionId: string, roleId: string, participantId: string) => { calls.push({ sessionId, roleId, participantId }); return answer({ sessionId, roleId, participantId }); }) } as unknown as LauncherClient);
  const t = (max: number, windowMs = 60_000, blockMs = 60_000) => new JoinThrottle({ max, windowMs, blockMs, now: () => clock });
  const deps: Deps = {
    config, now: () => clock, connect: (() => { throw new Error("no connect in these tests"); }) as unknown as Deps["connect"],
    joinThrottle: t(5), consoleThrottle: t(5), consoleGlobalThrottle: t(20, 600_000, 300_000), consoleLoginThrottle: t(5), reportThrottle: t(60), reportWriteThrottle: t(30), consoleReportThrottle: t(60),
    reportEnterThrottle: t(5), reportReadFailThrottle: t(5), voiceTokenThrottle: new JoinThrottle({ ...VOICE_TOKEN_THROTTLE, now: () => clock }),
    hub, facilitatorBudget: new FacilitatorBudget(), facilitatorHub: new FacilitatorHub({ setTimer: realTimer, now: () => clock }),
    ...(launcher ? { launcher } : {}),
  };
  return { deps, timers, hub, calls };
}

/** The player's open stream, on a scripted connection whose `answer` plays the runtime. */
function openStream(hub: StreamHub, answer: (m: ClientMessage) => ServerMessage | null, c: SessionCookie = cookie()) {
  const conn = new FakeConn();
  conn.answer = answer;
  const rec = sseRecorder();
  const joined: JoinedFrame = { type: "joined", roleId: c.roleId, state: { lastSeq: 0 } as JoinedFrame["state"], logIdentity: c.logIdentity, replay: { afterSeq: 0, toSeq: 0, events: 0, complete: true } };
  const h = hub.open(c, ADDR, asConn(conn), joined, rec.out);
  if (h === "capacity") throw new Error("capacity");
  return { conn, rec };
}
const body = async (res: Response) => (await res.json()) as { success: boolean; data: any; error: { code: string; message: string } | null };

let logs: string[] = [];
beforeEach(() => {
  clock = T0;
  setEnvelopeClock(() => new Date(T0));
  logs = [];
  for (const k of ["log", "warn", "error", "info", "debug"] as const) vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
});
afterEach(() => vi.restoreAllMocks());

describe("POST /api/v1/voice", () => {
  it("choice voice relays voice_opt_in with the notice version and answers the state and muted of the voice frame", async () => {
    const { deps, hub } = makeDeps();
    const s = openStream(hub, (m) => (m.type === "voice_opt_in" ? { type: "voice", state: "voice", muted: false } : null));
    const res = await handleVoice(req("voice", { body: { choice: "voice", noticeVersion: "v3" } }), deps);
    expect(res.status).toBe(200);
    expect((await body(res)).data).toEqual({ state: "voice", muted: false });
    expect(s.conn.sent).toEqual([{ type: "voice_opt_in", noticeVersion: "v3" }]);
  });

  it("choice text_only relays voice_opt_out; mute relays voice_mute with the boolean", async () => {
    const { deps, hub } = makeDeps();
    const s = openStream(hub, (m) => (m.type === "voice_opt_out" ? { type: "voice", state: "text_only", muted: false } : m.type === "voice_mute" ? { type: "voice", state: "voice", muted: m.muted } : null));
    const a = await handleVoice(req("voice", { body: { choice: "text_only" } }), deps);
    expect((await body(a)).data).toEqual({ state: "text_only", muted: false });
    const b = await handleVoice(req("voice", { body: { mute: true } }), deps);
    expect((await body(b)).data).toEqual({ state: "voice", muted: true });
    const c = await handleVoice(req("voice", { body: { mute: false } }), deps);
    expect((await body(c)).data).toEqual({ state: "voice", muted: false });
    expect(s.conn.sent).toEqual([{ type: "voice_opt_out" }, { type: "voice_mute", muted: true }, { type: "voice_mute", muted: false }]);
  });

  it("a voice frame whose muted is not a boolean answers the state only; one with an unknown state is unconfirmed", async () => {
    const { deps, hub } = makeDeps();
    let next: ServerMessage = { type: "voice", state: "voice", muted: "yes" } as never;
    openStream(hub, () => next);
    expect((await body(await handleVoice(req("voice", { body: { choice: "text_only" } }), deps))).data).toEqual({ state: "voice" });
    next = { type: "voice", state: "loud", muted: false } as never;
    const res = await handleVoice(req("voice", { body: { choice: "text_only" } }), deps);
    expect(res.status).toBe(504);
    expect((await body(res)).error!.code).toBe("unconfirmed");
  });

  it.each([
    ["a participantId", { choice: "voice", noticeVersion: "v3", participantId: "p-2" }], ["a roleId", { choice: "text_only", roleId: "tech_lead" }],
    ["a mute with a roleId", { mute: true, roleId: "tech_lead" }], ["both a choice and mute", { choice: "text_only", mute: true }], ["an unknown choice", { choice: "text" }],
    ["voice without a notice version", { choice: "voice" }], ["a notice version that is not one", { choice: "voice", noticeVersion: "../v3" }],
    ["text_only with a notice version", { choice: "text_only", noticeVersion: "v3" }], ["a mute that is not a boolean", { mute: "true" }], ["an empty object", {}],
    ["an array", "[]"], ["not JSON", "mute"],
  ])("a body with %s is 400 and nothing is sent", async (_n, b) => {
    const { deps, hub } = makeDeps();
    const s = openStream(hub, () => ({ type: "voice", state: "voice", muted: false }));
    const res = await handleVoice(req("voice", { body: b }), deps);
    expect(res.status).toBe(400);
    expect(s.conn.sent).toEqual([]);
  });

  it.each([
    ["voice_notice_required", 409, "Voice needs the current consent notice, which you did not agree to before the start. You can take part by text."],
    ["voice_off", 409, "Voice is not available in this session."],
    ["consent_version", 409, "The notice has changed. Reload the page to read the current one."],
    ["rate_limited", 429, "Too many messages. Wait a moment and try again."],
    ["bad_message", 400, "The request could not be read."],
    ["forbidden", 409, "The server did not accept that. Try again."],
    ["not_joined", 409, "The server did not accept that. Try again."],
  ])("the runtime's %s maps to %i with the BFF's own sentence", async (code, status, message) => {
    const { deps, hub } = makeDeps();
    openStream(hub, () => ({ type: "error", code, message: "RUNTIME TEXT" }));
    const res = await handleVoice(req("voice", { body: { choice: "voice", noticeVersion: "v3" } }), deps);
    expect(res.status).toBe(status);
    const b = await body(res);
    expect(b.error!.message).toBe(message);
    expect(JSON.stringify(b)).not.toContain("RUNTIME TEXT");
  });

  it("no answer within the wait is 504 unconfirmed", async () => {
    const { deps, hub, timers } = makeDeps();
    const s = openStream(hub, () => null);
    const p = handleVoice(req("voice", { body: { mute: true } }), deps);
    await until(() => s.conn.sent.length === 1);
    timers.fire(2_000);
    const res = await p;
    expect(res.status).toBe(504);
    expect((await body(res)).error).toEqual({ code: "unconfirmed", message: "Your choice was not confirmed. Reload the page to see it." });
  });

  it("no cookie is 401, a cross-site request is 403, no open stream is 409; nothing is sent in any of them", async () => {
    const { deps, hub } = makeDeps();
    const s = openStream(hub, () => ({ type: "voice", state: "voice", muted: false }));
    expect((await handleVoice(req("voice", { cookie: null, body: { mute: true } }), deps)).status).toBe(401);
    expect((await handleVoice(req("voice", { body: { mute: true }, headers: { ...guarded, Origin: "https://evil.example" } }), deps)).status).toBe(403);
    expect((await handleVoice(req("voice", { body: { mute: true }, headers: { ...guarded, "Sec-Fetch-Site": "cross-site" } }), deps)).status).toBe(403);
    expect((await handleVoice(req("voice", { body: { mute: true }, headers: { Origin: ORIGIN, "Content-Type": "application/json" } }), deps)).status).toBe(403);
    expect(s.conn.sent).toEqual([]);
    const other = await handleVoice(req("voice", { cookie: sealed(cookie({ participantId: "p-2" })), body: { mute: true } }), deps);
    expect(other.status).toBe(409);
    expect((await body(other)).error!.code).toBe("no_stream");
    expect(s.conn.sent).toEqual([]);
  });
});

describe("POST /api/v1/voice/token", () => {
  it("answers token, url and expiresAt only, with no-store, for the cookie's own seat", async () => {
    const { deps, calls } = makeDeps();
    const res = await handleVoiceToken(req("voice/token"), deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const b = await body(res);
    expect(b.data).toEqual({ token: JWT, url: LIVEKIT, expiresAt: T0 + 600_000 });
    expect(calls).toEqual([{ sessionId: SID, roleId: "delivery_lead", participantId: "p-1" }]);
  });

  it("the role and the participant come from the cookie, never from the body", async () => {
    const { deps, calls } = makeDeps();
    const res = await handleVoiceToken(req("voice/token", { cookie: sealed(cookie({ roleId: "tech_lead", participantId: "p-9" })), body: { roleId: "delivery_lead", participantId: "p-1", sessionId: "s-other" } }), deps);
    expect(res.status).toBe(400);
    expect(calls).toEqual([]);
    const ok = await handleVoiceToken(req("voice/token", { cookie: sealed(cookie({ roleId: "tech_lead", participantId: "p-9" })), body: {} }), deps);
    expect(ok.status).toBe(200);
    expect(calls).toEqual([{ sessionId: SID, roleId: "tech_lead", participantId: "p-9" }]);
  });

  it("no cookie is 401 and a tampered cookie is 401 with the cookie cleared; nothing is called", async () => {
    const { deps, calls } = makeDeps();
    expect((await handleVoiceToken(req("voice/token", { cookie: null }), deps)).status).toBe(401);
    const bad = await handleVoiceToken(req("voice/token", { cookie: `${sealed()}x` }), deps);
    expect(bad.status).toBe(401);
    expect(bad.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(calls).toEqual([]);
  });

  it("token without the launcher or without LIVEKIT_URL is 503 voice_unavailable and calls nothing", async () => {
    const noLauncher = makeDeps({ launcher: false });
    const a = await handleVoiceToken(req("voice/token"), noLauncher.deps);
    expect(a.status).toBe(503);
    expect((await body(a)).error!.code).toBe("voice_unavailable");
    const noUrl = makeDeps({ livekitUrl: null });
    const b = await handleVoiceToken(req("voice/token"), noUrl.deps);
    expect(b.status).toBe(503);
    expect((await body(b)).error!.code).toBe("voice_unavailable");
    expect(noUrl.calls).toEqual([]);
  });

  it.each([
    ["voice_refused", 409, "voice_refused", "Voice is not available for your seat. Choose voice first, or use the text box."],
    ["voice_off", 409, "voice_off", "Voice is off for this session. Use the text box."],
    ["voice_unavailable", 503, "voice_unavailable", "Voice is not available right now. Use the text box."],
    ["unavailable", 503, "voice_unavailable", "Voice is not available right now. Use the text box."],
    ["timeout", 503, "voice_unavailable", "Voice is not available right now. Use the text box."],
    ["not_found", 503, "voice_unavailable", "Voice is not available right now. Use the text box."],
    ["failed", 503, "voice_unavailable", "Voice is not available right now. Use the text box."],
  ] as [LauncherReason, number, string, string][])("a launcher %s maps to %i %s with a fixed sentence", async (reason, status, code, message) => {
    const { deps } = makeDeps({ launcher: async () => { throw new LauncherError(reason, "CONTROL TEXT room v0123 identity delivery_lead.g01234567"); } });
    const res = await handleVoiceToken(req("voice/token"), deps);
    expect(res.status).toBe(status);
    const b = await body(res);
    expect(b.error).toEqual({ code, message });
    expect(JSON.stringify(b)).not.toMatch(/CONTROL TEXT|v0123|g01234567/);
  });

  it("an unexpected failure is 503 and only its error name is logged", async () => {
    const { deps } = makeDeps({ launcher: async () => { throw new TypeError(`boom ${JWT} room v0123`); } });
    const res = await handleVoiceToken(req("voice/token"), deps);
    expect(res.status).toBe(503);
    expect(logs.join("\n")).toContain("TypeError");
    expect(logs.join("\n")).not.toMatch(/boom|v0123|eyJ/);
  });

  it("the 21st token request in 60 s is 429 with Retry-After and does not reach control; another participant is not affected", async () => {
    const { deps, calls } = makeDeps();
    for (let i = 0; i < 20; i++) expect((await handleVoiceToken(req("voice/token"), deps)).status).toBe(200);
    const blocked = await handleVoiceToken(req("voice/token"), deps);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect((await body(blocked)).error!.code).toBe("rate_limited");
    expect(calls).toHaveLength(20);
    expect((await handleVoiceToken(req("voice/token", { cookie: sealed(cookie({ participantId: "p-2" })) }), deps)).status).toBe(200);
    clock += 120_000;
    expect((await handleVoiceToken(req("voice/token"), deps)).status).toBe(200);
  });

  it("a cross-site Origin is 403 before the throttle: it is neither charged nor answered 429", async () => {
    const { deps, calls } = makeDeps();
    const evil = { ...guarded, Origin: "https://evil.example" };
    for (let i = 0; i < 25; i++) expect((await handleVoiceToken(req("voice/token", { headers: evil }), deps)).status).toBe(403);
    expect((await handleVoiceToken(req("voice/token", { headers: { ...guarded, "Sec-Fetch-Site": "cross-site" } }), deps)).status).toBe(403);
    expect((await handleVoiceToken(req("voice/token", { headers: { Origin: ORIGIN } }), deps)).status).toBe(403);
    expect(calls).toEqual([]);
    expect((await handleVoiceToken(req("voice/token"), deps)).status).toBe(200);
  });

  it("nothing logged contains the token, and the token is only in the response body", async () => {
    const { deps } = makeDeps();
    const res = await handleVoiceToken(req("voice/token"), deps);
    for (const [, v] of res.headers) expect(v).not.toContain(JWT);
    expect(await res.text()).toContain(JWT);
    expect(logs.join("\n")).not.toContain(JWT);
  });
});
