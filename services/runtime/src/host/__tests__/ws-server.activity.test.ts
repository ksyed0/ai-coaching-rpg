import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { loadScenario } from "@acr/script";
import type { ChatRequest, ModelProvider } from "@acr/adapters";
import { MockModelProvider } from "@acr/adapters";
import { SessionEngine } from "../../engine/session-engine.js";
import { MemoryEventLog } from "../../engine/event-log.js";
import { FakeClock } from "../../engine/clock.js";
import { JoinCodes } from "../../engine/join-codes.js";
import { PlayerCredentials } from "../../engine/credentials.js";
import { ConsentStore } from "../../engine/consent.js";
import { AiRoleSet } from "../../engine/ai-roles.js";
import type { Seats } from "../../engine/seats.js";
import { SessionHost } from "../session-host.js";
import { startServer } from "../ws-server.js";

// US-0082 (AC-0480 to AC-0483, AC-0486, AC-0487): the transient `activity` frame over real sockets. It is never an event and never in the
// log; a player sees it only for a role of the scene it shares; the facilitator sees every one, with the outcome; only an AI seat may report.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const friday = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../scenarios/friday-escalation");
const BIND = { sessionId: "local", scenarioSha256: "d".repeat(64) };
const NOTICE = { version: "v2", text: "What we record and why." };
const PLAYERS = ["account_manager", "delivery_lead", "tech_lead"];
let server: Awaited<ReturnType<typeof startServer>> | null = null;
let sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets) s.terminate();
  sockets = [];
  await server?.close(); server = null;
});

/** An AI character provider that holds each reply until the test releases it, so the "thinking" window is the test's to control. */
class GatedProvider implements ModelProvider {
  readonly name = "gated";
  readonly calls: ChatRequest[] = [];
  private gates: (() => void)[] = [];
  constructor(private readonly reply: string) {}
  async *stream(req: ChatRequest): AsyncIterable<string> {
    this.calls.push(req);
    await new Promise<void>((r) => this.gates.push(r));
    yield this.reply;
  }
  get waiting(): number { return this.gates.length; }
  release(): void { this.gates.shift()?.(); }
}

type Client = { inbox: any[]; send(m: unknown): void; next(pred: (m: any) => boolean): Promise<any> };
async function open(port: number): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(ws);
  const inbox: any[] = [];
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  ws.on("error", () => {});
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); inbox.push(m); for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); } });
  const next = (pred: (m: any) => boolean) => new Promise<any>((resolve) => { const found = inbox.find(pred); if (found) return resolve(found); waiters.push({ pred, resolve }); });
  await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
  return { inbox, next, send: (m) => ws.send(JSON.stringify(m)) };
}

async function started(reply = "Thanks, noted.") {
  const scenario = await loadScenario(friday);
  const clock = new FakeClock(7_000);
  const log = new MemoryEventLog("local");
  const engine = new SessionEngine({ scenario, log, clock });
  const aiRoles = AiRoleSet.fromRecord({ v: 1, ...BIND, roles: ["tech_lead"] }, { ...BIND, roleIds: PLAYERS });
  const seats: Seats = { credentials: PlayerCredentials.create(BIND), consent: new ConsentStore(NOTICE), aiRoles, persist: vi.fn() };
  const npc = new GatedProvider(reply);
  const host = new SessionHost({ scenario, engine, npcProvider: npc, gmProvider: new MockModelProvider(), clock, seats, gmEveryN: 1_000 });
  const { codes, plain } = JoinCodes.issue(PLAYERS, BIND);
  server = await startServer({ port: 0, hosts: new Map([["local", host]]), joinCodes: new Map([["local", codes]]) });
  const port = server.port;
  const seat = async (roleId: string, participantId: string, displayName?: string) => {
    const c = await open(port);
    c.send({ type: "join", sessionId: "local", roleId, participantId, joinCode: plain[roleId], issueCredential: true, ...(displayName ? { displayName } : {}) });
    return { c, j: await c.next((m) => m.type === "joined") };
  };
  const consent = async (c: Client, roleId: string, pid: string) => {
    c.send({ type: "consent", noticeVersion: "v2" });
    await vi.waitFor(() => expect(seats.consent.has(roleId, pid)).toBe(true), { timeout: 30_000, interval: 5 });
  };
  const a = await seat("account_manager", "alice", "Alice"); await consent(a.c, "account_manager", "alice");
  const d = await seat("delivery_lead", "dana", "Dana"); await consent(d.c, "delivery_lead", "dana");
  const bot = await seat("tech_lead", "bot1");
  const f = await open(port);
  f.send({ type: "join_facilitator", sessionId: "local" });
  await f.next((m) => m.type === "joined");
  f.send({ type: "start" });
  await d.c.next((m) => m.type === "event" && m.event.type === "session.started");
  await d.c.next((m) => m.type === "event" && m.event.type === "scene.entered");
  return { port, host, engine, log, npc, a, d, bot, f, seat };
}

const activities = (c: Client) => c.inbox.filter((m) => m.type === "activity");

describe("activity frames (US-0082)", () => {
  it("test_activity_npc_thinking_reaches_scene_players_and_facilitator_only_and_never_the_log", async () => {
    const s = await started();
    // Scene 2: delivery_lead, account_manager and the AI character client_sponsor; the AI player tech_lead is NOT in it.
    await s.host.command({ command: "advance" }); await s.engine.tick();
    await s.d.c.next((m) => m.type === "event" && m.event.type === "scene.entered" && m.event.sceneId === "s2_client_call");
    s.d.c.send({ type: "say", text: "Hello Priya" });
    const thinking = await s.d.c.next((m) => m.type === "activity" && m.state === "thinking");
    expect(thinking).toEqual({ type: "activity", roleId: "client_sponsor", state: "thinking" });
    await s.a.c.next((m) => m.type === "activity" && m.state === "thinking");
    await s.f.next((m) => m.type === "activity" && m.state === "thinking");
    // A viewer that joins mid-turn is told at once (after its joined).
    const late = await open(s.port);
    late.send({ type: "join_facilitator", sessionId: "local" });
    await late.next((m) => m.type === "activity" && m.roleId === "client_sponsor" && m.state === "thinking");

    s.npc.release();
    await s.d.c.next((m) => m.type === "event" && m.event.type === "utterance" && m.event.roleId === "client_sponsor");
    const idle = await s.d.c.next((m) => m.type === "activity" && m.state === "idle");
    expect(idle).toEqual({ type: "activity", roleId: "client_sponsor", state: "idle" });
    await s.f.next((m) => m.type === "activity" && m.state === "idle");
    await s.host.idle();

    // The AI player's seat is not in scene 2: it never learns that someone there is thinking.
    expect(activities(s.bot.c)).toEqual([]);
    // Never an event, never in the log (mutation check: route the board through engine.alert and this fails).
    const logged = JSON.stringify(await s.log.all());
    expect(logged).not.toContain("activity");
    expect(logged).not.toContain("thinking");
    expect(s.d.c.inbox.filter((m) => m.type === "event").every((m) => typeof m.event.seq === "number")).toBe(true);
  });

  it("test_activity_bot_reports_reach_the_scene_with_the_outcome_for_the_facilitator_only", async () => {
    const s = await started();
    // Scene 1: delivery_lead, tech_lead (AI player), account_manager.
    expect(s.bot.j.activity).toBe(true);
    expect(s.d.j.activity).toBeUndefined();
    s.bot.c.send({ type: "activity", state: "thinking" });
    expect(await s.d.c.next((m) => m.type === "activity" && m.state === "thinking")).toEqual({ type: "activity", roleId: "tech_lead", state: "thinking" });
    await s.f.next((m) => m.type === "activity" && m.roleId === "tech_lead" && m.state === "thinking");
    s.bot.c.send({ type: "activity", state: "idle", outcome: "timed_out" });
    expect(await s.f.next((m) => m.type === "activity" && m.state === "idle")).toEqual({ type: "activity", roleId: "tech_lead", state: "idle", outcome: "timed_out" });
    expect(await s.d.c.next((m) => m.type === "activity" && m.state === "idle")).toEqual({ type: "activity", roleId: "tech_lead", state: "idle" });
    // A human seat cannot fake one; an unknown key is bad_message (strict).
    s.d.c.send({ type: "activity", state: "thinking" });
    expect((await s.d.c.next((m) => m.type === "error")).code).toBe("forbidden");
    s.bot.c.send({ type: "activity", state: "thinking", roleId: "account_manager" });
    expect((await s.bot.c.next((m) => m.type === "error")).code).toBe("bad_message");
    // A bot whose socket closes is thinking no more.
    s.bot.c.send({ type: "activity", state: "thinking" });
    await vi.waitFor(() => expect(s.host.activityNow()).toEqual(["tech_lead"]), { timeout: 30_000, interval: 5 });
    sockets[2]!.close(); // the bot's socket (third opened)
    await vi.waitFor(() => expect(s.host.activityNow()).toEqual([]), { timeout: 30_000, interval: 5 });
    expect(JSON.stringify(await s.log.all())).not.toContain("activity");
  });

  it("test_say_to_is_recorded_only_for_another_role_of_the_scene", async () => {
    const s = await started();
    s.d.c.send({ type: "say", text: "@Account manager price?", to: "account_manager" });
    const ok = await s.a.c.next((m) => m.type === "event" && m.event.type === "utterance" && m.event.text.endsWith("price?"));
    expect(ok.event.to).toBe("account_manager");
    // Mutation check: an addressee outside the speaker's scene (the AI character of scene 2), the speaker itself and an unknown role are dropped.
    for (const [to, text] of [["client_sponsor", "one"], ["delivery_lead", "two"], ["nobody", "three"], ["__proto__", "four"]] as const) {
      s.d.c.send({ type: "say", text, to });
      const e = await s.a.c.next((m) => m.type === "event" && m.event.type === "utterance" && m.event.text === text);
      expect(Object.hasOwn(e.event, "to"), to).toBe(false);
    }
    const logged = (await s.log.all()).filter((e) => e.type === "utterance");
    expect(logged.filter((e) => Object.hasOwn(e, "to")).map((e) => (e as { to?: string }).to)).toEqual(["account_manager"]);
  });
});
