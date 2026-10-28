import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { Config } from "../config";
import { setEnvelopeClock } from "../envelope";
import { COOKIE_NAME, handleConsent, handleJoin, handleLeave, handleSay, handleStream, SIGNED_OUT_MESSAGE, type Deps } from "../handlers";
import { RuntimeConnection } from "../runtime-connection";
import { seal, unseal } from "../seal";
import { StreamHub, type SessionCookie } from "../stream-hub";
import { JoinThrottle } from "../throttle";
import type { JoinedFrame } from "../wire";
import { asConn, FakeConn, fakeRuntime, manualTimers, sseReader, until } from "./fakes";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ORIGIN = "https://play.example.org";
const KEYS: Config["cookieKeys"] = [{ id: "k1", key: Buffer.alloc(32, 7) }];
const ADDR = "198.51.100.7";
const CODE = "ABCD-EFGH";
const CRED = "0123456789abcdef0123456789abcdef";
const T0 = 1_900_000_000_000;
const HOUR = 3_600_000;
const FIXED = new Date(T0);

let clock = T0;
let logId = "log-1";
type Script = (ws: WebSocket, m: any) => void;
let script: Script;
let rt: Awaited<ReturnType<typeof fakeRuntime>>;
let stops: (() => unknown)[] = [];

const send = (ws: WebSocket, m: unknown) => ws.send(JSON.stringify(m));
const refuse = (ws: WebSocket) => { send(ws, { type: "error", code: "unauthorized", message: "unauthorized" }); ws.close(1008, "unauthorized"); };
const state = (lastSeq: number, status = "lobby") => ({ lastSeq, status, paused: false, pausedSince: null, currentScene: null, transcript: [] }) as unknown as JoinedFrame["state"];
const joined = (o: Partial<JoinedFrame> = {}): JoinedFrame => ({
  type: "joined", roleId: "delivery_lead", brief: "Your brief", privateFacts: ["a fact"], reconnectToken: "RECONNECT-TOKEN-XYZ", state: state(5), scenes: [],
  logIdentity: logId, consent: { noticeVersion: "v1", notice: "n", given: false }, replay: { afterSeq: 0, toSeq: 5, events: 0, complete: true }, ...o,
});
/** The runtime's answers: the role's code (normalised like the runtime does) or the credential; anything else is refused. */
const defaultScript: Script = (ws, m) => {
  if (m.type !== "join") return;
  if (m.credential !== undefined) return m.credential === CRED ? send(ws, joined({ replay: { afterSeq: m.lastSeq ?? 0, toSeq: 5, events: 0, complete: true } })) : refuse(ws);
  const typed = String(m.joinCode ?? "").replace(/[\s-]/g, "").toUpperCase();
  if (m.roleId === "delivery_lead" && typed === "ABCDEFGH") return send(ws, joined({ credential: CRED, replay: { afterSeq: 0, toSeq: 5, events: 0, complete: true } }));
  refuse(ws);
};

function makeDeps(o: { hub?: Partial<ConstructorParameters<typeof StreamHub>[0]>; throttle?: Partial<ConstructorParameters<typeof JoinThrottle>[0]>; runtimeUrl?: string } = {}) {
  const timers = manualTimers();
  const hub = new StreamHub({ maxStreams: 10, maxStreamsPerSession: 10, maxStreamsPerAddress: 10, setTimer: timers.setTimer, now: () => clock, ...o.hub });
  const joinThrottle = new JoinThrottle({ max: 5, windowMs: 60_000, blockMs: 60_000, now: () => clock, ...o.throttle });
  const connect = vi.fn((url: string, address: string) => RuntimeConnection.connect(url, address));
  const config: Config = { runtimeUrl: o.runtimeUrl ?? rt.url, publicOrigin: ORIGIN, cookieKeys: KEYS, cookieMaxAgeHours: 12, maxStreams: 10, maxStreamsPerSession: 10, maxStreamsPerAddress: 10 };
  const deps: Deps = { config, now: () => clock, connect: connect as unknown as Deps["connect"], joinThrottle, hub };
  return { deps, timers, connect, hub, joinThrottle };
}

const guarded = { Origin: ORIGIN, "X-Requested-With": "scenecoach", "Content-Type": "application/json" };
const joinReq = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/api/v1/join`, { method: "POST", headers: { ...guarded, "X-Forwarded-For": ADDR, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const goodJoin = { sessionId: "s1", role: "delivery_lead", joinCode: "abcd - efgh", displayName: "Ann" };

const cookieValue = (o: Partial<SessionCookie> = {}, keys = KEYS) =>
  seal({ sessionId: "s1", roleId: "delivery_lead", participantId: "p-1", credential: CRED, logIdentity: "log-1", expiresAt: T0 + 12 * HOUR, ...o }, keys, clock);
const streamReq = (cookie: string | null, o: { session?: string; headers?: Record<string, string>; signal?: AbortSignal } = {}) =>
  new Request(`${ORIGIN}/api/v1/stream?session=${o.session ?? "s1"}`, {
    headers: { Accept: "text/event-stream", "Sec-Fetch-Site": "same-origin", "X-Forwarded-For": ADDR, ...(cookie === null ? {} : { Cookie: `other=1; ${COOKIE_NAME}=${cookie}` }), ...o.headers },
    signal: o.signal,
  });
const postReq = (path: string, cookie: string | null, body: unknown = {}, headers: Record<string, string> = guarded) =>
  new Request(`${ORIGIN}/api/v1/${path}`, { method: "POST", headers: { "X-Forwarded-For": ADDR, ...headers, ...(cookie === null ? {} : { Cookie: `${COOKIE_NAME}=${cookie}` }) }, body: typeof body === "string" ? body : JSON.stringify(body) });

/** The Set-Cookie for our cookie: its value and attributes. */
function setCookie(res: Response) {
  const raw = res.headers.get("Set-Cookie");
  if (raw === null) return null;
  const [pair, ...attrs] = raw.split(";").map((s) => s.trim());
  const at = pair!.indexOf("=");
  return { name: pair!.slice(0, at), value: pair!.slice(at + 1), attrs: attrs.map((a) => a.toLowerCase()), raw };
}
const isCleared = (res: Response) => { const c = setCookie(res); return c !== null && c.name === COOKIE_NAME && c.value === "" && c.attrs.includes("max-age=0"); };

beforeEach(async () => {
  clock = T0; logId = "log-1"; script = defaultScript;
  setEnvelopeClock(() => FIXED);
  rt = await fakeRuntime((ws, m) => script(ws, m));
  stops.push(() => rt.stop());
});
afterEach(async () => {
  setEnvelopeClock(() => new Date());
  for (const s of stops.reverse()) await s();
  stops = [];
});

/** Opens a stream through the handler and reads it like a browser. */
async function openStream(d: Deps, cookie = cookieValue(), o: Parameters<typeof streamReq>[1] = {}) {
  const res = await handleStream(streamReq(cookie, o), d);
  expect(res.headers.get("Content-Type")).toContain("text/event-stream");
  const r = sseReader(res);
  stops.push(() => r.cancel());
  await until(() => r.frames().some((f) => f.event === "joined"));
  return { res, r };
}

describe("POST /api/v1/join", () => {
  it("join with a right code sets a sealed HttpOnly Secure SameSite=Lax cookie and never returns the code or credential in the body", async () => {
    const { deps } = makeDeps();
    const res = await handleJoin(joinReq(goodJoin), deps);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(JSON.parse(body)).toMatchObject({ success: true, data: { sessionId: "s1", roleId: "delivery_lead" }, error: null });
    for (const secret of [CRED, "abcd", "ABCD", "RECONNECT-TOKEN"]) expect(body).not.toContain(secret);
    const c = setCookie(res)!;
    expect(c.name).toBe(COOKIE_NAME);
    expect(c.attrs).toEqual(expect.arrayContaining(["httponly", "secure", "samesite=lax", "path=/", `max-age=${12 * 3600}`]));
    const sealed = unseal<SessionCookie>(c.value, KEYS, clock)!;
    expect(sealed).toMatchObject({ sessionId: "s1", roleId: "delivery_lead", credential: CRED, logIdentity: "log-1", expiresAt: T0 + 12 * HOUR });
    expect(sealed.participantId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // The code goes to the runtime exactly as typed, with the address the proxy set; the connection is closed once the credential is issued.
    expect(rt.received[0]).toEqual({ type: "join", sessionId: "s1", roleId: "delivery_lead", participantId: sealed.participantId, joinCode: "abcd - efgh", displayName: "Ann", issueCredential: true, lastSeq: 0 });
    expect(rt.headers[0]!["x-forwarded-for"]).toBe(ADDR);
    await rt.closed(1);
  });

  it("every join refusal returns the same envelope and status", async () => {
    const answers: Record<string, Script> = {
      wrongCode: refuse,
      roleTaken: (ws) => send(ws, { type: "error", code: "role_taken", message: "role_taken" }),
      sessionEnded: (ws) => send(ws, { type: "error", code: "session_ended", message: "the session has ended" }),
      consentRequired: (ws) => { send(ws, { type: "error", code: "consent_required", message: "x" }); ws.close(1008, "unauthorized"); },
      unknownCode: (ws) => send(ws, { type: "error", code: "something_new", message: "x" }),
    };
    const texts = new Map<string, { status: number; text: string }>();
    for (const [name, answer] of Object.entries(answers)) {
      script = (ws, m) => { if (m.type === "join") answer(ws, m); };
      const { deps } = makeDeps();
      const res = await handleJoin(joinReq(goodJoin), deps);
      texts.set(name, { status: res.status, text: await res.text() });
      expect(res.headers.get("Set-Cookie"), name).toBeNull();
    }
    script = defaultScript;
    // Refused by the BFF before the runtime: malformed ids, an empty code, a blocked pair; and the runtime's own address block (429).
    for (const [name, body] of Object.entries({
      badRole: { ...goodJoin, role: "Delivery Lead!" }, longRole: { ...goodJoin, role: "a".repeat(129) }, badSession: { ...goodJoin, sessionId: "../x" },
      emptyCode: { ...goodJoin, joinCode: "" }, longCode: { ...goodJoin, joinCode: "A".repeat(65) },
    })) {
      const { deps, connect } = makeDeps();
      const res = await handleJoin(joinReq(body), deps);
      texts.set(name, { status: res.status, text: await res.text() });
      expect(connect, name).not.toHaveBeenCalled();
    }
    const blocked = makeDeps();
    for (let i = 0; i < 6; i++) blocked.joinThrottle.fail(ADDR, "delivery_lead");
    const b = await handleJoin(joinReq(goodJoin), blocked.deps);
    texts.set("blocked", { status: b.status, text: await b.text() });
    const busy = await fakeRuntime(() => {}, { status: 429 });
    stops.push(() => busy.stop());
    const r429 = await handleJoin(joinReq(goodJoin), makeDeps({ runtimeUrl: busy.url }).deps);
    texts.set("runtime429", { status: r429.status, text: await r429.text() });

    const first = texts.get("wrongCode")!;
    expect(first.status).toBe(401);
    expect(JSON.parse(first.text)).toMatchObject({ success: false, data: null, error: { code: "join_refused" } });
    for (const [name, t] of texts) expect(t, name).toEqual(first);
  });

  it("join is throttled per address and role before the runtime is contacted", async () => {
    const { deps, connect } = makeDeps();
    const wrong = { ...goodJoin, joinCode: "WRONG-CODE" };
    for (let i = 0; i < 6; i++) expect((await handleJoin(joinReq(wrong), deps)).status).toBe(401);
    expect(connect).toHaveBeenCalledTimes(6);
    // Blocked now: even the right code is refused without a runtime connection.
    expect((await handleJoin(joinReq(goodJoin), deps)).status).toBe(401);
    expect(connect).toHaveBeenCalledTimes(6);
    // Another address for that role, and another role from that address, still reach the runtime.
    expect((await handleJoin(joinReq(goodJoin, { "X-Forwarded-For": "203.0.113.5" }), deps)).status).toBe(200);
    await handleJoin(joinReq({ ...goodJoin, role: "tech_lead" }), deps);
    expect(connect).toHaveBeenCalledTimes(8);
    // The block expires.
    clock += 60_001;
    expect((await handleJoin(joinReq(goodJoin), deps)).status).toBe(200);
  });

  it("the throttle key uses the normalised address: IPv4-mapped and plain spellings share one budget, and the runtime gets the plain one", async () => {
    const { deps, joinThrottle } = makeDeps();
    const wrong = { ...goodJoin, joinCode: "WRONG-CODE" };
    for (let i = 0; i < 3; i++) await handleJoin(joinReq(wrong, { "X-Forwarded-For": `::ffff:${ADDR}` }), deps);
    for (let i = 0; i < 3; i++) await handleJoin(joinReq(wrong, { "X-Forwarded-For": "::FFFF:c633:6407" }), deps);
    expect(joinThrottle.blockedForMs(ADDR, "delivery_lead")).toBeGreaterThan(0);
    expect(rt.headers.map((h) => h["x-forwarded-for"])).toEqual(Array(6).fill(ADDR));
  });

  it("an empty or comma-separated X-Forwarded-For is untrusted: a neutral error, no runtime contact, no charge", async () => {
    for (const xff of ["", "6.6.6.6, 198.51.100.7", "not-an-address"]) {
      const { deps, connect, joinThrottle } = makeDeps();
      const spy = vi.spyOn(joinThrottle, "fail");
      const res = await handleJoin(joinReq(goodJoin, { "X-Forwarded-For": xff }), deps);
      expect(res.status, xff).toBe(400);
      expect((await res.json()).error.code).toBe("bad_request");
      expect(connect).not.toHaveBeenCalled();
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("only a real code refusal is charged: network, internal, name and runtime refusals other than unauthorized are not", async () => {
    const down = await fakeRuntime();
    const downUrl = down.url;
    await down.stop();
    const cases: [string, Script | null, string?][] = [
      ["unreachable", null, downUrl],
      ["internal", (ws) => send(ws, { type: "error", code: "internal", message: "internal error" })],
      ["bad name", (ws) => send(ws, { type: "error", code: "bad_message", message: "displayName: x" })],
      ["role taken", (ws) => send(ws, { type: "error", code: "role_taken", message: "role_taken" })],
      ["closed early", (ws) => ws.close(1011)],
    ];
    for (const [name, answer, url] of cases) {
      script = (ws, m) => { if (m.type === "join" && answer) answer(ws, m); };
      const { deps, joinThrottle } = makeDeps({ runtimeUrl: url });
      const spy = vi.spyOn(joinThrottle, "fail");
      for (let i = 0; i < 7; i++) await handleJoin(joinReq(goodJoin), deps);
      expect(spy, name).not.toHaveBeenCalled();
    }
    script = refuse;
    const { deps, joinThrottle } = makeDeps();
    const spy = vi.spyOn(joinThrottle, "fail");
    await handleJoin(joinReq(goodJoin), deps);
    expect(spy).toHaveBeenCalledWith(ADDR, "delivery_lead");
  });

  it("the runtime's own address block (429 at connect) is refused like a wrong code but never charged", async () => {
    const busy = await fakeRuntime(() => {}, { status: 429 });
    stops.push(() => busy.stop());
    const { deps, joinThrottle } = makeDeps({ runtimeUrl: busy.url });
    const spy = vi.spyOn(joinThrottle, "fail");
    for (let i = 0; i < 7; i++) {
      const res = await handleJoin(joinReq(goodJoin), deps);
      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe("join_refused");
    }
    expect(spy).not.toHaveBeenCalled();
    expect(joinThrottle.blockedForMs(ADDR, "delivery_lead")).toBe(0);
  });

  it("maps a runtime that cannot be reached, or fails, to 503 and a refused name to 400 bad_name", async () => {
    const down = await fakeRuntime();
    const downUrl = down.url;
    await down.stop();
    const r1 = await handleJoin(joinReq(goodJoin), makeDeps({ runtimeUrl: downUrl }).deps);
    expect(r1.status).toBe(503);
    expect((await r1.json()).error.code).toBe("unavailable");
    script = (ws) => send(ws, { type: "error", code: "bad_message", message: "displayName: 1 to 60 visible characters on one line" });
    const r2 = await handleJoin(joinReq(goodJoin), makeDeps().deps);
    expect(r2.status).toBe(400);
    const b2 = await r2.text();
    expect(JSON.parse(b2).error.code).toBe("bad_name");
    expect(b2).not.toContain("visible characters on one line"); // never the runtime's own text
  });

  it("a joined frame without a credential (a runtime that keeps no seats) is an internal error with no cookie", async () => {
    script = (ws) => send(ws, joined());
    const res = await handleJoin(joinReq(goodJoin), makeDeps().deps);
    expect(res.status).toBe(500);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    await rt.closed(1);
  });

  it("does not call fail while the pair is blocked or the table is saturated", async () => {
    // Two wrong codes in flight when the pair reaches its limit: the one that lands second must not charge a blocked pair.
    const a = makeDeps();
    for (let i = 0; i < 5; i++) a.joinThrottle.fail(ADDR, "delivery_lead");
    const spyA = vi.spyOn(a.joinThrottle, "fail");
    const wrong = { ...goodJoin, joinCode: "WRONG-CODE" };
    await Promise.all([handleJoin(joinReq(wrong), a.deps), handleJoin(joinReq(wrong), a.deps)]);
    expect(spyA).toHaveBeenCalledTimes(1);

    // A table full of blocks: an untracked pair reads blocked, is refused before the runtime and is not charged.
    const s = makeDeps({ throttle: { maxKeys: 1 } });
    for (let i = 0; i < 6; i++) s.joinThrottle.fail("203.0.113.1", "delivery_lead");
    s.joinThrottle.fail("203.0.113.2", "delivery_lead"); // no room left: saturated
    const spyS = vi.spyOn(s.joinThrottle, "fail");
    const res = await handleJoin(joinReq(goodJoin), s.deps);
    expect(res.status).toBe(401);
    expect(s.connect).not.toHaveBeenCalled();
    expect(spyS).not.toHaveBeenCalled();
  });

  it("validates the role before it becomes a throttle key: an oversize or odd role is refused, never tracked or charged", async () => {
    const { deps, joinThrottle, connect } = makeDeps();
    const spy = vi.spyOn(joinThrottle, "fail");
    for (const role of ["a".repeat(129), "x|y", "ROLE", "", "\u0000"]) await handleJoin(joinReq({ ...goodJoin, role }), deps);
    expect(connect).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
    expect(joinThrottle.size).toBe(0);
    // 128 characters of the scenario-id shape is still a role the runtime may be asked about.
    await handleJoin(joinReq({ ...goodJoin, role: "a".repeat(128) }), deps);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("refuses a bad display name with 400 bad_name before the runtime, and a body it cannot read with 400 bad_request", async () => {
    const { deps, connect } = makeDeps();
    for (const displayName of ["", "   ", "a".repeat(61), "two\nlines", "tab\there"]) {
      const res = await handleJoin(joinReq({ ...goodJoin, displayName }), deps);
      expect(res.status, JSON.stringify(displayName)).toBe(400);
      expect((await res.json()).error.code).toBe("bad_name");
    }
    for (const body of ["not json", "[]", "null", JSON.stringify({ ...goodJoin, joinCode: 5 }), JSON.stringify({ sessionId: "s1" }), "x".repeat(20_000)]) {
      const res = await handleJoin(joinReq(body), deps);
      expect(res.status, body.slice(0, 20)).toBe(400);
      expect((await res.json()).error.code).toBe("bad_request");
    }
    expect(connect).not.toHaveBeenCalled();
    // 60 code points (not UTF-16 units) is fine.
    expect((await handleJoin(joinReq({ ...goodJoin, displayName: "\u{1F600}".repeat(60) }), deps)).status).toBe(200);
  });

  it("join rejects a missing Origin, another Origin, a missing custom header and a cross-site fetch", async () => {
    const { deps, connect } = makeDeps();
    const variants: Record<string, string>[] = [
      { "X-Requested-With": "scenecoach" }, { Origin: "https://evil.example", "X-Requested-With": "scenecoach" }, { Origin: ORIGIN },
      { ...guarded, "Sec-Fetch-Site": "cross-site" },
    ];
    for (const h of variants) {
      const req = new Request(`${ORIGIN}/api/v1/join`, { method: "POST", headers: { "X-Forwarded-For": ADDR, "Content-Type": "application/json", ...h }, body: JSON.stringify(goodJoin) });
      const res = await handleJoin(req, deps);
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("forbidden");
    }
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/stream", () => {
  it("stream without a cookie, with a tampered cookie, with an expired cookie and with another session's cookie is 401 with the neutral envelope", async () => {
    const { deps, connect } = makeDeps();
    const good = cookieValue();
    const tampered = good.slice(0, -3) + (good.endsWith("AAA") ? "BBB" : "AAA");
    const otherKey = cookieValue({}, [{ id: "k1", key: Buffer.alloc(32, 9) }]);
    const shortLived = cookieValue({ expiresAt: T0 + 1_000 });
    const results: { name: string; res: Response }[] = [];
    results.push({ name: "none", res: await handleStream(streamReq(null), deps) });
    results.push({ name: "tampered", res: await handleStream(streamReq(tampered), deps) });
    results.push({ name: "other key", res: await handleStream(streamReq(otherKey), deps) });
    results.push({ name: "other session", res: await handleStream(streamReq(good, { session: "s2" }), deps) });
    results.push({ name: "no session param", res: await handleStream(new Request(`${ORIGIN}/api/v1/stream`, { headers: { Accept: "text/event-stream", Cookie: `${COOKIE_NAME}=${good}`, "X-Forwarded-For": ADDR } }), deps) });
    clock += 2_000;
    results.push({ name: "expired", res: await handleStream(streamReq(shortLived), deps) });
    const first = await results[0]!.res.clone().text();
    expect(JSON.parse(first)).toMatchObject({ success: false, error: { code: "unauthorized" } });
    for (const { name, res } of results) {
      expect(res.status, name).toBe(401);
      expect(await res.text(), name).toBe(first);
      expect(res.headers.get("X-Robots-Tag"), name).toBe("noindex, nofollow");
    }
    // A cookie that cannot be opened is cleared; another session's (valid) cookie is left alone.
    for (const { name, res } of results) expect(isCleared(res), name).toBe(["tampered", "other key", "expired"].includes(name));
    expect(connect).not.toHaveBeenCalled();
  });

  it("stream rejects Sec-Fetch-Site cross-site and a foreign Origin", async () => {
    const { deps, connect } = makeDeps();
    for (const headers of [{ "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "same-site" }, { Origin: "https://evil.example" }] as Record<string, string>[]) {
      const res = await handleStream(streamReq(cookieValue(), { headers }), deps);
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("forbidden");
    }
    expect(connect).not.toHaveBeenCalled();
    const res = await handleStream(streamReq(cookieValue(), { headers: { Origin: ORIGIN } }), deps);
    expect(res.status).toBe(200);
    await res.body!.cancel();
  });

  it("a stream request that does not accept text/event-stream (a top-level navigation) is 406 and contacts nothing", async () => {
    const { deps, connect } = makeDeps();
    for (const accept of [null, "text/html,application/xhtml+xml,*/*;q=0.8", "*/*", "application/json"]) {
      const req = streamReq(cookieValue());
      const headers = new Headers(req.headers);
      if (accept === null) headers.delete("Accept"); else headers.set("Accept", accept);
      const res = await handleStream(new Request(req.url, { headers }), deps);
      expect(res.status, String(accept)).toBe(406);
      expect((await res.json()).error.code).toBe("not_acceptable");
    }
    expect(connect).not.toHaveBeenCalled();
    expect(rt.received).toHaveLength(0);
  });

  it("an untrusted X-Forwarded-For on the stream is a neutral 400", async () => {
    const { deps, connect } = makeDeps();
    const res = await handleStream(streamReq(cookieValue(), { headers: { "X-Forwarded-For": "1.1.1.1, 2.2.2.2" } }), deps);
    expect(res.status).toBe(400);
    expect(connect).not.toHaveBeenCalled();
  });

  it("the SSE response sends retry: first, honours Last-Event-ID, and is not cached, transformed or indexed", async () => {
    const { deps } = makeDeps();
    const { res, r } = await openStream(deps, cookieValue(), { headers: { "Last-Event-ID": "42" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(res.headers.get("Cache-Control")).toContain("no-transform");
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(r.frames()[0]!.event).toBe("retry:3000");
    expect(rt.received[0]).toEqual({ type: "join", sessionId: "s1", roleId: "delivery_lead", participantId: "p-1", credential: CRED, lastSeq: 42 });
    expect(rt.headers[0]!["x-forwarded-for"]).toBe(ADDR);
    expect(r.text()).not.toContain(CRED);
    expect(r.text()).not.toContain("RECONNECT-TOKEN");
    // A malformed Last-Event-ID resumes from 0.
    for (const id of ["abc", "-1", "1e3", "9007199254740993", "7 7"]) {
      const { deps: d } = makeDeps();
      const n = rt.received.length;
      await openStream(d, cookieValue(), { headers: { "Last-Event-ID": id } });
      expect(rt.received[n]!.lastSeq, id).toBe(0);
    }
  });

  it("a cookie for a session whose log identity changed gets a reset and a reissued cookie, so the next reconnect does not reset again", async () => {
    logId = "log-2";
    const { deps } = makeDeps();
    clock += HOUR;
    const { res, r } = await openStream(deps, cookieValue({ logIdentity: "log-1" }));
    expect(r.frames().some((f) => f.event === "reset")).toBe(true);
    const c = setCookie(res)!;
    expect(c.name).toBe(COOKIE_NAME);
    expect(c.attrs).toEqual(expect.arrayContaining(["httponly", "secure", "samesite=lax", "path=/", `max-age=${11 * 3600}`]));
    const again = unseal<SessionCookie>(c.value, KEYS, clock)!;
    expect(again).toEqual({ sessionId: "s1", roleId: "delivery_lead", participantId: "p-1", credential: CRED, logIdentity: "log-2", expiresAt: T0 + 12 * HOUR });
    const second = await openStream(makeDeps().deps, c.value);
    expect(second.r.frames().some((f) => f.event === "reset")).toBe(false);
    expect(second.res.headers.get("Set-Cookie")).toBeNull();
  });

  it("a revoked credential gets signed_out and a cleared cookie, with the message 'ask your facilitator for a new code'", async () => {
    script = (ws, m) => { if (m.type === "join") refuse(ws); };
    const { deps } = makeDeps();
    const res = await handleStream(streamReq(cookieValue()), deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(isCleared(res)).toBe(true);
    const r = sseReader(res);
    await r.finished;
    expect(r.frames()).toEqual([{ event: "retry:3000" }, { event: "signed_out", data: { message: SIGNED_OUT_MESSAGE } }]);
    expect(SIGNED_OUT_MESSAGE).toBe("ask your facilitator for a new code");
  });

  it("a runtime that cannot be reached tells the browser to reconnect (keeping its Last-Event-ID); a 4001 during the join is superseded", async () => {
    const down = await fakeRuntime();
    const downUrl = down.url;
    await down.stop();
    const r1 = await handleStream(streamReq(cookieValue()), makeDeps({ runtimeUrl: downUrl }).deps);
    const a = sseReader(r1);
    await a.finished;
    expect(a.frames()).toEqual([{ event: "retry:3000" }, { event: "reconnecting", data: {} }]);
    expect(r1.headers.get("Set-Cookie")).toBeNull();
    script = (ws) => ws.close(4001, "superseded");
    const r2 = await handleStream(streamReq(cookieValue()), makeDeps().deps);
    const b = sseReader(r2);
    await b.finished;
    expect(b.frames().at(-1)).toEqual({ event: "superseded", data: {} });
    script = (ws) => send(ws, { type: "error", code: "internal", message: "x" });
    const r3 = await handleStream(streamReq(cookieValue()), makeDeps().deps);
    const c = sseReader(r3);
    await c.finished;
    expect(c.frames().at(-1)).toEqual({ event: "reconnecting", data: {} });
  });

  describe("session.ended clears the cookie", () => {
    it("when the runtime answers session_ended", async () => {
      script = (ws) => send(ws, { type: "error", code: "session_ended", message: "the session has ended" });
      const res = await handleStream(streamReq(cookieValue()), makeDeps().deps);
      expect(isCleared(res)).toBe(true);
      const r = sseReader(res);
      await r.finished;
      expect(r.frames().at(-1)).toEqual({ event: "ended", data: {} });
    });

    it("when the snapshot already says ended", async () => {
      script = (ws, m) => { if (m.type === "join") send(ws, joined({ state: state(9, "ended") })); };
      const { res } = await openStream(makeDeps().deps);
      expect(isCleared(res)).toBe(true);
    });

    it("after a stream forwarded session.ended, the next request (refused: the end revoked every credential) gets ended and a cleared cookie", async () => {
      let sock: WebSocket | null = null;
      script = (ws, m) => { if (m.type === "join") { sock = ws; defaultScript(ws, m); } };
      const { deps } = makeDeps();
      const { r } = await openStream(deps);
      send(sock!, { type: "event", event: { seq: 6, ts: 6, type: "session.ended" } });
      await r.finished;
      expect(r.frames().at(-1)).toEqual({ event: "ended", data: {} });
      script = (ws, m) => { if (m.type === "join") refuse(ws); };
      const res = await handleStream(streamReq(cookieValue()), deps);
      expect(isCleared(res)).toBe(true);
      const again = sseReader(res);
      await again.finished;
      expect(again.frames().at(-1)).toEqual({ event: "ended", data: {} });
      // A refusal for another session (or another log of it) is still signed_out.
      const other = await handleStream(streamReq(cookieValue({ logIdentity: "log-other" })), deps);
      const o = sseReader(other);
      await o.finished;
      expect(o.frames().at(-1)!.event).toBe("signed_out");
    });
  });

  it("after a log-identity reset reissued the cookie and the session then ended, a reload with the reissued cookie gets ended, not signed_out", async () => {
    logId = "log-2";
    let sock: WebSocket | null = null;
    script = (ws, m) => { if (m.type === "join") { sock = ws; defaultScript(ws, m); } };
    const { deps } = makeDeps();
    const { res, r } = await openStream(deps, cookieValue({ logIdentity: "log-1" }));
    const reissued = setCookie(res)!.value;
    expect(unseal<SessionCookie>(reissued, KEYS, clock)!.logIdentity).toBe("log-2");
    send(sock!, { type: "event", event: { seq: 6, ts: 6, type: "session.ended" } });
    await r.finished;
    expect(r.frames().at(-1)).toEqual({ event: "ended", data: {} });
    script = (ws, m) => { if (m.type === "join") refuse(ws); };
    const reload = await handleStream(streamReq(reissued), deps);
    expect(isCleared(reload)).toBe(true);
    const again = sseReader(reload);
    await again.finished;
    expect(again.frames().at(-1)).toEqual({ event: "ended", data: {} });
  });

  it("the stream cap returns 503 and never contacts the runtime", async () => {
    const { deps, connect } = makeDeps({ hub: { maxStreams: 1 } });
    await openStream(deps);
    const res = await handleStream(streamReq(cookieValue({ participantId: "p-2" })), deps);
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("busy");
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("when open itself returns capacity (a race past the pre-check) the answer is 503 and that connection is closed, not reused", async () => {
    const { deps, connect } = makeDeps({ hub: { maxStreams: 1 } });
    const [a, b] = await Promise.all([handleStream(streamReq(cookieValue({ participantId: "p-a" })), deps), handleStream(streamReq(cookieValue({ participantId: "p-b" })), deps)]);
    expect(connect).toHaveBeenCalledTimes(2);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 503]);
    const loser = a.status === 503 ? a : b;
    const winner = a.status === 200 ? a : b;
    expect((await loser.json()).error.code).toBe("busy");
    await rt.closed(1);
    expect(rt.closes).toHaveLength(1);
    const r = sseReader(winner);
    stops.push(() => r.cancel());
    expect(r.done()).toBe(false);
  });

  it("closes the runtime socket when the request is aborted after the stream opened", async () => {
    const { deps } = makeDeps();
    const ac = new AbortController();
    await openStream(deps, cookieValue(), { signal: ac.signal });
    expect(rt.closes).toHaveLength(0);
    ac.abort();
    await rt.closed(1);
  });

  it("closes the runtime socket when the browser cancels the body", async () => {
    const { deps } = makeDeps();
    const { r } = await openStream(deps);
    await r.cancel();
    await rt.closed(1);
  });

  it("an abort while the runtime join is in flight closes that socket and opens no stream", async () => {
    const ac = new AbortController();
    script = (ws, m) => { if (m.type === "join") { ac.abort(); defaultScript(ws, m); } };
    const { deps, hub } = makeDeps();
    await handleStream(streamReq(cookieValue(), { signal: ac.signal }), deps);
    await rt.closed(1);
    await expect(hub.send({ sessionId: "s1", roleId: "delivery_lead", participantId: "p-1", credential: CRED, logIdentity: "log-1", expiresAt: T0 + HOUR }, { type: "leave" })).rejects.toMatchObject({ code: "no_stream" });
  });

  it("a throw between the join and hub.open (the reissued cookie cannot be sealed; open itself fails) closes that runtime socket and answers 500", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    // Sealing the reissued cookie: the clock passes the cookie's expiry after the expiry re-check (unseal, re-check, seal).
    logId = "log-2";
    const a = makeDeps();
    let calls = 0;
    a.deps.now = () => (++calls <= 2 ? clock : clock + 13 * HOUR);
    const r1 = await handleStream(streamReq(cookieValue({ logIdentity: "log-1" })), a.deps);
    expect(r1.status).toBe(500);
    expect(r1.headers.get("Set-Cookie")).toBeNull();
    await rt.closed(1);
    // hub.open throws.
    logId = "log-1";
    const b = makeDeps();
    vi.spyOn(b.hub, "open").mockImplementation(() => { throw new Error("open failed"); });
    const r2 = await handleStream(streamReq(cookieValue()), b.deps);
    expect(r2.status).toBe(500);
    await rt.closed(2);
    expect(log.mock.calls.map((c) => String(c[0]))).toEqual(["web: stream failed: Error", "web: stream failed: Error"]);
    log.mockRestore();
  });

  it("checks the cookie's expiry again once the join is done: a cookie that expired meanwhile is refused and its socket closed", async () => {
    script = (ws, m) => { if (m.type === "join") { clock += 13 * HOUR; defaultScript(ws, m); } };
    const res = await handleStream(streamReq(cookieValue()), makeDeps().deps);
    expect(res.status).toBe(401);
    expect(isCleared(res)).toBe(true);
    await rt.closed(1);
  });

  it("out.write reports backpressure so the hub's stall cap ends a stream nobody reads", async () => {
    let sock: WebSocket | null = null;
    script = (ws, m) => { if (m.type === "join") { sock = ws; defaultScript(ws, m); } };
    const { deps } = makeDeps({ hub: { maxPendingBytes: 4 * 1024 } });
    const res = await handleStream(streamReq(cookieValue()), deps);
    expect(res.status).toBe(200);
    await until(() => sock !== null);
    // Nobody reads the body: the hub must notice and drop the stream (its runtime socket closes).
    for (let i = 0; i < 40; i++) send(sock!, { type: "event", event: { seq: 6 + i, ts: 1, type: "utterance", roleId: "tech_lead", text: "x".repeat(4096), channel: "room" } });
    await rt.closed(1);
    const r = sseReader(res);
    await r.finished;
    expect(r.frames().at(-1)).toEqual({ event: "reconnecting", data: {} });
  });

  it("a waiting stream that ends with a bare superseded or reconnecting (no joined first) ends the response cleanly", async () => {
    for (const [code, event] of [[4001, "superseded"], [1006, "reconnecting"]] as const) {
      const conn = new (class extends FakeConn { joinWithCredential = async () => joined(); })();
      conn.closing = true; // its close frame arrived with the joined; the close event has not fired yet
      const { deps } = makeDeps();
      deps.connect = (async () => asConn(conn)) as unknown as Deps["connect"];
      const res = await handleStream(streamReq(cookieValue()), deps);
      expect(res.status).toBe(200);
      const r = sseReader(res);
      conn.drop(code);
      await r.finished;
      expect(r.frames().map((f) => f.event).filter((e) => e !== "retry:3000")).toEqual([event]);
    }
  });
});

describe("POST /api/v1/say, /consent and /leave", () => {
  const routes = { say: handleSay, consent: handleConsent, leave: handleLeave } as const;
  const bodies = { say: { text: "Hello." }, consent: { noticeVersion: "v1" }, leave: {} } as const;

  it("say, consent and leave reject a missing Origin or custom header", async () => {
    const { deps } = makeDeps();
    await openStream(deps);
    for (const [name, h] of Object.entries(routes)) {
      for (const headers of [{ "X-Requested-With": "scenecoach" }, { Origin: ORIGIN }, { Origin: "https://evil.example", "X-Requested-With": "scenecoach" }, { ...guarded, "Sec-Fetch-Site": "cross-site" }] as Record<string, string>[]) {
        const res = await h(postReq(name, cookieValue(), bodies[name as keyof typeof bodies], headers), deps);
        expect(res.status, name).toBe(403);
      }
    }
    expect(rt.received.map((m) => m.type)).toEqual(["join"]);
  });

  it("without a stream they answer 409 no_stream; without a valid cookie 401", async () => {
    const { deps } = makeDeps();
    for (const [name, h] of Object.entries(routes)) {
      const res = await h(postReq(name, cookieValue(), bodies[name as keyof typeof bodies]), deps);
      expect(res.status, name).toBe(409);
      expect((await res.json()).error.code).toBe("no_stream");
      const anon = await h(postReq(name, null, bodies[name as keyof typeof bodies]), deps);
      expect(anon.status, name).toBe(401);
      const bad = await h(postReq(name, "k1.junk", bodies[name as keyof typeof bodies]), deps);
      expect(bad.status, name).toBe(401);
      expect(isCleared(bad)).toBe(true);
    }
  });

  async function sent(timers: ReturnType<typeof manualTimers>, p: Promise<Response>) {
    // The runtime acks nothing: the hub waits a bounded time for an error, then reports success.
    await until(() => timers.live().some((t) => t.ms === 300));
    timers.fire(300);
    return p;
  }

  it("say goes over the stream's own connection and answers ok", async () => {
    const { deps, timers } = makeDeps();
    await openStream(deps);
    const res = await sent(timers, handleSay(postReq("say", cookieValue(), { text: "Hello there.", expectSceneId: "s1_intro" }), deps));
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(rt.received.at(-1)).toEqual({ type: "say", text: "Hello there.", expectSceneId: "s1_intro" });
    expect(rt.sockets).toHaveLength(1);
  });

  it("a runtime error maps to a fixed message and status, never the runtime's own text", async () => {
    let sock: WebSocket | null = null;
    script = (ws, m) => {
      if (m.type === "join") { sock = ws; return defaultScript(ws, m); }
      if (m.type === "say") send(ws, { type: "error", code: m.text === "fast" ? "rate_limited" : "stale_scene", message: "SECRET-RUNTIME-TEXT" });
    };
    const { deps } = makeDeps();
    await openStream(deps);
    const res = await handleSay(postReq("say", cookieValue(), { text: "late" }), deps);
    expect(res.status).toBe(409);
    const body = await res.text();
    expect(JSON.parse(body).error.code).toBe("stale_scene");
    expect(body).not.toContain("SECRET-RUNTIME-TEXT");
    const fast = await handleSay(postReq("say", cookieValue(), { text: "fast" }), deps);
    expect(fast.status).toBe(429);
    expect(sock).not.toBeNull();
  });

  it("say and consent refuse a body they cannot use with 400 and send nothing", async () => {
    const { deps } = makeDeps();
    await openStream(deps);
    for (const body of ["nope", "[]", { text: "" }, { text: 5 }, { text: "x".repeat(2001) }, { text: "ok", expectSceneId: 3 }, { text: "ok", expectSceneId: "x".repeat(129) }]) {
      expect((await handleSay(postReq("say", cookieValue(), body), deps)).status, JSON.stringify(body).slice(0, 30)).toBe(400);
    }
    for (const body of [{}, { noticeVersion: "" }, { noticeVersion: "v 1" }, { noticeVersion: "v".repeat(33) }, { withdraw: "yes" }]) {
      expect((await handleConsent(postReq("consent", cookieValue(), body), deps)).status, JSON.stringify(body)).toBe(400);
    }
    expect(rt.received.map((m) => m.type)).toEqual(["join"]);
  });

  it("consent gives consent; withdrawing and leaving also clear the cookie (the runtime revoked the credential)", async () => {
    const { deps, timers } = makeDeps();
    await openStream(deps);
    const c = await sent(timers, handleConsent(postReq("consent", cookieValue(), { noticeVersion: "v1" }), deps));
    expect(c.status).toBe(200);
    expect(c.headers.get("Set-Cookie")).toBeNull();
    expect(rt.received.at(-1)).toEqual({ type: "consent", noticeVersion: "v1" });
    const w = await sent(timers, handleConsent(postReq("consent", cookieValue(), { withdraw: true }), deps));
    expect(w.status).toBe(200);
    expect(rt.received.at(-1)).toEqual({ type: "withdraw_consent" });
    expect(isCleared(w)).toBe(true);
    const l = await sent(timers, handleLeave(postReq("leave", cookieValue(), ""), deps));
    expect(l.status).toBe(200);
    expect(rt.received.at(-1)).toEqual({ type: "leave" });
    expect(isCleared(l)).toBe(true);
  });

  it("a refused leave keeps the cookie", async () => {
    script = (ws, m) => { if (m.type === "join") return defaultScript(ws, m); if (m.type === "leave") send(ws, { type: "error", code: "already_started", message: "x" }); };
    const { deps } = makeDeps();
    await openStream(deps);
    const res = await handleLeave(postReq("leave", cookieValue()), deps);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("already_started");
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("an unexpected failure is a 500 envelope without a cookie", async () => {
    const { deps } = makeDeps();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    deps.hub = { send: () => Promise.reject(new Error("boom")) } as unknown as StreamHub;
    for (const [name, h] of Object.entries(routes)) {
      const res = await h(postReq(name, cookieValue(), bodies[name as keyof typeof bodies]), deps);
      expect(res.status, name).toBe(500);
      expect(res.headers.get("Set-Cookie")).toBeNull();
      expect(await res.text()).not.toContain("boom");
    }
    // Logged by name only: an error message could carry anything.
    expect(log.mock.calls.map((c) => String(c[0]))).toEqual(["web: say failed: Error", "web: consent failed: Error", "web: leave failed: Error"]);
    log.mockRestore();
  });
});
