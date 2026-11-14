import { FacilitatorBudget } from "../facilitator-budget";
import { FacilitatorHub } from "../facilitator-hub";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import type { Config } from "../config";
import { handleConsoleAiRoles } from "../console-ai";
import { CONSOLE_COOKIE, secretEpoch } from "../console-session";
import { handleConsoleReadiness, handleConsoleSessionsCreate, handleConsoleStart } from "../console-sessions";
import { AI_FILLED_MESSAGE, COOKIE_NAME, handleConsent, handleJoin, handleSay, handleStream, type Deps } from "../handlers";
import { LauncherError, type LauncherReason } from "../launcher-client";
import { seal } from "../seal";
import { RuntimeConnection, realTimer } from "../runtime-connection";
import { StreamHub } from "../stream-hub";
import { JoinThrottle } from "../throttle";
import { sseReader, until } from "./fakes";
import { accountCookieValue, adminNamed, withConsoleAuth } from "../test-support/console-fixtures";

// US-0060 (slice 2b-3a, Task 14): AI player seats against the REAL runtime, booted in-process with CONTROL_MANAGED=1 and a fake parent
// (the test plays the control service over IPC: set_ai_roles gives the AI seat's code), with the BFF handlers in front of the humans.
// The bot is a raw ws client. Mock models, port 0, private temp dirs; nothing measures elapsed time.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

// Loaded by a computed path (see hub.runtime.test.ts): a static import would type-check the runtime's sources under this app's settings.
const MAIN = fileURLToPath(new URL("../../../../../services/runtime/src/main.ts", import.meta.url));
if (!existsSync(MAIN)) throw new Error(`ai-roles.runtime.test.ts needs the runtime's entry point at ${MAIN}; it moved: update MAIN`);
const SCENARIO = fileURLToPath(new URL("../../../../../scenarios/friday-escalation", import.meta.url));

type Host = { assignments: Record<string, string>; idle(): Promise<void>; aiRoleIds(): string[]; consentGiven(roleId: string, participantId: string): boolean };
type ChildMsg = { type: string; requestId?: string; codes?: { roleId: string; code: string }[]; reason?: string };
type ParentChannelLike = { send(m: ChildMsg): boolean; onMessage(fn: (m: unknown) => void): void; onDisconnect(fn: () => void): void };
type Bootstrap = (o: { env: Record<string, string>; root: string; tickMs: number; log: (m: string) => void; warn: (m: string) => void; parent: ParentChannelLike }) =>
  Promise<{ ok: true; runtime: { port: number; host: Host; stop(): Promise<void> } } | { ok: false; errors: string[] }>;

const SESSION = "web-ai";
const ORIGIN = "https://play.example.org";
const KEYS: Config["cookieKeys"] = [{ id: "k1", key: Buffer.alloc(32, 7) }];
const HUMANS = ["account_manager", "delivery_lead"] as const;
type Human = (typeof HUMANS)[number];
const ADDRESS: Record<string, string> = { account_manager: "198.51.100.31", delivery_lead: "198.51.100.32", tech_lead: "198.51.100.33" };
const BOT_PID = "BOT-PID-41";
const BOT_LINE = "BOT-LINE-41";

let tmp = "";
let runtime: { port: number; host: Host; stop(): Promise<void> } | null = null;
let codes: Record<string, string> = {};
let sent: ChildMsg[] = [];
let ask: (m: unknown) => void = () => {};
let closers: (() => unknown)[] = [];

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "acr-web-ai-"));
  const { bootstrap } = (await import(MAIN)) as { bootstrap: Bootstrap };
  sent = [];
  const handlers: ((m: unknown) => void)[] = [];
  ask = (m) => { for (const h of handlers) h(m); };
  const parent: ParentChannelLike = { send(m) { sent.push(m); return true; }, onMessage(fn) { handlers.push(fn); }, onDisconnect() {} };
  const r = await bootstrap({
    env: { SCENARIO_DIR: SCENARIO, RUNTIME_PORT: "0", RUNTIME_HOST: "127.0.0.1", SESSION_ID: SESSION, MODEL_PROVIDER: "mock", TRUST_PROXY: "1", CONTROL_MANAGED: "1", SESSION_DATA_DIR: path.join(tmp, "sessions") },
    root: tmp, tickMs: 60_000, log: () => {}, warn: () => {}, parent,
  });
  if (!r.ok) throw new Error(r.errors.join("; "));
  runtime = r.runtime;
  const issued = sent.find((m) => m.type === "codes");
  if (!issued) throw new Error("the runtime sent no codes to the parent");
  codes = Object.fromEntries(issued.codes!.map((c) => [c.roleId, c.code]));
});
afterEach(async () => {
  for (const c of closers.reverse()) await c();
  closers = [];
  await runtime?.stop(); runtime = null;
  await rm(tmp, { recursive: true, force: true });
});

/** The control service's side: set_ai_roles and the reply for the same request id. */
async function setAiRoles(requestId: string, roles: string[]): Promise<ChildMsg> {
  ask({ type: "set_ai_roles", requestId, roles });
  const reply = () => sent.find((m) => m.requestId === requestId);
  await vi.waitFor(() => { if (!reply()) throw new Error("no reply yet"); }, { timeout: 30_000, interval: 10 });
  return reply()!;
}

function makeDeps() {
  const config: Config = { runtimeUrl: `ws://127.0.0.1:${runtime!.port}`, publicOrigin: ORIGIN, cookieKeys: KEYS, cookieMaxAgeHours: 12, maxStreams: 10, maxStreamsPerSession: 10, maxStreamsPerAddress: 10 };
  const connect = vi.fn((url: string, address: string) => RuntimeConnection.connect(url, address));
  const hub = new StreamHub({ maxStreams: 10, maxStreamsPerSession: 10, maxStreamsPerAddress: 10, setTimer: realTimer, now: Date.now });
  const deps: Deps = { config, now: Date.now, connect: connect as unknown as Deps["connect"], joinThrottle: new JoinThrottle({ max: 5, windowMs: 60_000, blockMs: 60_000, now: Date.now }), consoleThrottle: new JoinThrottle({ max: 5, windowMs: 60_000, blockMs: 60_000, now: Date.now }), consoleGlobalThrottle: new JoinThrottle({ max: 20, windowMs: 600_000, blockMs: 300_000, now: Date.now }), consoleLoginThrottle: new JoinThrottle({ max: 5, windowMs: 60_000, blockMs: 60_000, now: Date.now }), reportThrottle: new JoinThrottle({ max: 60, windowMs: 60_000, blockMs: 60_000, now: Date.now }), reportWriteThrottle: new JoinThrottle({ max: 30, windowMs: 60_000, blockMs: 60_000, now: Date.now }), consoleReportThrottle: new JoinThrottle({ max: 60, windowMs: 60_000, blockMs: 60_000, now: Date.now }), reportEnterThrottle: new JoinThrottle({ max: 5, windowMs: 60_000, blockMs: 60_000, now: Date.now }), reportReadFailThrottle: new JoinThrottle({ max: 5, windowMs: 60_000, blockMs: 60_000, now: Date.now }), voiceTokenThrottle: new JoinThrottle({ max: 20, windowMs: 60_000, blockMs: 60_000, now: Date.now }), hub, facilitatorBudget: new FacilitatorBudget(), facilitatorHub: new FacilitatorHub({ setTimer: realTimer, now: Date.now }) };
  return { deps, connect };
}

const guarded = { Origin: ORIGIN, "X-Requested-With": "scenecoach", "Content-Type": "application/json" };
const cookieOf = (res: Response) => {
  const raw = res.headers.get("Set-Cookie") ?? "";
  const prefix = `${COOKIE_NAME}=`;
  if (!raw.startsWith(prefix)) return null;
  const end = raw.indexOf(";");
  return raw.slice(prefix.length, end === -1 ? undefined : end);
};
async function join(d: Deps, role: string, displayName = `Name ${role}`) {
  const res = await handleJoin(new Request(`${ORIGIN}/api/v1/join`, { method: "POST", headers: { ...guarded, "X-Forwarded-For": ADDRESS[role]! }, body: JSON.stringify({ sessionId: SESSION, role, joinCode: codes[role], displayName }) }), d);
  return { res, cookie: cookieOf(res) };
}
async function stream(d: Deps, cookie: string, role: string, lastEventId?: string) {
  const res = await handleStream(new Request(`${ORIGIN}/api/v1/stream?session=${SESSION}`, {
    headers: { Accept: "text/event-stream", Cookie: `${COOKIE_NAME}=${cookie}`, "Sec-Fetch-Site": "same-origin", "X-Forwarded-For": ADDRESS[role]!, ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}) },
  }), d);
  const r = sseReader(res);
  closers.push(() => r.cancel());
  return { res, r };
}
const consentRoute = (d: Deps, cookie: string, role: string, noticeVersion: string) =>
  handleConsent(new Request(`${ORIGIN}/api/v1/consent`, { method: "POST", headers: { ...guarded, "X-Forwarded-For": ADDRESS[role]!, Cookie: `${COOKIE_NAME}=${cookie}` }, body: JSON.stringify({ noticeVersion }) }), d);

type Raw = { ws: WebSocket; inbox: any[]; send(m: unknown): void };
async function rawSocket(): Promise<Raw> {
  const ws = new WebSocket(`ws://127.0.0.1:${runtime!.port}`);
  const inbox: any[] = [];
  ws.on("message", (b) => inbox.push(JSON.parse(b.toString())));
  await new Promise<void>((r, j) => { ws.on("open", () => r()); ws.on("error", j); });
  closers.push(() => ws.terminate());
  return { ws, inbox, send: (m) => ws.send(JSON.stringify(m)) };
}
async function facilitator() {
  const f = await rawSocket();
  f.send({ type: "join_facilitator", sessionId: SESSION });
  await until(() => f.inbox.some((m) => m.type === "joined"));
  return f;
}
/** The bot: a raw client that joins its AI seat with the IPC-issued code, asks for a credential and sends no displayName. */
async function bot(botCode: string) {
  const b = await rawSocket();
  b.send({ type: "join", sessionId: SESSION, roleId: "tech_lead", participantId: BOT_PID, joinCode: botCode, issueCredential: true });
  await until(() => b.inbox.some((m) => m.type === "joined" || m.type === "error"));
  const joined = b.inbox.find((m) => m.type === "joined");
  if (!joined) throw new Error(`the bot's join was refused: ${JSON.stringify(b.inbox)}`);
  return { ...b, joined };
}

/** tech_lead is an AI seat (set over IPC); both humans join through the BFF and consent; the bot joins; the facilitator starts; the bot speaks once. */
async function startedWithBot() {
  const reply = await setAiRoles("ai-1", ["tech_lead"]);
  expect(reply.type).toBe("ai_roles_set");
  const issued = reply.codes!;
  expect(issued.map((c) => c.roleId)).toEqual(["tech_lead"]);
  const botCode = issued[0]!.code;
  const { deps } = makeDeps();
  const humans = {} as Record<Human, { cookie: string; r: ReturnType<typeof sseReader> }>;
  for (const role of HUMANS) {
    const j = await join(deps, role);
    expect(j.res.status).toBe(200);
    const s = await stream(deps, j.cookie!, role);
    await until(() => s.r.frames().some((f) => f.event === "joined"));
    const notice = s.r.frames().find((f) => f.event === "joined")!.data.consent.noticeVersion as string;
    expect((await consentRoute(deps, j.cookie!, role, notice)).status).toBe(200);
    humans[role] = { cookie: j.cookie!, r: s.r };
  }
  const b = await bot(botCode);
  const fac = await facilitator();
  fac.send({ type: "start" });
  await until(() => HUMANS.every((h) => humans[h].r.events().some((e) => e.type === "inject.fired")));
  await runtime!.host.idle();
  b.send({ type: "say", text: BOT_LINE });
  await until(() => HUMANS.every((h) => humans[h].r.events().some((e) => e.type === "utterance" && e.text === BOT_LINE)));
  await runtime!.host.idle();
  return { deps, humans, bot: b, fac, botCode };
}

describe("AI seats against the real runtime (US-0060)", () => {
  it("each human's player stream carries session.started with aiRoles [\"tech_lead\"] and the bot's line \"BOT-LINE-41\" with roleId tech_lead", async () => {
    const { humans } = await startedWithBot();
    for (const role of HUMANS) {
      const events = humans[role].r.events();
      const started = events.find((e) => e.type === "session.started");
      expect(started, `${role} saw session.started`).toBeDefined();
      expect(started.aiRoles).toEqual(["tech_lead"]);
      const line = events.find((e) => e.type === "utterance" && e.text === BOT_LINE);
      expect(line, `${role} saw the bot's line`).toBeDefined();
      expect(line.roleId).toBe("tech_lead");
    }
  });

  it("a human whose stream reconnects after that line gets a reset whose view has aiRoles [\"tech_lead\"]", async () => {
    const { deps, humans } = await startedWithBot();
    // A Last-Event-ID beyond the head cannot be replayed, so the BFF resets the page's view from the joined snapshot.
    const again = await stream(deps, humans.delivery_lead.cookie, "delivery_lead", "100000");
    await until(() => again.r.frames().some((f) => f.event === "reset"));
    const reset = again.r.frames().find((f) => f.event === "reset")!;
    expect(reset.data.aiRoles).toEqual(["tech_lead"]);
  });

  it("no player stream byte carries the bot's participant id, credential or code, the names table or a consents entry for tech_lead", async () => {
    const { deps, humans, bot: b, fac, botCode } = await startedWithBot();
    const reconnect = await stream(deps, humans.account_manager.cookie, "account_manager", "100000"); // a reset stream is a player stream too
    await until(() => reconnect.r.frames().some((f) => f.event === "reset"));

    // Positive anchors (each marker is proven to exist where it is allowed to, so a scan that finds nothing means something):
    //  - the bot's participant id, on the facilitator socket (session.started.roles) and in the bot's own frames;
    //  - the bot's credential and reconnect token, in the bot's own joined frame;
    //  - the bot's code, in the IPC reply (the only place it is ever shown);
    //  - the names table, on the facilitator socket (session.started.names, with tech_lead named "AI player").
    // No positive anchor is possible for a consents entry for tech_lead: the runtime never records one for an AI seat, for anyone,
    // facilitator included (ws-server.ai-roles.test.ts asserts it absent there). What is proven instead is that the scanned shape
    // is the real wire shape: a human's OWN consent entry is serialised as `"<role>":{"noticeVersion"` in that human's stream.
    const credential = b.joined.credential as string;
    const reconnectToken = b.joined.reconnectToken as string;
    expect(credential.length).toBeGreaterThan(8);
    expect(reconnectToken.length).toBeGreaterThan(8);
    expect(botCode.length).toBeGreaterThan(3);
    const facStarted = fac.inbox.find((m) => m.type === "event" && m.event.type === "session.started").event;
    expect(JSON.stringify(fac.inbox)).toContain(BOT_PID);
    expect(facStarted.roles.tech_lead.participantId).toBe(BOT_PID);
    expect(facStarted.names.tech_lead).toBe("AI player");
    expect(JSON.stringify(b.inbox)).toContain(credential);
    expect(JSON.stringify(b.inbox)).toContain(reconnectToken);
    expect(Object.keys(facStarted.consents)).not.toContain("tech_lead");
    expect(humans.account_manager.r.text()).toContain('"account_manager":{"noticeVersion"');

    const streams = [humans.account_manager.r.text(), humans.delivery_lead.r.text(), reconnect.r.text()];
    for (const text of streams) {
      expect(text.length).toBeGreaterThan(0);
      for (const secret of [BOT_PID, credential, reconnectToken, botCode, codes.tech_lead!]) expect(text).not.toContain(secret);
      expect(text).not.toContain('"names"');
      expect(text).not.toContain('"tech_lead":{"noticeVersion"');
    }
    // The rotated-away original code is not the bot's, but it must not appear either; the rotation really replaced it.
    expect(botCode).not.toBe(codes.tech_lead);
  });

  it("a join through the BFF named \"AI player Sam\" is 400 reserved_name", async () => {
    const { deps, connect } = makeDeps();
    for (const displayName of ["AI player Sam", "A​I player Sam"]) {
      const j = await join(deps, "account_manager", displayName);
      expect(j.res.status, JSON.stringify(displayName)).toBe(400);
      expect((await j.res.json()).error.code).toBe("reserved_name");
    }
    expect(connect).not.toHaveBeenCalled(); // refused before the runtime was contacted
    expect(runtime!.host.assignments.account_manager).toBeUndefined();
  });

  it("switching account_manager to AI before the start ends its stream with ai_filled and its cookie's next stream is refused", async () => {
    const { deps } = makeDeps();
    const j = await join(deps, "account_manager");
    expect(j.res.status).toBe(200);
    const s = await stream(deps, j.cookie!, "account_manager");
    await until(() => s.r.frames().some((f) => f.event === "joined"));
    expect(runtime!.host.assignments.account_manager).toBeDefined();

    const reply = await setAiRoles("ai-2", ["account_manager"]);
    expect(reply.type).toBe("ai_roles_set");
    expect(reply.codes!.map((c) => c.roleId)).toEqual(["account_manager"]);
    await s.r.finished;
    expect(s.r.frames().at(-1)).toEqual({ event: "ai_filled", data: { message: AI_FILLED_MESSAGE } });
    expect(s.r.text()).not.toContain("reconnecting");

    // The old cookie's credential was revoked: the next stream is a final, with no joined frame and the cookie cleared.
    const next = await stream(deps, j.cookie!, "account_manager");
    await next.r.finished;
    expect(next.r.frames().some((f) => f.event === "joined")).toBe(false);
    expect(next.r.frames().at(-1)!.event).toBe("signed_out");
    expect(next.res.headers.get("Set-Cookie")).toMatch(new RegExp(`^${COOKIE_NAME}=;.*Max-Age=0`, "i"));
    expect(runtime!.host.assignments.account_manager).toBeUndefined();
  });
});


// ---- the same BFF handlers in front of the REAL control stack (Task 18) ----
// A real Supervisor with forkSpawn (real runtime child processes), a real BotHost, and a fake launcher that only forwards to that
// supervisor. The bot's model is scripted (its lines are BOT-LINE-<n>). Loaded by computed paths like MAIN above, for the same reason.
const CONTROL_SRC = (rel: string) => fileURLToPath(new URL(`../../../../../services/control/src/${rel}`, import.meta.url));
const SCRIPT_SRC = fileURLToPath(new URL("../../../../../packages/script/src/index.ts", import.meta.url));
const FAC_SECRET = "correct horse battery staple";
const FAC_NAME = "Mx Zorbulon";
const TECH = "tech_lead";

type RealStack = {
  sup: any; host: any; pids: number[]; parentEnv: Record<string, string | undefined>; releaseBot(): void; config: any; says: string[];
  launcher: Record<string, (...a: any[]) => Promise<unknown>>;
};
let stacks: RealStack[] = [];
let ctlRoots: string[] = [];

async function realStack(parentEnv: Record<string, string | undefined>, o: { gateBot?: boolean } = {}): Promise<RealStack> {
  const [{ Supervisor }, { BotHost }, { IntentLog }, { loadControlConfig }, { listScenarios, scenarioDir }, { SessionList }, { forkSpawn }, { loadScenario }, { BotSocket }] = await Promise.all([
    import(CONTROL_SRC("supervisor.ts")), import(CONTROL_SRC("bots/bot-host.ts")), import(CONTROL_SRC("bots/intent-log.ts")), import(CONTROL_SRC("config.ts")),
    import(CONTROL_SRC("scenarios.ts")), import(CONTROL_SRC("session-list.ts")), import(CONTROL_SRC("spawn.ts")), import(SCRIPT_SRC), import(CONTROL_SRC("bots/bot-socket.ts")),
  ]) as any[];
  const dir = await mkdtemp(path.join(os.tmpdir(), "acr-web-ctl-"));
  ctlRoots.push(dir);
  const config = loadControlConfig({
    CONTROL_DATA_DIR: dir, LAUNCHER_TOKEN: "t".repeat(40), CONTROL_GRACE_MS: "10000", CONTROL_READY_TIMEOUT_MS: "40000", MAX_SESSIONS: "3",
    AI_PLAYER_SETTLE_MS: "0", AI_PLAYER_MIN_GAP_MS: "0", AI_PLAYER_NUDGE_MS: "3600000",
  });
  const list = new SessionList(config.listFile);
  const pids: number[] = [];
  const says: string[] = [];
  let n = 0;
  const provider = { name: "scripted", async *stream() { yield `BOT-LINE-${++n}`; } };
  let release: () => void = () => undefined;
  const gate = o.gateBot ? new Promise<void>((r) => { release = r; }) : Promise.resolve();
  const open = async (opts: any) => {
    await gate;
    const sock = await BotSocket.open(opts);
    const say = sock.say.bind(sock);
    sock.say = (text: string, scene: string) => { says.push(text); say(text, scene); };
    return sock;
  };
  let host: any;
  const sup = new Supervisor({
    config, list, scenarios: () => listScenarios(config.scenariosDir), parentEnv,
    spawn: (so: any) => { const h = forkSpawn()(so); pids.push(h.pid); return h; },
    bots: (deps: any) => {
      host = new BotHost({
        provider, settings: config.aiPlayer, intents: new IntentLog(config.intentsDir), open, reissue: deps.reissue, alert: deps.alert,
        scenarioFor: async (id: string) => {
          const entry = list.read().find((e: any) => e.sessionId === id);
          if (!entry) throw new Error("unknown session");
          return loadScenario(scenarioDir(config.scenariosDir, entry.scenarioId));
        },
      });
      return host;
    },
  });
  const MAP: Record<string, LauncherReason> = { not_found: "not_found", conflict: "conflict", capacity: "capacity", bad_request: "bad_request", timeout: "timeout", ai_notice: "ai_notice", ai_started: "ai_started", ai_no_human: "ai_no_human", ai_too_many: "ai_too_many", ai_invalid: "ai_invalid", ai_role: "ai_role" };
  const wrap = <T>(fn: () => Promise<T>): Promise<T> => fn().catch((err: any) => { throw new LauncherError(MAP[err?.code] ?? "failed"); });
  const need = <T>(v: T | undefined): T => { if (v === undefined) throw new LauncherError("not_found"); return v; };
  const launcher = {
    createSession: (scenarioId: string) => wrap(() => sup.create(scenarioId)),
    session: async (id: string) => need(sup.get(id)),
    facilitator: async (id: string) => need(sup.facilitator(id)),
    setAiRoles: (id: string, roles: string[], includeInGroup?: boolean) => wrap(() => sup.setAiRoles(id, roles, includeInGroup)),
    intents: (id: string, role: string) => wrap(async () => sup.intents(id, role)),
  };
  const st: RealStack = { sup, host, pids, parentEnv, releaseBot: release, config, says, launcher };
  stacks.push(st);
  return st;
}
afterEach(async () => {
  const all = stacks.splice(0);
  for (const st of all) await st.sup.shutdown().catch(() => undefined);
  // No child process may outlive its test.
  const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };
  await until(() => all.every((st) => st.pids.every(gone)), { what: "every runtime child to exit" });
  for (const dir of ctlRoots.splice(0)) await rm(dir, { recursive: true, force: true });
});

const consoleCookie = () => `${CONSOLE_COOKIE}=${accountCookieValue(adminNamed(FAC_NAME), { keys: KEYS, now: Date.now(), expiresAt: Date.now() + 3_600_000 })}`;
function bffDeps(st: RealStack) {
  const config: Config = { runtimeUrl: "ws://127.0.0.1:1", publicOrigin: ORIGIN, cookieKeys: KEYS, cookieMaxAgeHours: 12, maxStreams: 10, maxStreamsPerSession: 10, maxStreamsPerAddress: 10, facilitatorSecret: FAC_SECRET, launcherUrl: "http://127.0.0.1:47123", launcherToken: "launcher-token-" + "t".repeat(20) };
  const hub = new StreamHub({ maxStreams: 10, maxStreamsPerSession: 10, maxStreamsPerAddress: 10, setTimer: realTimer, now: Date.now });
  return {
    config, now: Date.now, launcher: withConsoleAuth(st.launcher) as never, connect: ((url: string, address: string) => RuntimeConnection.connect(url, address)) as unknown as Deps["connect"],
    joinThrottle: new JoinThrottle({ max: 5, windowMs: 60_000, blockMs: 60_000, now: Date.now }), consoleThrottle: new JoinThrottle({ max: 5, windowMs: 60_000, blockMs: 60_000, now: Date.now }),
    consoleGlobalThrottle: new JoinThrottle({ max: 20, windowMs: 600_000, blockMs: 300_000, now: Date.now }), consoleLoginThrottle: new JoinThrottle({ max: 5, windowMs: 60_000, blockMs: 60_000, now: Date.now }), reportThrottle: new JoinThrottle({ max: 60, windowMs: 60_000, blockMs: 60_000, now: Date.now }), hub, facilitatorBudget: new FacilitatorBudget(), facilitatorHub: new FacilitatorHub({ setTimer: realTimer, now: Date.now }),
  } as unknown as Deps;
}
/** Every BFF response body of a test, as text, for the leak scan. */
let bodies: string[] = [];
async function consoleCall(deps: Deps, handler: (r: Request, d: Deps) => Promise<Response>, method: "GET" | "POST", url: string, body?: unknown) {
  const res = await handler(new Request(`${ORIGIN}${url}`, {
    method, headers: { Origin: ORIGIN, "X-Requested-With": "scenecoach", "Sec-Fetch-Site": "same-origin", Cookie: consoleCookie(), ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
    ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
  }), deps);
  const text = await res.text();
  bodies.push(text);
  return { status: res.status, json: JSON.parse(text) as any, text };
}
const hookState = (st: RealStack, id: string) => st.host.sessions.get(id) as { codes: Map<string, string>; bots: Map<string, { participantId: string }> };

describe("AI seats through the BFF handlers over the real control stack (US-0060, Task 18)", () => {
  beforeEach(() => { bodies = []; });

  it("roles set through the console return no AI code; readiness waits for the bot (aiWaiting) and then counts it; people join and consent; start succeeds; no BFF byte reveals the bot", async () => {
    const st = await realStack({ PATH: process.env.PATH, MODEL_PROVIDER: "mock" }, { gateBot: true });
    const deps = bffDeps(st);
    const created = await consoleCall(deps, handleConsoleSessionsCreate, "POST", "/api/v1/console/sessions", { scenarioId: "friday-escalation" });
    expect(created.status).toBe(200);
    const id = created.json.data.sessionId as string;
    const humanCodes = Object.fromEntries((created.json.data.codes as { roleId: string; code: string }[]).map((c) => [c.roleId, c.code]));

    const set = await consoleCall(deps, handleConsoleAiRoles, "POST", `/api/v1/console/sessions/${id}/ai-roles`, { roles: [TECH] });
    expect(set.status).toBe(200);
    expect(set.json.data.roles).toEqual([TECH]);
    expect(set.json.data.codes.map((c: { roleId: string }) => c.roleId)).not.toContain(TECH);
    const botCode = hookState(st, id).codes.get(TECH)!;
    expect(botCode.length).toBeGreaterThan(3);
    expect(set.text).not.toContain(botCode);

    // The bot is held at the gate: the seat is AI and not yet in, so readiness names it in aiWaiting and the humans in missing.
    const waiting = await consoleCall(deps, handleConsoleReadiness, "GET", `/api/v1/console/sessions/${id}/readiness`);
    expect(waiting.json.data.aiWaiting).toEqual([TECH]);
    expect(waiting.json.data.missing.slice().sort()).toEqual([...HUMANS].sort());
    expect(waiting.json.data.canStart).toBe(false);
    expect(waiting.json.data.roster.find((e: any) => e.roleId === TECH).ai).toBe(true);

    st.releaseBot();
    await vi.waitFor(async () => {
      const r = await consoleCall(deps, handleConsoleReadiness, "GET", `/api/v1/console/sessions/${id}/readiness`);
      if (r.json.data.aiWaiting.length > 0) throw new Error("the bot has not joined yet");
    }, { timeout: 45_000, interval: 50 });

    const guardedPlayer = (role: string) => ({ ...guarded, "X-Forwarded-For": ADDRESS[role]! });
    const humans: Record<string, { cookie: string; r: ReturnType<typeof sseReader> }> = {};
    for (const role of HUMANS) {
      const res = await handleJoin(new Request(`${ORIGIN}/api/v1/join`, { method: "POST", headers: guardedPlayer(role), body: JSON.stringify({ sessionId: id, role, joinCode: humanCodes[role], displayName: `Name ${role}` }) }), deps);
      bodies.push(await res.clone().text());
      expect(res.status).toBe(200);
      const cookie = cookieOf(res)!;
      const sres = await handleStream(new Request(`${ORIGIN}/api/v1/stream?session=${id}`, { headers: { Accept: "text/event-stream", Cookie: `${COOKIE_NAME}=${cookie}`, "Sec-Fetch-Site": "same-origin", "X-Forwarded-For": ADDRESS[role]! } }), deps);
      const r = sseReader(sres);
      closers.push(() => r.cancel());
      await until(() => r.frames().some((f) => f.event === "joined"));
      const notice = r.frames().find((f) => f.event === "joined")!.data.consent.noticeVersion as string;
      const c = await handleConsent(new Request(`${ORIGIN}/api/v1/consent`, { method: "POST", headers: { ...guardedPlayer(role), Cookie: `${COOKIE_NAME}=${cookie}` }, body: JSON.stringify({ noticeVersion: notice }) }), deps);
      expect(c.status).toBe(200);
      humans[role] = { cookie, r };
    }
    await vi.waitFor(async () => {
      const r = await consoleCall(deps, handleConsoleReadiness, "GET", `/api/v1/console/sessions/${id}/readiness`);
      if (!r.json.data.canStart) throw new Error("not ready yet");
      expect(r.json.data.missing).toEqual([]);
      expect(r.json.data.aiWaiting).toEqual([]);
    }, { timeout: 45_000, interval: 50 });

    const started = await consoleCall(deps, handleConsoleStart, "POST", `/api/v1/console/sessions/${id}/start`);
    expect(started.status).toBe(200);
    expect(started.json.data).toEqual({ started: true });
    for (const role of HUMANS) {
      await until(() => humans[role]!.r.events().some((e) => e.type === "session.started"));
      expect(humans[role]!.r.events().find((e) => e.type === "session.started").aiRoles).toEqual([TECH]);
    }

    // A human speaks through the BFF; the bot answers; the line arrives labelled tech_lead.
    await until(() => humans.account_manager!.r.events().some((e) => e.type === "scene.entered"));
    const said = await handleSay(new Request(`${ORIGIN}/api/v1/say`, { method: "POST", headers: { ...guardedPlayer("account_manager"), Cookie: `${COOKIE_NAME}=${humans.account_manager!.cookie}` }, body: JSON.stringify({ text: "Morning everyone, a quick status before we start." }) }), deps);
    bodies.push(await said.text());
    expect(said.status).toBe(200);
    await until(() => humans.delivery_lead!.r.events().some((e) => e.type === "utterance" && /^BOT-LINE-\d+$/.test(e.text)));
    expect(humans.delivery_lead!.r.events().find((e) => e.type === "utterance" && /^BOT-LINE-\d+$/.test(e.text)).roleId).toBe(TECH);

    // The leak scan. Markers proven where they belong: the code in the host's memory, the participant id in the host's memory (and the
    // runtime's facilitator-only data), the intent line in the intent file.
    const pid = hookState(st, id).bots.get(TECH)!.participantId;
    await vi.waitFor(() => { if (readdirSync(st.config.intentsDir).length === 0) throw new Error("no intent file yet"); }, { timeout: 30_000, interval: 50 });
    const intentFile = path.join(st.config.intentsDir, readdirSync(st.config.intentsDir)[0]!);
    await vi.waitFor(() => { if (readFileSync(intentFile, "utf8").trim() === "") throw new Error("empty"); }, { timeout: 30_000, interval: 50 });
    const intentLines = readFileSync(intentFile, "utf8").split("\n").filter(Boolean);
    expect(st.says.length).toBeGreaterThan(0);
    const markers = [botCode, "scenecoach-bot", pid, ...intentLines];
    const found = (t: string) => markers.filter((m) => t.includes(m));
    expect(found(`${botCode} scenecoach-bot ${pid} ${intentLines[0]}`)).toHaveLength(markers.length);
    for (const role of HUMANS) expect(found(humans[role]!.r.text())).toEqual([]);
    expect(bodies.length).toBeGreaterThan(5);
    for (const b of bodies) expect(found(b)).toEqual([]);
  });

  it("a start refused by the runtime for notice v1 with AI seats answers 409 ai_notice through the real refusal path", async () => {
    const parentEnv: Record<string, string | undefined> = { PATH: process.env.PATH, MODEL_PROVIDER: "mock" };
    const st = await realStack(parentEnv);
    const deps = bffDeps(st);
    const created = await consoleCall(deps, handleConsoleSessionsCreate, "POST", "/api/v1/console/sessions", { scenarioId: "friday-escalation" });
    const id = created.json.data.sessionId as string;
    const set = await consoleCall(deps, handleConsoleAiRoles, "POST", `/api/v1/console/sessions/${id}/ai-roles`, { roles: [TECH] });
    expect(set.status).toBe(200); // notice v2 names AI players, so the roles can be set
    await vi.waitFor(() => { if (!st.host.isAiConnected(id, TECH)) throw new Error("the bot has not joined"); }, { timeout: 45_000, interval: 50 });

    // The runtime comes back on the older notice (its own environment is read at each start), with the AI seat still set.
    process.kill(st.pids.at(-1)!, "SIGKILL");
    await vi.waitFor(() => { if (st.sup.get(id)?.status !== "stopped") throw new Error("not stopped"); }, { timeout: 45_000, interval: 50 });
    parentEnv.CONSENT_NOTICE_VERSION = "v1";
    await st.sup.restart(id);
    expect(st.sup.aiRolesOf(id)).toEqual([TECH]);

    const refused = await consoleCall(deps, handleConsoleStart, "POST", `/api/v1/console/sessions/${id}/start`);
    expect(refused.status).toBe(409);
    expect(refused.json.error.code).toBe("ai_notice");
    expect(refused.json.data).toEqual({ started: false, reason: "ai_notice" });
  });
});
