import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { loadScenario, type NpcRole } from "@acr/script";
import { MockModelProvider, type ChatRequest, type ModelProvider } from "@acr/adapters";
import type { SessionEvent } from "@acr/events";
import { SessionEngine } from "../../engine/session-engine.js";
import { MemoryEventLog } from "../../engine/event-log.js";
import { FakeClock } from "../../engine/clock.js";
import { SessionHost } from "../session-host.js";
import { startServer } from "../ws-server.js";
import { stampNonce } from "../../demo/harness.js";
import { earnedCheckOf } from "../../agents/gm-prompt.js";
// Real-socket test: a generous explicit limit (a loaded machine or coverage can be several times slower). Nothing here measures elapsed time.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

// US-0034 (AC-0124): a Game Master release suggestion reaches the facilitator only, over the real server.
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");
const FACT = "Sam is leaving the company next month";
const EARNED = "the host asks whether Sam plans to stay";
let server: Awaited<ReturnType<typeof startServer>> | null = null;
let sockets: WebSocket[] = [];
afterEach(async () => { for (const s of sockets) s.terminate(); sockets = []; await server?.close(); server = null; });

type Client = { inbox: any[]; next(pred: (m: any) => boolean): Promise<any>; send(m: unknown): void };
async function open(port: number): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(ws);
  const inbox: any[] = [];
  ws.on("error", () => {});
  ws.on("message", (d) => { inbox.push(JSON.parse(d.toString())); });
  await new Promise<void>((r) => ws.once("open", () => r()));
  const next = async (pred: (m: any) => boolean) => { await vi.waitFor(() => { expect(inbox.some(pred)).toBe(true); }, { timeout: 30_000, interval: 5 }); return inbox.find(pred); };
  return { inbox, next, send: (m) => ws.send(JSON.stringify(m)) };
}

/** Exit-condition prompts answer false; an earned_when check answers true. */
const gmModel = (): ModelProvider & { calls: ChatRequest[] } => {
  const calls: ChatRequest[] = [];
  return { name: "routed", calls, async *stream(req) { calls.push(req); yield earnedCheckOf(req) ? '{"reasoning": "asked", "verdict": true}' : '{"reasoning": "no", "verdict": false}'; } };
};

async function setup(autoRelease = false) {
  const scenario = await loadScenario(fixture);
  (scenario.roles["guest"] as NpcRole).earned_when = { "1": EARNED };
  const engine = new SessionEngine({ scenario, log: new MemoryEventLog("local"), clock: new FakeClock(0) });
  const gm = gmModel();
  const host = new SessionHost({ scenario, engine, npcProvider: new MockModelProvider(["Hi!", "Sure."]), gmProvider: stampNonce(gm), clock: new FakeClock(0), gmEveryN: 1, gmAutoRelease: autoRelease });
  server = await startServer({ port: 0, hosts: new Map([["local", host]]), log: () => {} });
  return { engine, host, gm, port: server.port };
}

describe("a Game Master release suggestion over the WebSocket server (US-0034)", () => {
  it("the facilitator gets one gm.fact_earned by role and number; a player gets neither it nor the fact, the condition or the suggestion state", async () => {
    const { engine, host, port } = await setup();
    const fac = await open(port);
    fac.send({ type: "join_facilitator", sessionId: "local" });
    await fac.next((m) => m.type === "joined");
    const player = await open(port);
    player.send({ type: "join", sessionId: "local", roleId: "host", participantId: "p1" });
    const first = await player.next((m) => m.type === "joined");
    fac.send({ type: "start" });
    await player.next((m) => m.type === "event" && m.event.type === "scene.entered");
    player.send({ type: "say", text: "Sam, are you planning to stay?" });
    const got = await fac.next((m) => m.type === "event" && m.event.type === "gm.fact_earned");
    expect(got.event).toMatchObject({ roleId: "guest", fact: 1, sceneId: "s1_open" });
    expect(JSON.stringify(got.event)).not.toContain(FACT);
    await host.idle();
    // A later event every participant sees: once the player has it, it has everything before it (one ordered stream per connection).
    await engine.command({ command: "pause" });
    const pause = (await fac.next((m) => m.type === "event" && m.event.type === "facilitator.command" && m.event.command === "pause")).event as SessionEvent;
    await player.next((m) => m.type === "event" && m.event.seq === pause.seq);
    expect(fac.inbox.filter((m) => m.type === "event" && m.event.type === "gm.fact_earned")).toHaveLength(1);
    const seen = JSON.stringify(player.inbox);
    expect(player.inbox.some((m) => m.type === "event" && m.event.type === "gm.fact_earned")).toBe(false);
    expect(seen).not.toContain(FACT);
    expect(seen).not.toContain(EARNED);
    // A rejoining player's snapshot carries no suggestion state; the facilitator's does.
    const again = await open(port);
    again.send({ type: "join", sessionId: "local", roleId: "host", participantId: "p1", reconnectToken: first.reconnectToken });
    const pj = await again.next((m) => m.type === "joined" || m.type === "error");
    expect(pj.type).toBe("joined");
    expect(pj.state.factsEarned).toEqual({});
    const fac2 = await open(port);
    fac2.send({ type: "join_facilitator", sessionId: "local" });
    expect((await fac2.next((m) => m.type === "joined")).state.factsEarned).toEqual({ guest: [1] });
  });

  it("with GM_AUTO_RELEASE the facilitator sees the Game Master's release; the player never sees the fact", async () => {
    const { engine, host, port } = await setup(true);
    expect(host.gmAutoRelease).toBe(true);
    const fac = await open(port);
    fac.send({ type: "join_facilitator", sessionId: "local" });
    await fac.next((m) => m.type === "joined");
    const player = await open(port);
    player.send({ type: "join", sessionId: "local", roleId: "host", participantId: "p1" });
    await player.next((m) => m.type === "joined");
    fac.send({ type: "start" });
    await player.next((m) => m.type === "event" && m.event.type === "scene.entered");
    player.send({ type: "say", text: "Sam, are you planning to stay?" });
    await fac.next((m) => m.type === "event" && m.event.type === "gm.fact_earned" && m.event.autoRelease === true);
    await fac.next((m) => m.type === "event" && m.event.type === "npc.updated" && (m.event.released ?? []).includes(FACT));
    await host.idle();
    await engine.command({ command: "pause" });
    const pause = (await fac.next((m) => m.type === "event" && m.event.type === "facilitator.command" && m.event.command === "pause")).event as SessionEvent;
    await player.next((m) => m.type === "event" && m.event.seq === pause.seq);
    expect(JSON.stringify(player.inbox)).not.toContain(FACT);
    expect(player.inbox.some((m) => m.type === "event" && ["gm.fact_earned", "npc.updated"].includes(m.event.type))).toBe(false);
  });

  it("viewFor denies gm.fact_earned to every player role", async () => {
    const { host } = await setup();
    expect(host.gmAutoRelease).toBe(false);
    const e: SessionEvent = { seq: 9, ts: 0, sessionId: "local", type: "gm.fact_earned", sceneId: "s1_open", roleId: "guest", fact: 1, reasoning: "r" };
    expect(host.viewFor("host", e)).toBeNull();
    expect(host.viewFor("guest", e)).toBeNull();
    expect(host.viewFor("facilitator", e)).toBe(e);
  });
});
