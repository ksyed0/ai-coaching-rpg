import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { ChatRequest, ModelProvider } from "@acr/adapters";
import { loadScenario, type Scenario } from "@acr/script";
import { createApi } from "../api.js";
import { BotHost } from "../bots/bot-host.js";
import { BOT_FORWARD_KEY, BotSocket, type WsFactory } from "../bots/bot-socket.js";
import { IntentLog } from "../bots/intent-log.js";
import { loadControlConfig, type ControlConfig } from "../config.js";
import { listScenarios, scenarioDir } from "../scenarios.js";
import { SessionList } from "../session-list.js";
import { forkSpawn } from "../spawn.js";
import { Supervisor } from "../supervisor.js";

/**
 * US-0061 (slice 2b-3c, Task 8): the group-score option against the REAL stack, across a control-service replacement. (Harness of
 * bots.real.test.ts, US-0060 Task 18: the live AI players against the REAL stack. A real Supervisor with forkSpawn (real runtime child
 * processes, mock NPC models), a real BotHost whose bots talk over real loopback sockets, and a scripted model for the bots only (its
 * lines are BOT-LINE-<n>)). Humans are raw WebSocket clients. Private temp dirs, port 0, every wait is a poll on an effect (never an
 * elapsed-time assertion), and every child is gone when a test ends.
 */
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_SCENARIOS = path.join(here, "../../../../scenarios");
const SCENARIO = "friday-escalation";
const TOKEN = "t".repeat(40);
const WAIT_MS = 60_000;
const TECH = "tech_lead";
const HUMANS = ["account_manager", "delivery_lead"] as const;

// ---- polling ----

async function until<T>(what: string, fn: () => T | undefined | false | Promise<T | undefined | false>, timeout = WAIT_MS): Promise<T> {
  let got: T | undefined;
  await vi.waitFor(async () => {
    const v = await fn();
    if (!v) throw new Error(`still waiting for ${what}`);
    got = v;
  }, { timeout, interval: 25 });
  return got as T;
}

// ---- the scripted model of the bots ----

type Plan = { kind: "hang" } | { kind: "defer"; text: Promise<string> };
/** Ordinary calls answer BOT-LINE-<n>; hangNext() makes the next call never yield; deferNext() makes it wait for the returned release. */
class ScriptedProvider implements ModelProvider {
  readonly name = "scripted";
  readonly calls: ChatRequest[] = [];
  private n = 0;
  private plans: Plan[] = [];
  hangNext(): void { this.plans.push({ kind: "hang" }); }
  deferNext(): (text: string) => void {
    let release: (text: string) => void = () => undefined;
    this.plans.push({ kind: "defer", text: new Promise<string>((r) => { release = r; }) });
    return release;
  }
  async *stream(req: ChatRequest): AsyncIterable<string> {
    this.calls.push(req);
    const plan = this.plans.shift();
    if (plan?.kind === "hang") { await new Promise<void>(() => undefined); return; }
    if (plan?.kind === "defer") { yield await plan.text; return; }
    yield `BOT-LINE-${++this.n}`;
  }
}

// ---- what the test observes of the bots ----

type OpenRec = { roleId: string; port: number; code: string; participantId: string; key?: string; closed: boolean; error?: string };
type Cap = {
  logs: string[]; says: { roleId: string; text: string; sceneId: string }[]; opens: OpenRec[]; reissues: string[]; alerts: string[];
  pids: number[]; apiBodies: string[]; intentBodies: string[]; live: number; peak: number; humanClients: Client[];
};
const newCap = (): Cap => ({ logs: [], says: [], opens: [], reissues: [], alerts: [], pids: [], apiBodies: [], intentBodies: [], live: 0, peak: 0, humanClients: [] });

class Client {
  readonly raws: string[] = [];
  readonly msgs: any[] = [];
  private constructor(readonly ws: WebSocket) {
    ws.on("message", (d) => { const raw = d.toString(); this.raws.push(raw); try { this.msgs.push(JSON.parse(raw)); } catch { /* not json */ } });
  }
  static open(port: number): Promise<Client> {
    return new Promise((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${port}`); w.on("open", () => res(new Client(w))); w.on("error", rej); });
  }
  send(m: unknown): void { this.ws.send(JSON.stringify(m)); }
  text(): string { return this.raws.join("\n"); }
  events(type?: string): any[] { return this.msgs.filter((m) => m.type === "event" && (type === undefined || m.event.type === type)).map((m) => m.event); }
  utterances(text: string): any[] { return this.events("utterance").filter((e) => e.text === text); }
  close(): void { try { this.ws.terminate(); } catch { /* gone */ } }
}

type Stack = { sup: Supervisor; host: BotHost; provider: ScriptedProvider; config: ControlConfig; cap: Cap; parentEnv: NodeJS.ProcessEnv };

type Hook = { sessions: Map<string, { codes: Map<string, string>; budget?: { used: number }; bots: Map<string, { participantId: string }> }> };
/** Test hook: the BotHost's private per-session state (its codes live only there). */
const hostState = (host: BotHost, id: string) => (host as unknown as Hook).sessions.get(id);
const botCode = (s: Stack, id: string, role = TECH): string => {
  const c = hostState(s.host, id)?.codes.get(role);
  if (!c) throw new Error(`the host holds no code for ${role}`);
  return c;
};

let root = "";
const stacks: Stack[] = [];
const servers: http.Server[] = [];
let allPids: number[] = [];

function configFor(extra: Record<string, string> = {}): ControlConfig {
  return loadControlConfig({
    CONTROL_DATA_DIR: root, LAUNCHER_TOKEN: TOKEN, CONTROL_GRACE_MS: "10000", CONTROL_READY_TIMEOUT_MS: "40000", MAX_SESSIONS: "5",
    AI_PLAYER_SETTLE_MS: "0", AI_PLAYER_MIN_GAP_MS: "0", AI_PLAYER_NUDGE_MS: "3600000", ...extra,
  });
}

function makeStack(config: ControlConfig, cap: Cap, parentEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, MODEL_PROVIDER: "mock" }): Stack {
  const provider = new ScriptedProvider();
  const list = new SessionList(config.listFile);
  const log = (m: string): void => { cap.logs.push(m); };
  const scenarioFor = async (sessionId: string): Promise<Scenario> => {
    const entry = list.read().find((e) => e.sessionId === sessionId);
    if (!entry) throw new Error("unknown session");
    return loadScenario(scenarioDir(config.scenariosDir, entry.scenarioId));
  };
  const open: typeof BotSocket.open = async (o) => {
    const rec: OpenRec = { roleId: o.roleId, port: o.port, code: o.code, participantId: o.participantId, closed: false };
    cap.opens.push(rec);
    const ws: WsFactory = (url, opts) => { rec.key = opts.headers["X-Forwarded-For"]; return new WebSocket(url, opts); };
    let sock: BotSocket;
    try {
      sock = await BotSocket.open({
        ...o, ws,
        onClose: (c, info) => { if (!rec.closed) { rec.closed = true; cap.live--; } o.onClose(c, info); },
      });
    } catch (err) { rec.error = err instanceof Error ? err.message : "error"; throw err; }
    if (rec.closed) return sock;
    cap.live++;
    cap.peak = Math.max(cap.peak, cap.live);
    const say = sock.say.bind(sock);
    sock.say = (text, sceneId) => { cap.says.push({ roleId: o.roleId, text, sceneId }); say(text, sceneId); };
    return sock;
  };
  let host: BotHost | undefined;
  const sup = new Supervisor({
    config, list, scenarios: () => listScenarios(config.scenariosDir), parentEnv, log,
    spawn: (o) => {
      const h = forkSpawn()(o);
      const pid = (h as unknown as { pid: number }).pid;
      cap.pids.push(pid); allPids.push(pid);
      return h;
    },
    bots: (deps) => {
      host = new BotHost({
        provider, settings: config.aiPlayer, intents: new IntentLog(config.intentsDir, log), scenarioFor, log, open,
        reissue: (id, roleId) => { cap.reissues.push(roleId); return deps.reissue(id, roleId); },
        alert: (id, roleId, message) => { cap.alerts.push(message); deps.alert(id, roleId, message); },
      });
      return host;
    },
  });
  const s: Stack = { sup, host: host!, provider, config, cap, parentEnv };
  stacks.push(s);
  return s;
}

beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "acr-group-option-real-")); allPids = []; });
afterEach(async () => {
  for (const s of stacks.splice(0)) { for (const c of s.cap.humanClients) c.close(); await s.sup.shutdown().catch(() => undefined); }
  for (const srv of servers.splice(0)) { srv.closeAllConnections(); await new Promise<void>((r) => srv.close(() => r())); }
  // No child process may outlive its test.
  await until("every child to be gone", () => allPids.every((pid) => { try { process.kill(pid, 0); return false; } catch { return true; } }));
  rmSync(root, { recursive: true, force: true });
});

// ---- driving a session ----

async function facilitator(s: Stack, id: string): Promise<Client> {
  const f = s.sup.facilitator(id);
  if (!f) throw new Error("no facilitator endpoint");
  const c = await Client.open(f.port);
  s.cap.humanClients.push(c);
  c.send({ type: "join_facilitator", sessionId: id, token: f.token });
  await until("the facilitator to join", () => c.msgs.some((m) => m.type === "joined") || c.msgs.some((m) => m.type === "error") && Promise.reject(new Error(c.text())));
  return c;
}
const rosterOf = (f: Client): { roleId: string; joined: boolean; consented: boolean; ai?: true }[] | undefined => {
  const r = [...f.msgs].reverse().find((m) => m.type === "roster" && m.audience === "facilitator");
  return r?.entries;
};

/** A person's seat: joins by code, consents. `humans` are not counted by the test as bots. */
async function seat(s: Stack, id: string, port: number, roleId: string, code: string): Promise<Client> {
  const c = await Client.open(port);
  s.cap.humanClients.push(c);
  c.send({ type: "join", sessionId: id, roleId, participantId: `human-${roleId}`, joinCode: code });
  await until(`${roleId} to join`, () => {
    if (c.msgs.some((m) => m.type === "error")) throw new Error(`${roleId} was refused: ${c.text()}`);
    return c.msgs.some((m) => m.type === "joined");
  });
  c.send({ type: "consent", noticeVersion: "v2" });
  return c;
}

type Lobby = { id: string; port: number; humans: Record<string, Client>; fac: Client; codes: Map<string, string> };

/** create, tech_lead (or `ai`) becomes AI, the bot joins, the humans join and consent, the facilitator starts. */
async function startedLobby(s: Stack, o: { ai?: string[]; scenario?: string; start?: boolean } = {}): Promise<Lobby> {
  const ai = o.ai ?? [TECH];
  const created = await s.sup.create(o.scenario ?? SCENARIO);
  const id = created.sessionId;
  const codes = new Map(created.codes.map((c) => [c.roleId, c.code]));
  const set = await s.sup.setAiRoles(id, ai);
  for (const c of set.codes) codes.set(c.roleId, c.code);
  for (const r of ai) await until(`${r}'s bot to join`, () => s.host.isAiConnected(id, r));
  const fac = await facilitator(s, id);
  const humans: Record<string, Client> = {};
  for (const r of HUMANS) if (!ai.includes(r)) humans[r] = await seat(s, id, created.port, r, codes.get(r)!);
  await until("every seat to be ready", () => {
    const roster = rosterOf(fac);
    return roster !== undefined && roster.length > 0 && roster.every((e) => (e.ai ? e.joined : e.joined && e.consented)) || (o.start === false && roster !== undefined && roster.length > 0 && roster.filter((e) => !e.ai).every((e) => e.joined && e.consented));
  });
  if (o.start !== false) {
    fac.send({ type: "start" });
    await until("session.started", () => fac.events("session.started").length > 0);
  }
  return { id, port: created.port, humans, fac, codes };
}

const say = (c: Client, text: string): void => c.send({ type: "say", text });
const intentsOf = (s: Stack, id: string) => s.sup.intents(id, TECH);
const sessionLog = (s: Stack, id: string): any[] =>
  readFileSync(path.join(s.config.sessionsDir, `${id}.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

async function api(s: Stack, port: number, method: string, url: string, body?: unknown): Promise<{ status: number; text: string; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, {
    method, headers: { "x-service-token": TOKEN, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  (url.includes("/intents") ? s.cap.intentBodies : s.cap.apiBodies).push(text);
  return { status: res.status, text, json: JSON.parse(text) };
}
async function serve(s: Stack): Promise<number> {
  const server = http.createServer(createApi({ config: s.config, supervisor: s.sup, scenarios: () => listScenarios(s.config.scenariosDir), log: (m) => s.cap.logs.push(m) }));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return (server.address() as { port: number }).port;
}

const killRuntime = async (s: Stack, id: string): Promise<void> => {
  process.kill(s.cap.pids.at(-1)!, "SIGKILL");
  await until("the session to be stopped", () => s.sup.get(id)?.status === "stopped");
};

// ---- the tests ----

const firstLine = (s: Stack, id: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(s.config.sessionsDir, `${id}.jsonl`), "utf8").split("\n")[0]!) as Record<string, unknown>;

/** The humans join and consent; the facilitator starts; resolves with the session.started the facilitator saw. */
async function seatAndStart(s: Stack, id: string, port: number, codes: { roleId: string; code: string }[], humanRoles: readonly string[]): Promise<any> {
  const fac = await facilitator(s, id);
  for (const r of humanRoles) await seat(s, id, port, r, codes.find((c) => c.roleId === r)!.code);
  await until("every seat to be ready", () => {
    const roster = rosterOf(fac);
    return roster !== undefined && roster.length > 0 && roster.every((e) => (e.ai ? e.joined : e.joined && e.consented));
  });
  fac.send({ type: "start" });
  return until("session.started", () => fac.events("session.started")[0]);
}

describe("the group-score option against the real stack (US-0061)", () => {
  it("option off set over the API, the control service is replaced by a new one over the same directories (resumeAll), GET shows includeInGroup false, two humans join and consent, the bot connects, start succeeds and the first line of <id>.jsonl has aiRoles [tech_lead] and includeInGroup false", async () => {
    const config = configFor();
    const first = makeStack(config, newCap());
    const firstPort = await serve(first);
    const created = await first.sup.create(SCENARIO);
    const id = created.sessionId;
    const set = await api(first, firstPort, "PUT", `/sessions/${id}/ai-roles`, { roles: [TECH], includeInGroup: false });
    expect(set.status).toBe(200);
    expect(set.json.data.includeInGroup).toBe(false);
    await until("the bot to join", () => first.host.isAiConnected(id, TECH));
    await first.sup.shutdown(); // the control service goes away; its runtime exits on the disconnect

    const second = makeStack(config, newCap());
    const port = await serve(second);
    await second.sup.resumeAll();
    await until("the session to run again", () => second.sup.get(id)?.status === "running");
    const one = await api(second, port, "GET", `/sessions/${id}`);
    expect(one.status).toBe(200);
    expect(one.json.data.includeInGroup).toBe(false);
    await until("the bot to rejoin", () => second.host.isAiConnected(id, TECH));
    expect((await api(second, port, "GET", `/sessions/${id}`)).json.data.includeInGroup).toBe(false);

    // The resumed lobby shows no human code: the facilitator reissues them.
    const fresh = await second.sup.reissueAll(id);
    const info = second.sup.get(id)!;
    const started = await seatAndStart(second, id, info.port!, fresh, HUMANS);
    expect(started.aiRoles).toEqual([TECH]);
    const head = firstLine(second, id);
    expect(head.type).toBe("session.started");
    expect(head.aiRoles).toEqual([TECH]);
    expect(Object.keys(head)).toContain("includeInGroup");
    expect(head.includeInGroup).toBe(false);
    expect(head.logFormat).toBe(3);
    // Players never get the option (the facilitator's own frame may): every client but the facilitator's.
    const facClient = second.cap.humanClients[0]!;
    for (const c of second.cap.humanClients.filter((x) => x !== facClient)) expect(c.text()).not.toContain("includeInGroup");
  });

  it("reissue-all in the lobby keeps the option off in the log after the start", async () => {
    const s = makeStack(configFor(), newCap());
    const created = await s.sup.create(SCENARIO);
    const id = created.sessionId;
    const set = await s.sup.setAiRoles(id, [TECH], false);
    expect(set.includeInGroup).toBe(false);
    await until("the bot to join", () => s.host.isAiConnected(id, TECH));
    const fresh = await s.sup.reissueAll(id);
    expect(fresh.some((c) => c.roleId === TECH)).toBe(false);
    await until("the bot to be seated again", () => s.host.isAiConnected(id, TECH));
    expect(s.sup.get(id)!.includeInGroup).toBe(false);
    const started = await seatAndStart(s, id, s.sup.get(id)!.port!, fresh, HUMANS);
    expect(started.aiRoles).toEqual([TECH]);
    const head = firstLine(s, id);
    expect(head.aiRoles).toEqual([TECH]);
    expect(head.includeInGroup).toBe(false);
  });

  it("a session with no AI roles starts with a format-2 session.started without includeInGroup", async () => {
    const s = makeStack(configFor(), newCap());
    const created = await s.sup.create(SCENARIO);
    const id = created.sessionId;
    const started = await seatAndStart(s, id, created.port, created.codes, [...HUMANS, TECH]);
    expect(started.aiRoles).toBeUndefined();
    const head = firstLine(s, id);
    expect(head.type).toBe("session.started");
    expect(head.logFormat).toBe(2);
    expect(Object.keys(head)).not.toContain("includeInGroup");
    expect(Object.keys(head)).not.toContain("aiRoles");
  });
});
