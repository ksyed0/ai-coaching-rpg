import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { loadScenario } from "@acr/script";
import { MockModelProvider } from "@acr/adapters";
import { SessionEngine } from "../../engine/session-engine.js";
import { MemoryEventLog } from "../../engine/event-log.js";
import { FakeClock } from "../../engine/clock.js";
import { JoinCodes } from "../../engine/join-codes.js";
import { PlayerCredentials } from "../../engine/credentials.js";
import { ConsentStore } from "../../engine/consent.js";
import type { Seats } from "../../engine/seats.js";
import { SessionHost } from "../session-host.js";
import { startServer } from "../ws-server.js";
// Real-socket tests: a generous explicit limit. Nothing here measures elapsed time; waits are on the effect itself.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");
const BIND = { sessionId: "local", scenarioSha256: "d".repeat(64) };
const NOTICE = { version: "v1", text: "What we record and why." };
let server: Awaited<ReturnType<typeof startServer>> | null = null;
let sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets) s.terminate();
  sockets = [];
  await server?.close(); server = null;
});

type Client = { inbox: any[]; closed: Promise<{ code: number; reason: string }>; send(m: unknown): void; next(pred: (m: any) => boolean, from?: number): Promise<any>; rosters(): any[] };
async function open(port: number): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(ws);
  const inbox: any[] = [];
  const waiters: { pred: (m: any) => boolean; from: number; resolve: (m: any) => void }[] = [];
  ws.on("error", () => {});
  const closed = new Promise<{ code: number; reason: string }>((r) => ws.on("close", (c, why) => r({ code: c, reason: why.toString() })));
  ws.on("message", (d) => { const m = JSON.parse(d.toString()); inbox.push(m); for (const w of [...waiters]) if (inbox.length - 1 >= w.from && w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); } });
  const next = (pred: (m: any) => boolean, from = 0) => new Promise<any>((resolve) => { const found = inbox.slice(from).find(pred); if (found) return resolve(found); waiters.push({ pred, from, resolve }); });
  await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
  return { inbox, closed, next, send: (m) => ws.send(JSON.stringify(m)), rosters: () => inbox.filter((m) => m.type === "roster") };
}

async function setup(o: { extraPlayers?: string[] } = {}) {
  const scenario = await loadScenario(fixture);
  for (const id of o.extraPlayers ?? []) scenario.roles[id] = { id, type: "player", brief: `You are ${id}.`, private_facts: [] } as (typeof scenario.roles)[string];
  // A scene only p2 takes part in: its title and goal must never reach the host player.
  scenario.script.scenes.push({ id: "s3_private", title: "PRIVATE-TITLE", goal: "PRIVATE-GOAL", participants: ["p2"], time_box_minutes: 3, exit_when: { any_of: ["facilitator_advance"] } });
  const clock = new FakeClock(7_000);
  const engine = new SessionEngine({ scenario, log: new MemoryEventLog("local"), clock });
  const seats: Seats = { credentials: PlayerCredentials.create(BIND), consent: new ConsentStore(NOTICE), persist: vi.fn() };
  const host = new SessionHost({ scenario, engine, npcProvider: new MockModelProvider(["Hi!"]), gmProvider: new MockModelProvider(), clock, seats });
  const { codes, plain } = JoinCodes.issue(["host", ...(o.extraPlayers ?? [])], BIND);
  server = await startServer({ port: 0, hosts: new Map([["local", host]]), joinCodes: new Map([["local", codes]]), log: () => {} });
  return { port: server.port, plain };
}

async function player(port: number, roleId: string, code: string) {
  const c = await open(port);
  c.send({ type: "join", sessionId: "local", roleId, participantId: `pid-${roleId}`, joinCode: code, issueCredential: true, displayName: "Name" });
  return { c, j: await c.next((m) => m.type === "joined") };
}

describe("joined.scenes (US-0055)", () => {
  it("joined lists only the scenes the player takes part in", async () => {
    const { port, plain } = await setup({ extraPlayers: ["p2"] });
    const a = await player(port, "host", plain.host!);
    expect(a.j.scenes).toEqual([
      { id: "s1_open", title: "Opening", goal: "Exchange greetings", timeBoxMinutes: 2 },
      { id: "s2_close", title: "Close", goal: "Say goodbye", timeBoxMinutes: 1 },
    ]);
    const b = await player(port, "p2", plain.p2!);
    expect(b.j.scenes).toEqual([{ id: "s3_private", title: "PRIVATE-TITLE", goal: "PRIVATE-GOAL", timeBoxMinutes: 3 }]);
  });

  it("the facilitator joined has no scenes", async () => {
    const { port } = await setup({ extraPlayers: ["p2"] });
    const f = await open(port);
    f.send({ type: "join_facilitator", sessionId: "local" });
    expect(await f.next((m) => m.type === "joined")).not.toHaveProperty("scenes");
  });

  it("a scene the player is not in leaks neither title nor goal anywhere in the player's frames", async () => {
    const { port, plain } = await setup({ extraPlayers: ["p2"] });
    const a = await player(port, "host", plain.host!);
    await a.c.next((m) => m.type === "roster");
    const all = JSON.stringify(a.c.inbox);
    expect(all).not.toContain("PRIVATE-TITLE");
    expect(all).not.toContain("PRIVATE-GOAL");
  });
});
