import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import type { Config } from "../config";
import { COOKIE_NAME, handleConsent, handleJoin, handleLeave, handleSay, handleStream, SIGNED_OUT_MESSAGE, type Deps } from "../handlers";
import { RuntimeConnection, realTimer } from "../runtime-connection";
import { seal, unseal } from "../seal";
import { StreamHub, type SessionCookie } from "../stream-hub";
import { JoinThrottle } from "../throttle";
import { sseReader, until } from "./fakes";

// The handlers against the real runtime, in-process, mock models, port 0, private temp dirs. Generous limits; nothing measures elapsed time.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

// Loaded by a computed path (see hub.runtime.test.ts): a static import would type-check the runtime's sources under this app's settings.
const MAIN = fileURLToPath(new URL("../../../../../services/runtime/src/main.ts", import.meta.url));
if (!existsSync(MAIN)) throw new Error(`handlers.runtime.test.ts needs the runtime's entry point at ${MAIN}; it moved: update MAIN`);
const SCENARIO = fileURLToPath(new URL("../../../../../scenarios/friday-escalation", import.meta.url));
type Host = { assignments: Record<string, string>; idle(): Promise<void>; consentGiven(roleId: string, participantId: string): boolean };
type Bootstrap = (o: { env: Record<string, string>; root: string; logDir: string; tickMs: number; log: (m: string) => void; warn: (m: string) => void; showJoinCodes: (c: { roleId: string; code: string }[]) => void }) =>
  Promise<{ ok: true; runtime: { port: number; host: Host; stop(): Promise<void> } } | { ok: false; errors: string[] }>;

const SESSION = "web-routes";
const ORIGIN = "https://play.example.org";
const KEYS: Config["cookieKeys"] = [{ id: "k1", key: Buffer.alloc(32, 5) }];
const PLAYERS = ["delivery_lead", "tech_lead", "account_manager"] as const;
type Player = (typeof PLAYERS)[number];
const ADDRESS: Record<Player, string> = { delivery_lead: "198.51.100.21", tech_lead: "198.51.100.22", account_manager: "198.51.100.23" };
const typed = (code: string) => code.replace(/-/g, "").toLowerCase().replace(/(.{4})(?=.)/g, "$1 - ");

let tmp = "";
let runtime: { port: number; host: Host; stop(): Promise<void> } | null = null;
let codes: Record<string, string> = {};
let closers: (() => unknown)[] = [];

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "acr-web-routes-"));
  const { bootstrap } = (await import(MAIN)) as { bootstrap: Bootstrap };
  codes = {};
  const r = await bootstrap({
    env: { SCENARIO_DIR: SCENARIO, RUNTIME_PORT: "0", RUNTIME_HOST: "127.0.0.1", SESSION_ID: SESSION, MODEL_PROVIDER: "mock", TRUST_PROXY: "1" },
    root: tmp, logDir: tmp, tickMs: 60_000, log: () => {}, warn: () => {},
    showJoinCodes: (c) => { for (const x of c) codes[x.roleId] = x.code; },
  });
  if (!r.ok) throw new Error(r.errors.join("; "));
  runtime = r.runtime;
});
afterEach(async () => {
  for (const c of closers.reverse()) await c();
  closers = [];
  await runtime?.stop(); runtime = null;
  await rm(tmp, { recursive: true, force: true });
});

function makeDeps(o: { maxStreams?: number } = {}) {
  const config: Config = { runtimeUrl: `ws://127.0.0.1:${runtime!.port}`, publicOrigin: ORIGIN, cookieKeys: KEYS, cookieMaxAgeHours: 12, maxStreams: 10, maxStreamsPerSession: 10, maxStreamsPerAddress: 10 };
  const connect = vi.fn((url: string, address: string) => RuntimeConnection.connect(url, address));
  const hub = new StreamHub({ maxStreams: o.maxStreams ?? 10, maxStreamsPerSession: 10, maxStreamsPerAddress: 10, setTimer: realTimer, now: Date.now });
  const deps: Deps = { config, now: Date.now, connect: connect as unknown as Deps["connect"], joinThrottle: new JoinThrottle({ max: 5, windowMs: 60_000, blockMs: 60_000, now: Date.now }), hub };
  return { deps, connect };
}

const guarded = { Origin: ORIGIN, "X-Requested-With": "scenecoach", "Content-Type": "application/json" };
const cookieOf = (res: Response) => {
  const raw = res.headers.get("Set-Cookie") ?? "";
  const m = new RegExp(`^${COOKIE_NAME.replace(/[-]/g, "\\-")}=([^;]*)`).exec(raw);
  return m ? m[1]! : null;
};
async function join(d: Deps, role: Player, code = typed(codes[role]!), address = ADDRESS[role]) {
  const res = await handleJoin(new Request(`${ORIGIN}/api/v1/join`, { method: "POST", headers: { ...guarded, "X-Forwarded-For": address }, body: JSON.stringify({ sessionId: SESSION, role, joinCode: code, displayName: `Name ${role}` }) }), d);
  return { res, cookie: cookieOf(res) };
}
async function stream(d: Deps, cookie: string, role: Player, o: { lastEventId?: string; signal?: AbortSignal } = {}) {
  const res = await handleStream(new Request(`${ORIGIN}/api/v1/stream?session=${SESSION}`, {
    headers: { Accept: "text/event-stream", Cookie: `${COOKIE_NAME}=${cookie}`, "Sec-Fetch-Site": "same-origin", "X-Forwarded-For": ADDRESS[role], ...(o.lastEventId ? { "Last-Event-ID": o.lastEventId } : {}) },
    signal: o.signal,
  }), d);
  const r = sseReader(res);
  closers.push(() => r.cancel());
  return { res, r };
}
const post = (d: Deps, h: typeof handleSay, name: string, cookie: string, role: Player, body: unknown) =>
  h(new Request(`${ORIGIN}/api/v1/${name}`, { method: "POST", headers: { ...guarded, "X-Forwarded-For": ADDRESS[role], Cookie: `${COOKIE_NAME}=${cookie}` }, body: JSON.stringify(body) }), d);
async function facilitator() {
  const ws = new WebSocket(`ws://127.0.0.1:${runtime!.port}`);
  const inbox: any[] = [];
  ws.on("message", (b) => inbox.push(JSON.parse(b.toString())));
  await new Promise<void>((r, j) => { ws.on("open", () => r()); ws.on("error", j); });
  closers.push(() => ws.terminate());
  ws.send(JSON.stringify({ type: "join_facilitator", sessionId: SESSION }));
  await until(() => inbox.some((m) => m.type === "joined"));
  return { inbox, send: (m: unknown) => ws.send(JSON.stringify(m)) };
}

describe("the v1 handlers against the real runtime", () => {
  it("three players join, open their streams, consent through the routes; the facilitator starts; say reaches everyone; the end clears the cookie", async () => {
    const { deps } = makeDeps();
    const fac = await facilitator();
    const seats = {} as Record<Player, { cookie: string; r: ReturnType<typeof sseReader> }>;
    for (const role of PLAYERS) {
      const j = await join(deps, role);
      expect(j.res.status).toBe(200);
      const body = await j.res.text();
      expect(body).not.toContain(codes[role]!);
      const sealed = unseal<SessionCookie>(j.cookie!, KEYS, Date.now())!;
      expect(body).not.toContain(sealed.credential);
      const s = await stream(deps, j.cookie!, role);
      expect(s.res.status).toBe(200);
      await until(() => s.r.frames().some((f) => f.event === "joined"));
      const notice = s.r.frames().find((f) => f.event === "joined")!.data.consent.noticeVersion as string;
      expect((await post(deps, handleConsent, "consent", j.cookie!, role, { noticeVersion: notice })).status).toBe(200);
      expect(runtime!.host.consentGiven(role, sealed.participantId)).toBe(true);
      seats[role] = { cookie: j.cookie!, r: s.r };
    }
    fac.send({ type: "start" });
    await until(() => seats.delivery_lead.r.events().some((e) => e.type === "inject.fired"));
    await runtime!.host.idle();
    expect((await post(deps, handleSay, "say", seats.tech_lead.cookie, "tech_lead", { text: "Said through the route." })).status).toBe(200);
    for (const role of PLAYERS) await until(() => seats[role].r.events().some((e) => e.type === "utterance" && e.text === "Said through the route."));
    for (const secret of [...Object.values(codes), ...PLAYERS.map((r) => unseal<SessionCookie>(seats[r].cookie, KEYS, Date.now())!.credential)]) {
      for (const role of PLAYERS) expect(seats[role].r.text()).not.toContain(secret);
    }
    // Advance to the end: every stream ends with `ended`; a reload then gets `ended` again and a cleared cookie (not "ask for a new code").
    for (let i = 0; i < 3; i++) { await runtime!.host.idle(); fac.send({ type: "command", command: { command: "advance" } }); await until(() => fac.inbox.filter((m) => m.type === "event" && (m.event.type === "scene.entered" || m.event.type === "session.ended")).length > i + 1); }
    for (const role of PLAYERS) { await seats[role].r.finished; expect(seats[role].r.frames().at(-1)!.event).toBe("ended"); }
    const reload = await stream(deps, seats.delivery_lead.cookie, "delivery_lead");
    await reload.r.finished;
    expect(reload.r.frames().at(-1)!.event).toBe("ended");
    expect(reload.res.headers.get("Set-Cookie")).toMatch(new RegExp(`^${COOKIE_NAME}=;.*Max-Age=0`, "i"));
  });

  it("every join refusal is the same; six wrong codes block that role from that address before the runtime is contacted, not a colleague's", async () => {
    const { deps, connect } = makeDeps();
    const wrong = await join(deps, "delivery_lead", "ZZZZ-ZZZZ-ZZZZ");
    expect(wrong.res.status).toBe(401);
    const wrongBody = (await wrong.res.json()).error;
    const unknownRole = await handleJoin(new Request(`${ORIGIN}/api/v1/join`, { method: "POST", headers: { ...guarded, "X-Forwarded-For": ADDRESS.delivery_lead }, body: JSON.stringify({ sessionId: SESSION, role: "no_such_role", joinCode: "ABCD", displayName: "X" }) }), deps);
    expect(unknownRole.status).toBe(401);
    expect((await unknownRole.json()).error).toEqual(wrongBody);
    for (let i = 0; i < 5; i++) await join(deps, "delivery_lead", "ZZZZ-ZZZZ-ZZZZ");
    const calls = connect.mock.calls.length;
    const right = await join(deps, "delivery_lead");
    expect(right.res.status).toBe(401);
    expect((await right.res.json()).error).toEqual(wrongBody);
    expect(connect.mock.calls.length).toBe(calls); // refused by the BFF; the runtime never saw it
    // A colleague behind the same address joins another role.
    expect((await join(deps, "tech_lead", typed(codes.tech_lead!), ADDRESS.delivery_lead)).res.status).toBe(200);
    // The join route's own connection is closed once the credential is issued: the runtime has released the seat.
    await until(() => runtime!.host.assignments.tech_lead === undefined);
    // After a join the code no longer opens the seat (a credential exists): the same neutral refusal.
    const again = await join(deps, "tech_lead");
    expect(again.res.status).toBe(401);
    expect((await again.res.json()).error).toEqual(wrongBody);
  });

  it("a revoked credential (after leave) gets signed_out and a cleared cookie, with the message 'ask your facilitator for a new code'", async () => {
    const { deps } = makeDeps();
    const j = await join(deps, "delivery_lead");
    const s = await stream(deps, j.cookie!, "delivery_lead");
    await until(() => s.r.frames().some((f) => f.event === "joined"));
    const left = await post(deps, handleLeave, "leave", j.cookie!, "delivery_lead", {});
    expect(left.status).toBe(200);
    expect(left.headers.get("Set-Cookie")).toMatch(/Max-Age=0/i);
    const after = await stream(deps, j.cookie!, "delivery_lead");
    await after.r.finished;
    expect(after.r.frames().at(-1)).toEqual({ event: "signed_out", data: { message: SIGNED_OUT_MESSAGE } });
    expect(after.res.headers.get("Set-Cookie")).toMatch(new RegExp(`^${COOKIE_NAME}=;.*Max-Age=0`, "i"));
  });

  it("a cookie from another log gets a reset and a reissued cookie; the reissued cookie resumes without a reset", async () => {
    const { deps } = makeDeps();
    const j = await join(deps, "delivery_lead");
    const sealed = unseal<SessionCookie>(j.cookie!, KEYS, Date.now())!;
    const stale = seal({ ...sealed, logIdentity: "0".repeat(32) }, KEYS, Date.now());
    const first = await stream(deps, stale, "delivery_lead", { lastEventId: "3" });
    await until(() => first.r.frames().some((f) => f.event === "reset"));
    const reissued = cookieOf(first.res)!;
    expect(unseal<SessionCookie>(reissued, KEYS, Date.now())).toEqual(sealed);
    await first.r.cancel();
    await until(() => runtime!.host.assignments.delivery_lead === undefined);
    const second = await stream(deps, reissued, "delivery_lead");
    await until(() => second.r.frames().some((f) => f.event === "joined"));
    expect(second.r.frames().some((f) => f.event === "reset")).toBe(false);
    expect(second.res.headers.get("Set-Cookie")).toBeNull();
  });

  it("an aborted request closes its runtime socket (the seat is released); a second tab supersedes the first", async () => {
    const { deps } = makeDeps();
    const j = await join(deps, "delivery_lead");
    const sealed = unseal<SessionCookie>(j.cookie!, KEYS, Date.now())!;
    const ac = new AbortController();
    const s = await stream(deps, j.cookie!, "delivery_lead", { signal: ac.signal });
    await until(() => runtime!.host.assignments.delivery_lead === sealed.participantId);
    ac.abort();
    await until(() => runtime!.host.assignments.delivery_lead === undefined);
    await s.r.finished;
    const a = await stream(deps, j.cookie!, "delivery_lead");
    await until(() => a.r.frames().some((f) => f.event === "joined"));
    const b = await stream(deps, j.cookie!, "delivery_lead");
    await until(() => b.r.frames().some((f) => f.event === "joined"));
    await a.r.finished;
    expect(a.r.frames().at(-1)!.event).toBe("superseded");
    expect(b.r.done()).toBe(false);
    expect(runtime!.host.assignments.delivery_lead).toBe(sealed.participantId);
  });

  it("the stream cap returns 503 without contacting the runtime", async () => {
    const { deps, connect } = makeDeps({ maxStreams: 1 });
    const a = await join(deps, "delivery_lead");
    const b = await join(deps, "tech_lead");
    const s = await stream(deps, a.cookie!, "delivery_lead");
    await until(() => s.r.frames().some((f) => f.event === "joined"));
    const calls = connect.mock.calls.length;
    const res = await handleStream(new Request(`${ORIGIN}/api/v1/stream?session=${SESSION}`, { headers: { Accept: "text/event-stream", Cookie: `${COOKIE_NAME}=${b.cookie}`, "X-Forwarded-For": ADDRESS.tech_lead } }), deps);
    expect(res.status).toBe(503);
    expect(connect.mock.calls.length).toBe(calls);
  });
});
