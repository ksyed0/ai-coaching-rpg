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
 * US-0060 (slice 2b-3b, Task 18): the live AI players against the REAL stack. A real Supervisor with forkSpawn (real runtime child
 * processes, mock NPC models), a real BotHost whose bots talk over real loopback sockets, and a scripted model for the bots only (its
 * lines are BOT-LINE-<n>). Humans are raw WebSocket clients. Private temp dirs, port 0, every wait is a poll on an effect (never an
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

beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "acr-bots-real-")); allPids = []; });
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

describe("AI players against the real runtime (US-0060)", () => {
  it("setAiRoles([tech_lead]) returns no code for it; the bot joins and the roster counts it; both humans join and consent; start succeeds and session.started has aiRoles [tech_lead]", async () => {
    const s = makeStack(configFor(), newCap());
    const created = await s.sup.create(SCENARIO);
    const id = created.sessionId;
    expect(created.codes.map((c) => c.roleId).sort()).toEqual(["account_manager", "delivery_lead", TECH]);

    const set = await s.sup.setAiRoles(id, [TECH]);
    expect(set.roles).toEqual([TECH]);
    expect(set.codes.some((c) => c.roleId === TECH)).toBe(false);
    const code = botCode(s, id);
    expect(code.length).toBeGreaterThan(0);
    expect(JSON.stringify(set)).not.toContain(code);
    expect(created.codes.find((c) => c.roleId === TECH)!.code).not.toBe(code); // the original code was rotated away

    await until("the bot to join", () => s.host.isAiConnected(id, TECH));
    const fac = await facilitator(s, id);
    await until("the roster to show the AI seat joined", () => rosterOf(fac)?.some((e) => e.roleId === TECH && e.ai === true && e.joined && !e.consented));
    expect(rosterOf(fac)!.filter((e) => e.roleId !== TECH).every((e) => !e.joined)).toBe(true);

    const humans: Client[] = [];
    for (const r of HUMANS) humans.push(await seat(s, id, created.port, r, created.codes.find((c) => c.roleId === r)!.code));
    await until("everyone to be ready", () => rosterOf(fac)!.every((e) => (e.ai ? e.joined : e.joined && e.consented)));
    fac.send({ type: "start" });
    const started = await until("session.started", () => fac.events("session.started")[0]);
    expect(started.aiRoles).toEqual([TECH]);
    for (const h of humans) await until("the human to see session.started", () => h.events("session.started")[0]?.aiRoles?.[0] === TECH);
  });

  it("after account_manager speaks, the bot's BOT-LINE-1 reaches account_manager labelled tech_lead and appears once", async () => {
    const s = makeStack(configFor(), newCap());
    const lobby = await startedLobby(s);
    const am = lobby.humans.account_manager!;
    await until("the scene", () => am.events("scene.entered").length > 0);
    say(am, "Morning everyone, a quick status before we start.");
    const line = await until("the bot's line", () => am.utterances("BOT-LINE-1")[0]);
    expect(line.roleId).toBe(TECH);
    // The bot's own confirmation (it saw its utterance event) is the intent entry; only then is "once" meaningful.
    await until("the spoken intent", () => intentsOf(s, lobby.id).some((e) => e.outcome === "spoken" && e.trigger === "reply"));
    expect(am.utterances("BOT-LINE-1")).toHaveLength(1);
    // The other human's socket gets the same broadcast independently: wait for it before counting (a loaded run saw it arrive later).
    await until("delivery_lead to see the bot's line", () => lobby.humans.delivery_lead!.utterances("BOT-LINE-1").length > 0);
    expect(lobby.humans.delivery_lead!.utterances("BOT-LINE-1")).toHaveLength(1);
    expect(s.cap.says.filter((x) => x.text === "BOT-LINE-1")).toHaveLength(1);
    expect(sessionLog(s, lobby.id).filter((e) => e.type === "utterance" && e.text === "BOT-LINE-1")).toHaveLength(1);
  });

  it("while a bot's model call never resolves, GET /sessions on the control API answers", async () => {
    const s = makeStack(configFor(), newCap());
    const port = await serve(s);
    const lobby = await startedLobby(s);
    const am = lobby.humans.account_manager!;
    await until("the scene", () => am.events("scene.entered").length > 0);
    const before = s.provider.calls.length;
    s.provider.hangNext();
    say(am, "Can someone take the first item?");
    await until("the bot's model call to be in flight", () => s.provider.calls.length > before);
    const saysAtHang = s.cap.says.length;
    const list = await api(s, port, "GET", "/sessions");
    expect(list.status).toBe(200);
    expect(list.json.data.map((x: any) => x.sessionId)).toEqual([lobby.id]);
    const one = await api(s, port, "GET", `/sessions/${lobby.id}`);
    expect(one.status).toBe(200);
    expect(s.cap.says).toHaveLength(saysAtHang); // the turn is still pending: nothing more was said
  });

  it("a facilitator pause while a reply is in flight drops it: the late line is never sent (the policy's isCurrent is the guard)", async () => {
    const s = makeStack(configFor(), newCap());
    const lobby = await startedLobby(s);
    const am = lobby.humans.account_manager!;
    await until("the scene", () => am.events("scene.entered").length > 0);
    const before = s.provider.calls.length;
    const release = s.provider.deferNext();
    say(am, "Quick check, any blockers?");
    await until("the bot's model call to be in flight", () => s.provider.calls.length > before);
    lobby.fac.send({ type: "command", command: { command: "pause" } });
    // Test hook: the bot's own policy must have seen the pause (its ticket no longer current) before the late reply is let go, so the
    // reply meets exactly the isCurrent check (the socket and the generation are unchanged by a pause).
    const bot = hostState(s.host, lobby.id)!.bots.get(TECH) as unknown as { current: { ticket: unknown } | null; policy: { isCurrent(t: unknown): boolean } };
    await until("the bot to observe the pause", () => bot.current !== null && !bot.policy.isCurrent(bot.current.ticket));
    release("BOT-LATE-PAUSED");
    await until("the late reply to be dropped", () => intentsOf(s, lobby.id).some((e) => e.outcome === "dropped"));
    expect(s.cap.says.some((x) => x.text === "BOT-LATE-PAUSED")).toBe(false);
    expect(am.utterances("BOT-LATE-PAUSED")).toHaveLength(0);
    expect(sessionLog(s, lobby.id).some((e) => e.type === "utterance" && e.text === "BOT-LATE-PAUSED")).toBe(false);
  });

  it("SIGKILL of the runtime: restart rejoins the bot on the new port with the same code, it sends no line until the next trigger, and its pre-kill in-flight reply is never recorded", async () => {
    const s = makeStack(configFor(), newCap());
    const lobby = await startedLobby(s);
    const am = lobby.humans.account_manager!;
    await until("the scene", () => am.events("scene.entered").length > 0);
    const code = botCode(s, lobby.id);
    const firstOpen = s.cap.opens.at(-1)!;
    expect(firstOpen.code).toBe(code);
    expect(firstOpen.port).toBe(lobby.port);

    // One delivered line first, so the restart has history.
    say(am, "Morning everyone, a quick status before we start.");
    await until("the first reply", () => am.utterances("BOT-LINE-1")[0]);
    await until("its spoken intent", () => intentsOf(s, lobby.id).some((e) => e.outcome === "spoken"));
    const spokenBefore = intentsOf(s, lobby.id).filter((e) => e.outcome === "spoken").length;

    // A reply is in flight (deferred) when the runtime dies.
    const callsBefore = s.provider.calls.length;
    const release = s.provider.deferNext();
    say(am, "And what about the release date?");
    await until("the in-flight model call", () => s.provider.calls.length > callsBefore);
    await killRuntime(s, lobby.id);
    expect(s.host.isAiConnected(lobby.id, TECH)).toBe(false);

    const again = await s.sup.restart(lobby.id);
    expect(again.status).toBe("running");
    expect(again.port).toBeGreaterThan(0);
    await until("the bot to rejoin", () => s.host.isAiConnected(lobby.id, TECH));
    const rejoin = s.cap.opens.at(-1)!;
    expect(rejoin.port).toBe(again.port);
    expect(rejoin.code).toBe(code);
    expect(botCode(s, lobby.id)).toBe(code);
    expect(s.cap.reissues).toEqual([]); // the same code, no new one asked for

    // The stale reply arrives only now, with the bot already seated on the new runtime.
    const sentBefore = s.cap.says.length;
    const callsAtRejoin = s.provider.calls.length;
    release("BOT-LATE-KILLED");
    await until("the late reply to be dropped", () => intentsOf(s, lobby.id).some((e) => e.outcome === "dropped"));
    expect(s.cap.says).toHaveLength(sentBefore);
    expect(s.provider.calls).toHaveLength(callsAtRejoin); // no trigger since the rejoin: no new model call, no new line
    expect(s.cap.says.some((x) => x.text === "BOT-LATE-KILLED")).toBe(false);
    expect(intentsOf(s, lobby.id).filter((e) => e.outcome === "spoken")).toHaveLength(spokenBefore);

    // The next trigger: a human is back and speaks.
    const am2 = await seat(s, lobby.id, again.port!, "account_manager", lobby.codes.get("account_manager")!);
    await until("the human to be resumed in the scene", () => am2.msgs.some((m) => m.type === "joined"));
    const fac2 = await facilitator(s, lobby.id);
    await until("the roster", () => rosterOf(fac2)?.some((e) => e.roleId === "account_manager" && e.joined));
    // A restarted session comes back paused: the facilitator resumes it, and only then a human line is a trigger.
    fac2.send({ type: "command", command: { command: "resume" } });
    await until("the resume", () => am2.events("facilitator.command").some((e) => e.command === "resume"));
    expect(s.provider.calls).toHaveLength(callsAtRejoin);
    say(am2, "Back again, sorry about that.");
    const next = await until("the next BOT-LINE", () => am2.events("utterance").find((e) => e.roleId === TECH && /^BOT-LINE-\d+$/.test(e.text)));
    expect(next.text).not.toBe("BOT-LINE-1");
    expect(sessionLog(s, lobby.id).some((e) => e.type === "utterance" && e.text === "BOT-LATE-KILLED")).toBe(false);
    expect(am2.utterances("BOT-LATE-KILLED")).toHaveLength(0);
  });

  it("a new Supervisor over the same data dir reissues tech_lead once, the bot rejoins, and the budget used equals the AI lines in the log", async () => {
    const config = configFor();
    const first = makeStack(config, newCap());
    const lobby = await startedLobby(first);
    const am = lobby.humans.account_manager!;
    await until("the scene", () => am.events("scene.entered").length > 0);
    say(am, "Morning everyone, a quick status before we start.");
    await until("the first reply", () => am.utterances("BOT-LINE-1")[0]);
    await until("its spoken intent", () => intentsOf(first, lobby.id).some((e) => e.outcome === "spoken"));
    expect(first.host.isAiConnected(lobby.id, TECH)).toBe(true);
    const firstCode = botCode(first, lobby.id);
    const aiLinesBefore = sessionLog(first, lobby.id).filter((e) => e.type === "utterance" && e.roleId === TECH).length;
    expect(aiLinesBefore).toBeGreaterThanOrEqual(1);
    expect(hostState(first.host, lobby.id)!.budget!.used).toBeGreaterThanOrEqual(aiLinesBefore);
    await first.sup.shutdown(); // the control service goes away; its runtime exits on the disconnect

    const second = makeStack(config, newCap());
    await second.sup.resumeAll();
    const info = second.sup.get(lobby.id)!;
    expect(info.status).toBe("running");
    await until("the bot to rejoin", () => second.host.isAiConnected(lobby.id, TECH));
    expect(second.cap.reissues).toEqual([TECH]);
    const newCode = botCode(second, lobby.id);
    expect(newCode).not.toBe(firstCode);
    expect(second.cap.opens.filter((o) => o.roleId === TECH).every((o) => o.code === newCode && o.port === info.port)).toBe(true);
    const aiLines = sessionLog(second, lobby.id).filter((e) => e.type === "utterance" && e.roleId === TECH).length;
    expect(aiLines).toBe(aiLinesBefore);
    expect(hostState(second.host, lobby.id)!.budget!.used).toBe(aiLines);
    expect(second.provider.calls).toHaveLength(0); // the new bot made no model call of its own
  });

  it("eight AI roles of a 12-player scenario rejoin after a runtime restart without a lasting handshake refusal (never more than eight sockets on scenecoach-bot)", async () => {
    // A private copy of friday-escalation with nine more player roles (12 players), in this test's own SCENARIOS_DIR.
    const scenariosDir = path.join(root, "scenarios");
    const copy = path.join(scenariosDir, SCENARIO);
    cpSync(path.join(REPO_SCENARIOS, SCENARIO), copy, { recursive: true });
    const template = readFileSync(path.join(copy, "roles/account_manager.yaml"), "utf8");
    for (let n = 1; n <= 9; n++) writeFileSync(path.join(copy, "roles", `extra_${n}.yaml`), template.replace("id: account_manager", `id: extra_${n}`));
    const s = makeStack(configFor({ SCENARIOS_DIR: scenariosDir }), newCap());
    const created = await s.sup.create(SCENARIO);
    expect(created.codes).toHaveLength(12);
    const id = created.sessionId;
    const aiRoles = Array.from({ length: 8 }, (_, i) => `extra_${i + 1}`);
    const set = await s.sup.setAiRoles(id, aiRoles);
    expect(set.roles.slice().sort()).toEqual(aiRoles.slice().sort());
    expect(set.codes.some((c) => aiRoles.includes(c.roleId))).toBe(false);
    for (const r of aiRoles) await until(`${r} to join`, () => s.host.isAiConnected(id, r));
    expect(s.cap.live).toBe(8);

    await killRuntime(s, id);
    await until("every socket of the dead runtime to be closed", () => s.cap.live === 0);
    const again = await s.sup.restart(id);
    for (const r of aiRoles) await until(`${r} to rejoin`, () => s.host.isAiConnected(id, r));
    expect(s.cap.live).toBe(8);
    expect(s.cap.peak).toBeLessThanOrEqual(8);
    for (const r of aiRoles) {
      const last = s.cap.opens.filter((o) => o.roleId === r).at(-1)!;
      expect(last.port).toBe(again.port);
      expect(last.key).toBe(BOT_FORWARD_KEY);
      expect(last.error).toBeUndefined();
    }
    expect(s.cap.logs.filter((l) => /could not rejoin/.test(l))).toEqual([]);
    expect(s.cap.alerts).toEqual([]);
    expect(s.cap.reissues).toEqual([]);
  });

  it("prompt: reserve then run with a hint through the control API makes the bot speak at once, labelled; the hint reaches the model and the facilitator's intent file only, never a human frame", async () => {
    const HINT = "HINT-SECRET-91";
    const s = makeStack(configFor(), newCap());
    const port = await serve(s);
    const lobby = await startedLobby(s);
    const am = lobby.humans.account_manager!;
    await until("the scene", () => am.events("scene.entered").length > 0);
    const r = await api(s, port, "POST", `/sessions/${lobby.id}/ai-roles/${TECH}/reserve`, {});
    expect(r.status).toBe(200);
    const reservation = r.json.data.reservation as string;
    expect(reservation).toMatch(/^[0-9a-f]{32}$/);
    const run = await api(s, port, "POST", `/sessions/${lobby.id}/ai-roles/${TECH}/run`, { reservation, hint: HINT });
    expect(run.json.data).toEqual({ started: true });
    const line = await until("the bot's prompted line", () => am.utterances("BOT-LINE-1")[0]);
    expect(line.roleId).toBe(TECH);
    await until("the spoken prompt intent", () => intentsOf(s, lobby.id).some((e) => e.trigger === "prompt" && e.outcome === "spoken"));
    expect(intentsOf(s, lobby.id).find((e) => e.trigger === "prompt")!.hint).toBe(HINT);
    expect(JSON.stringify(s.provider.calls)).toContain(HINT);
    for (const c of s.cap.humanClients.filter((c) => c !== lobby.fac)) expect(c.text()).not.toContain(HINT);
    expect(s.cap.logs.join("\n")).not.toContain(HINT);
    expect(sessionLog(s, lobby.id).some((e) => JSON.stringify(e).includes(HINT))).toBe(false); // the control-only flow writes no prompt_ai; Task 22's BFF does, without the hint
    expect((await api(s, port, "POST", `/sessions/${lobby.id}/ai-roles/${TECH}/run`, { reservation, hint: HINT })).json.error.code).toBe("ai_expired");
  });

  it("leak scan: no byte of any human player frame, control API response or control log has the bot's code, scenecoach-bot, the bot's participant id or an intent-log line", async () => {
    const s = makeStack(configFor(), newCap());
    const port = await serve(s);
    const lobby = await startedLobby(s);
    const am = lobby.humans.account_manager!;
    const dl = lobby.humans.delivery_lead!;
    await until("the scene", () => am.events("scene.entered").length > 0);
    say(am, "Morning everyone, a quick status before we start.");
    await until("the bot's line", () => am.utterances("BOT-LINE-1")[0] && dl.utterances("BOT-LINE-1")[0]);
    await until("its spoken intent", () => intentsOf(s, lobby.id).some((e) => e.outcome === "spoken"));
    // A rejoining human's snapshot is a human frame too.
    dl.close();
    const snap = await until("delivery_lead to rejoin", async () => {
      const c = await Client.open(lobby.port);
      s.cap.humanClients.push(c);
      c.send({ type: "join", sessionId: lobby.id, roleId: "delivery_lead", participantId: "human-delivery_lead", joinCode: lobby.codes.get("delivery_lead")! });
      await until("an answer", () => c.msgs.some((m) => m.type === "joined" || m.type === "error"));
      if (c.msgs.some((m) => m.type === "joined")) return c;
      c.close();
      return undefined;
    });
    expect(snap.msgs.find((m) => m.type === "joined").state.transcript.some((l: any) => l.text === "BOT-LINE-1")).toBe(true); // the snapshot carries the line too
    await api(s, port, "GET", "/sessions");
    await api(s, port, "GET", `/sessions/${lobby.id}`);
    await api(s, port, "PUT", `/sessions/${lobby.id}/ai-roles`, { roles: [TECH] }).catch(() => undefined); // refused once started: still a response body
    const intents = await api(s, port, "GET", `/sessions/${lobby.id}/ai-roles/${TECH}/intents`);
    expect(intents.status).toBe(200);

    // The markers, each proven present where it belongs.
    const code = botCode(s, lobby.id);
    const state = hostState(s.host, lobby.id)!;
    const pid = state.bots.get(TECH)!.participantId;
    expect(code.length).toBeGreaterThan(3);
    expect(pid).toMatch(/^ai-/);
    const open = s.cap.opens.find((o) => o.roleId === TECH)!;
    expect(open.code).toBe(code); // the code travelled only to the socket's join
    expect(open.participantId).toBe(pid);
    expect(open.key).toBe("scenecoach-bot"); // the literal really is the forwarding key the bot used
    expect(lobby.fac.text()).toContain(pid); // the runtime shows the participant id to the facilitator only
    const intentFile = path.join(s.config.intentsDir, readdirSync(s.config.intentsDir).find((f) => f.endsWith(`.${TECH}.jsonl`))!);
    const intentLines = readFileSync(intentFile, "utf8").split("\n").filter(Boolean);
    expect(intentLines.length).toBeGreaterThan(0);
    expect(intents.text).toContain('"outcome":"spoken"'); // the facilitator-facing intents route does show the entries
    const markers = [code, "scenecoach-bot", pid, ...intentLines];
    const found = (haystack: string): string[] => markers.filter((m) => haystack.includes(m));
    expect(found(`x${code}y scenecoach-bot ${pid} ${intentLines[0]}`)).toHaveLength(markers.length); // the scanner does detect each

    const childLogs = readdirSync(s.config.logDir).map((f) => readFileSync(path.join(s.config.logDir, f), "utf8"));
    expect(childLogs.join("").length).toBeGreaterThan(0);
    const humanFrames = s.cap.humanClients.filter((c) => c !== lobby.fac).map((c) => c.text());
    expect(humanFrames.every((t) => t.length > 0)).toBe(true);
    for (const frames of humanFrames) expect(found(frames)).toEqual([]);
    for (const body of s.cap.apiBodies) expect(found(body)).toEqual([]);
    expect(s.cap.apiBodies.length).toBeGreaterThan(2);
    // The intents body is the facilitator's own view: it is shown the entries, but neither the code, the forwarding key nor the participant id.
    expect(found(s.cap.intentBodies.join("")).filter((m) => !intentLines.includes(m))).toEqual([]);
    expect(found(s.cap.logs.join("\n"))).toEqual([]);
    expect(s.cap.logs.length).toBeGreaterThan(0);
    for (const log of childLogs) expect(found(log)).toEqual([]);
    expect(existsSync(s.config.logDir)).toBe(true);
  });
});
