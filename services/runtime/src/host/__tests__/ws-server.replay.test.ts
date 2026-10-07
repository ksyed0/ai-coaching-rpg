import { afterEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { MockModelProvider } from "@acr/adapters";
import type { SessionEvent } from "@acr/events";
import { loadScenario } from "@acr/script";
import { FakeClock } from "../../engine/clock.js";
import { MemoryEventLog } from "../../engine/event-log.js";
import { JoinCodes } from "../../engine/join-codes.js";
import { SessionEngine } from "../../engine/session-engine.js";
import { AuthThrottle } from "../security.js";
import { SessionHost } from "../session-host.js";
import { startServer } from "../ws-server.js";
// Real-socket tests: a generous explicit limit. Nothing here measures elapsed time; waits are on the effect itself.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const friday = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../scenarios/friday-escalation");
const PLAYERS = ["delivery_lead", "tech_lead", "account_manager"];
const TOKEN = "correct-horse-battery-staple-0123456789";
let server: Awaited<ReturnType<typeof startServer>> | null = null;
let sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets) s.terminate();
  sockets = [];
  await server?.close(); server = null;
});

class CountingThrottle extends AuthThrottle {
  calls = 0;
  override fail(ip: string): void { this.calls++; super.fail(ip); }
}

type Client = { inbox: any[]; closed: Promise<number>; send(m: unknown): void; sendRaw(s: string): void; next(pred: (m: any) => boolean, from?: number): Promise<any>; events(from?: number): SessionEvent[] };
async function open(port: number): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  sockets.push(ws);
  const inbox: any[] = [];
  const waiters: { pred: (m: any) => boolean; from: number; resolve: (m: any) => void }[] = [];
  ws.on("error", () => {});
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString()); const i = inbox.push(m) - 1;
    for (const w of [...waiters]) if (i >= w.from && w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
  const next = (pred: (m: any) => boolean, from = 0) => new Promise<any>((resolve) => { const hit = inbox.slice(from).find(pred); if (hit) return resolve(hit); waiters.push({ pred, from, resolve }); });
  await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
  return { inbox, closed, next, send: (m) => ws.send(JSON.stringify(m)), sendRaw: (s) => ws.send(s), events: (from = 0) => inbox.slice(from).filter((m) => m.type === "event").map((m) => m.event) };
}

async function setup(o: { token?: string; retainEvents?: number; authThrottle?: AuthThrottle } = {}) {
  const scenario = await loadScenario(friday);
  const clock = new FakeClock(1_000);
  const engine = new SessionEngine({ scenario, log: new MemoryEventLog("local"), clock, retainEvents: o.retainEvents });
  const host = new SessionHost({ scenario, engine, npcProvider: new MockModelProvider([]), gmProvider: new MockModelProvider([]), clock });
  const { codes, plain } = JoinCodes.issue(PLAYERS, { sessionId: "local", scenarioSha256: "d".repeat(64) });
  server = await startServer({ port: 0, hosts: new Map([["local", host]]), facilitatorToken: o.token, authThrottle: o.authThrottle, joinCodes: new Map([["local", codes]]) });
  // What each viewer may see, recorded live from the first event through the server's own filter.
  const live: Record<string, SessionEvent[]> = Object.fromEntries([...PLAYERS, "facilitator"].map((v) => [v, []]));
  for (const v of Object.keys(live)) host.subscribe((e) => { const view = host.viewFor(v, e); if (view) live[v]!.push(view); });
  return { port: server.port, host, engine, clock, plain, live };
}

const join = (role: string, code: string | undefined, extra: Record<string, unknown> = {}) => ({ type: "join", sessionId: "local", roleId: role, participantId: `${role}-person`, ...(code ? { joinCode: code } : {}), ...extra });
const isJoined = (m: any) => m.type === "joined" || m.type === "error";

/** Plays a little: two scenes, whispers to two different roles, an inject, a released hidden fact, an alert. */
async function play(engine: SessionEngine, host: SessionHost) {
  for (const r of PLAYERS) host.join(r, `${r}-person`);
  await host.start();
  await engine.say("delivery_lead", "first line");
  await engine.command({ command: "whisper", roleId: "tech_lead", text: "ZedForTechLead" });
  await engine.command({ command: "whisper", roleId: "delivery_lead", text: "ZedForDeliveryLead" });
  await engine.alert("ZedFacilitatorAlert", "warning");
  await engine.command({ command: "advance" }); await engine.tick();
  await engine.command({ command: "release_hidden", roleId: "client_sponsor", fact: 1 });
  await engine.say("account_manager", "second scene");
  for (const r of PLAYERS) host.release(r, `${r}-person`);
}

/** A live event after the join: once it has arrived, every replay frame before it has too (frames are in order on one socket). */
async function fence(engine: SessionEngine, c: Client, role: string): Promise<number> {
  await engine.command({ command: "whisper", roleId: role, text: "fence" });
  await c.next((m) => m.type === "event" && m.event.type === "facilitator.command" && m.event.text === "fence");
  return c.inbox.findIndex((m) => m.type === "event" && m.event.text === "fence");
}

describe("replay-from-seq over the WebSocket protocol (US-0013)", () => {
  it("test_join_with_last_seq_gets_the_missed_events_then_live_ones_without_gap_or_duplicate", async () => {
    const { port, engine, host, plain, live } = await setup();
    await play(engine, host);
    const head = engine.state.lastSeq;
    const c = await open(port);
    c.send(join("delivery_lead", plain.delivery_lead, { lastSeq: 2 }));
    const j = await c.next(isJoined);
    expect(j.type).toBe("joined");
    const want = live.delivery_lead!.filter((e) => e.seq > 2);
    expect(j.replay).toEqual({ afterSeq: 2, toSeq: head, events: want.length, complete: true });
    expect(j.state.lastSeq).toBe(head);
    const end = await fence(engine, c, "delivery_lead");
    // joined, then exactly the replay, then the live fence: nothing else in between.
    expect(c.inbox.slice(1, end).map((m) => m.event)).toEqual(want);
    expect(c.inbox[end].event.seq).toBe(head + 1);
    expect(JSON.stringify(c.inbox)).toContain("ZedForDeliveryLead");
    expect(JSON.stringify(c.inbox)).not.toContain("ZedForTechLead");
    expect(JSON.stringify(c.inbox)).not.toContain("ZedFacilitatorAlert");
  });

  it("test_join_without_last_seq_behaves_as_before_no_replay", async () => {
    const { port, engine, host, plain } = await setup();
    await play(engine, host);
    const c = await open(port);
    c.send(join("tech_lead", plain.tech_lead));
    const j = await c.next(isJoined);
    expect(j.type).toBe("joined");
    expect(j.replay).toBeUndefined();
    const end = await fence(engine, c, "tech_lead");
    expect(end).toBe(1); // the first event after joined is the live one
  });

  it("test_events_emitted_while_joining_arrive_exactly_once_in_order", async () => {
    const { port, engine, host, plain, live } = await setup();
    await play(engine, host);
    for (const [i, k] of [0, 3, 6].entries()) {
      const role = PLAYERS[i]!;
      // Events keep being appended while the join is handled: each must be in the replay or live, never both, never neither.
      const c = await open(port);
      // Each append yields to the event loop, so the join frame is handled somewhere in the middle of the burst.
      const burst = (async () => { for (let n = 0; n < 60; n++) { await engine.command({ command: "whisper", roleId: role, text: `burst ${n}` }); await new Promise((r) => setImmediate(r)); } })();
      c.send(join(role, plain[role], { lastSeq: k }));
      const j = await c.next(isJoined);
      expect(j.type).toBe("joined");
      await burst;
      const end = await fence(engine, c, role);
      const got = c.inbox.slice(1, end + 1).map((m) => m.event);
      const want = live[role]!.filter((e) => e.seq > k);
      expect(got.map((e) => e.seq)).toEqual(want.map((e) => e.seq));
      expect(got).toEqual(want);
      expect(j.replay.toSeq).toBe(j.state.lastSeq);
      host.release(role, `${role}-person`);
    }
  });

  it("test_an_append_started_during_the_join_is_delivered_live_exactly_once", async () => {
    const { port, engine, host, plain, live } = await setup();
    await play(engine, host);
    // Deterministic order: an append begins inside the replay itself. It completes only after the join handler's synchronous step,
    // so it must reach the client through the subscription; any await between the replay and the subscribe would lose it.
    const replayFor = host.replayFor.bind(host);
    vi.spyOn(host, "replayFor").mockImplementation((who, after, o) => {
      void engine.command({ command: "whisper", roleId: "delivery_lead", text: "during the join" });
      const r = replayFor(who, after, o);
      void engine.command({ command: "whisper", roleId: "delivery_lead", text: "right after the replay" });
      return r;
    });
    const c = await open(port);
    c.send(join("delivery_lead", plain.delivery_lead, { lastSeq: 1 }));
    const j = await c.next(isJoined);
    const end = await fence(engine, c, "delivery_lead");
    const got = c.inbox.slice(1, end + 1).map((m) => m.event);
    expect(got).toEqual(live.delivery_lead!.filter((e) => e.seq > 1));
    expect(got.filter((e) => e.seq > j.replay.toSeq).map((e) => e.text)).toEqual(["during the join", "right after the replay", "fence"]);
  });

  it("test_last_seq_that_is_not_a_whole_number_is_a_bad_message_and_the_connection_may_still_join", async () => {
    const { port, engine, host, plain } = await setup();
    await play(engine, host);
    const c = await open(port);
    const bad = [-1, 1.5, "3", null, true];
    for (const v of bad) {
      const from = c.inbox.length;
      c.send(join("delivery_lead", plain.delivery_lead, { lastSeq: v }));
      const e = await c.next((m) => m.type === "error", from);
      expect(e.code).toBe("bad_message");
    }
    let from = c.inbox.length;
    c.sendRaw(JSON.stringify(join("delivery_lead", plain.delivery_lead)).replace(/}$/, ',"lastSeq":1e400}')); // Infinity after JSON.parse
    expect((await c.next((m) => m.type === "error", from)).code).toBe("bad_message");
    from = c.inbox.length;
    c.send({ type: "join_facilitator", sessionId: "local", lastSeq: -5 });
    expect((await c.next((m) => m.type === "error", from)).code).toBe("bad_message");
    expect(host.assignments.delivery_lead).toBeUndefined();
    from = c.inbox.length;
    c.send(join("delivery_lead", plain.delivery_lead, { lastSeq: 0 }));
    expect((await c.next(isJoined, from)).type).toBe("joined");
  });

  it("test_last_seq_beyond_the_head_is_a_bad_message_after_authentication_and_claims_nothing", async () => {
    const throttle = new CountingThrottle({ max: 5, windowMs: 60_000, blockMs: 60_000, now: () => 0 });
    const { port, engine, host, plain } = await setup({ authThrottle: throttle });
    await play(engine, host);
    const head = engine.state.lastSeq;
    const c = await open(port);
    c.send(join("delivery_lead", plain.delivery_lead, { lastSeq: head + 1 }));
    const e = await c.next((m) => m.type === "error");
    expect(e).toEqual({ type: "error", code: "bad_message", message: "lastSeq: after the last event of this session" });
    expect(host.assignments.delivery_lead).toBeUndefined();
    expect(throttle.calls).toBe(0); // a valid code was presented: not a failed login
    const from = c.inbox.length;
    c.send(join("delivery_lead", plain.delivery_lead, { lastSeq: head }));
    const j = await c.next(isJoined, from);
    expect(j.replay).toEqual({ afterSeq: head, toSeq: head, events: 0, complete: true });
    // The facilitator too.
    const f = await open(port);
    f.send({ type: "join_facilitator", sessionId: "local", lastSeq: Number.MAX_SAFE_INTEGER });
    expect((await f.next((m) => m.type === "error")).code).toBe("bad_message");
  });

  it("test_a_refused_join_with_last_seq_gets_only_the_generic_refusal", async () => {
    // A throttle that never blocks, so every attempt below reaches the join handler (refusals are still charged).
    const { port, engine, host, plain } = await setup({ token: TOKEN, authThrottle: new AuthThrottle({ max: 1_000, windowMs: 60_000, blockMs: 60_000, now: () => 0 }) });
    await play(engine, host);
    const head = engine.state.lastSeq;
    const generic = { type: "error", code: "unauthorized", message: "unauthorized" };
    const attempts: Record<string, unknown>[] = [
      join("delivery_lead", undefined, { lastSeq: 0 }),
      join("delivery_lead", "0000-0000-0000", { lastSeq: 0 }),
      join("delivery_lead", "0000-0000-0000", { lastSeq: head + 50 }), // auth first: the head is not probed
      join("client_sponsor", plain.delivery_lead, { lastSeq: 0 }),
      { ...join("delivery_lead", plain.delivery_lead, { lastSeq: 0 }), sessionId: "elsewhere" },
      { type: "join_facilitator", sessionId: "local", token: "wrong-token-wrong-token", lastSeq: 0 },
      { type: "join_facilitator", sessionId: "local", lastSeq: head + 50 },
    ];
    for (const m of attempts) {
      const c = await open(port);
      c.send(m);
      expect(await c.closed).toBe(1008);
      expect(c.inbox).toEqual([generic]);
    }
  });

  it("test_a_taken_role_with_last_seq_gets_only_role_taken", async () => {
    const { port, engine, host, plain } = await setup();
    await play(engine, host);
    const holder = await open(port);
    holder.send(join("delivery_lead", plain.delivery_lead));
    expect((await holder.next(isJoined)).type).toBe("joined");
    const c = await open(port);
    c.send(join("delivery_lead", plain.delivery_lead, { lastSeq: 0 }));
    const e = await c.next(isJoined);
    expect(e.code).toBe("role_taken");
    await fence(engine, holder, "delivery_lead");
    expect(c.inbox).toEqual([e]);
  });

  it("test_live_takeover_with_the_reconnect_token_and_last_seq_replays_what_the_old_connection_missed", async () => {
    const { port, engine, host, plain, live } = await setup();
    await play(engine, host);
    const old = await open(port);
    old.send(join("tech_lead", plain.tech_lead));
    const j1 = await old.next(isJoined);
    const seen = j1.state.lastSeq;
    await engine.command({ command: "whisper", roleId: "tech_lead", text: "missed while dropping" });
    await engine.command({ command: "whisper", roleId: "delivery_lead", text: "never for tech_lead" });
    const c = await open(port);
    c.send({ type: "join", sessionId: "local", roleId: "tech_lead", participantId: "tech_lead-person", reconnectToken: j1.reconnectToken, lastSeq: seen });
    const j2 = await c.next(isJoined);
    expect(j2.type).toBe("joined");
    expect(await old.closed).toBe(1006);
    const end = await fence(engine, c, "tech_lead");
    const replayed = c.inbox.slice(1, end).map((m) => m.event);
    expect(replayed).toEqual(live.tech_lead!.filter((e) => e.seq > seen && e.seq <= j2.replay.toSeq));
    expect(replayed.map((e) => e.text)).toEqual(["missed while dropping"]);
  });

  it("test_facilitator_rejoin_with_last_seq_replays_everything_after_it", async () => {
    const { port, engine, host } = await setup({ token: TOKEN });
    await play(engine, host);
    const c = await open(port);
    c.send({ type: "join_facilitator", sessionId: "local", token: TOKEN, lastSeq: 1 });
    const j = await c.next(isJoined);
    expect(j.replay).toEqual({ afterSeq: 1, toSeq: engine.state.lastSeq, events: engine.state.lastSeq - 1, complete: true });
    await fence(engine, c, "tech_lead");
    expect(c.events().map((e) => e.seq)).toEqual(Array.from({ length: engine.state.lastSeq - 1 }, (_, i) => i + 2));
    expect(JSON.stringify(c.inbox)).toContain("ZedFacilitatorAlert");
  });

  it("test_a_client_further_behind_than_the_window_gets_no_partial_replay", async () => {
    const { port, engine, host, plain } = await setup({ retainEvents: 3 });
    await play(engine, host);
    const c = await open(port);
    c.send(join("delivery_lead", plain.delivery_lead, { lastSeq: 0 }));
    const j = await c.next(isJoined);
    expect(j.replay).toEqual({ afterSeq: 0, toSeq: engine.state.lastSeq, events: 0, complete: false });
    expect(j.state.transcript.length).toBeGreaterThan(0); // the snapshot is the fallback
    expect(await fence(engine, c, "delivery_lead")).toBe(1);
  });
});
