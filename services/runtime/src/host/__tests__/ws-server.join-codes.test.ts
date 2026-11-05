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
import { SessionHost } from "../session-host.js";
import { startServer } from "../ws-server.js";
import { AuthThrottle, type Limits } from "../security.js";
// Real-socket tests: a generous explicit limit (coverage and a loaded machine are slower). Nothing here measures elapsed time.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

class CountingThrottle extends AuthThrottle {
  calls = 0;
  scopes: string[] = [];
  override fail(ip: string, scope = ""): void { this.calls++; this.scopes.push(scope); super.fail(ip, scope); }
}

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");
const TOKEN = "correct-horse-battery-staple-0123456789";
let server: Awaited<ReturnType<typeof startServer>> | null = null;
let sockets: WebSocket[] = [];
let logs: string[] = [];
afterEach(async () => {
  for (const s of sockets) s.terminate();
  sockets = []; logs = [];
  await server?.close(); server = null;
});

type Client = { ws: WebSocket; inbox: any[]; raw: string[]; closed: Promise<number>; send(m: unknown): void; next(pred: (m: any) => boolean): Promise<any> };
async function open(port: number, headers: Record<string, string> = {}): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
  sockets.push(ws);
  const inbox: any[] = []; const raw: string[] = [];
  const waiters: { pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  ws.on("error", () => {});
  ws.on("message", (d) => { raw.push(d.toString()); const m = JSON.parse(d.toString()); inbox.push(m); for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); } });
  const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
  // Waits for the effect itself; the test's own timeout is the only guard against a hung server.
  const next = (pred: (m: any) => boolean) => new Promise<any>((resolve) => { const found = inbox.find(pred); if (found) return resolve(found); waiters.push({ pred, resolve }); });
  await new Promise<void>((resolve, reject) => { ws.once("open", () => resolve()); ws.once("error", reject); });
  return { ws, inbox, raw, closed, next, send: (m) => ws.send(JSON.stringify(m)) };
}

async function setup(o: { token?: string; limits?: Partial<Limits>; authThrottle?: AuthThrottle; trustProxy?: boolean; codes?: boolean; extraPlayers?: string[] } = {}) {
  const scenario = await loadScenario(fixture);
  // The fixture has one player role; more are added here (the loaded scenario is a plain object).
  for (const id of o.extraPlayers ?? []) scenario.roles[id] = { id, type: "player", brief: `You are ${id}.`, private_facts: [] } as (typeof scenario.roles)[string];
  const engine = new SessionEngine({ scenario, log: new MemoryEventLog("local"), clock: new FakeClock(0) });
  const host = new SessionHost({ scenario, engine, npcProvider: new MockModelProvider(["Hi!"]), gmProvider: new MockModelProvider(), clock: new FakeClock(0) });
  const { codes, plain } = JoinCodes.issue(["host", ...(o.extraPlayers ?? [])], { sessionId: "local", scenarioSha256: "d".repeat(64) });
  server = await startServer({
    port: 0, hosts: new Map([["local", host]]), log: (m) => logs.push(m), facilitatorToken: o.token, limits: o.limits, authThrottle: o.authThrottle, trustProxy: o.trustProxy,
    ...(o.codes === false ? {} : { joinCodes: new Map([["local", codes]]) }),
  });
  return { port: server.port, host, engine, code: plain.host!, plain };
}

const join = (extra: Record<string, unknown> = {}) => ({ type: "join", sessionId: "local", roleId: "host", participantId: "alice", ...extra });

describe("player join codes (US-0033, AC-0120 / AC-0121)", () => {
  it("test_join_right_code_joins_and_the_code_is_never_echoed_or_logged", async () => {
    const { port, host, code } = await setup();
    const c = await open(port);
    c.send(join({ joinCode: code }));
    const j = await c.next((m) => m.type === "joined");
    expect(j.roleId).toBe("host");
    expect(host.assignments.host).toBe("alice");
    const norm = code.replace(/-/g, "");
    for (const r of c.raw) { expect(r).not.toContain(code); expect(r).not.toContain(norm); }
    expect(logs.join("\n")).not.toContain(norm);
  });

  it("test_join_code_is_accepted_however_it_is_typed", async () => {
    const { port, code } = await setup();
    const c = await open(port);
    c.send(join({ joinCode: ` ${code.toLowerCase().replace(/-/g, " ")} ` }));
    expect((await c.next((m) => m.type === "joined")).roleId).toBe("host");
  });

  it("test_join_missing_empty_or_wrong_code_and_unknown_npc_reserved_roles_and_unknown_session_get_one_generic_refusal_and_a_closed_connection", async () => {
    const throttle = new CountingThrottle({ max: 1_000, windowMs: 60_000, blockMs: 60_000, now: Date.now });
    const { port, host, code } = await setup({ authThrottle: throttle });
    const attempts: Record<string, unknown>[] = [
      {}, { joinCode: "" }, { joinCode: "0000-0000-0000" }, { joinCode: code.slice(0, -1) },
      { roleId: "guest", joinCode: code }, { roleId: "no_such_role", joinCode: code }, { roleId: "facilitator", joinCode: code },
      { roleId: "__proto__", joinCode: code }, { sessionId: "other", joinCode: code },
    ];
    const answers: string[] = [];
    for (const a of attempts) {
      const c = await open(port);
      c.send(join(a));
      const err = await c.next((m) => m.type === "error");
      answers.push(JSON.stringify(err));
      expect(await c.closed).toBe(1008);
      expect(c.inbox.some((m) => m.type === "joined" || m.type === "event")).toBe(false);
    }
    expect(new Set(answers)).toEqual(new Set([JSON.stringify({ type: "error", code: "unauthorized", message: "unauthorized" })]));
    expect(throttle.calls).toBe(attempts.length); // every refusal counts against the address's failed-login budget
    expect(host.assignments).toEqual({});
    expect(logs.filter((l) => l === "player join refused: unauthorized")).toHaveLength(attempts.length);
    expect(logs.join("\n")).not.toContain(code.replace(/-/g, ""));
  });

  it("test_join_a_taken_role_with_a_wrong_code_answers_exactly_like_a_free_role", async () => {
    const { port, code } = await setup();
    const holder = await open(port);
    holder.send(join({ joinCode: code }));
    await holder.next((m) => m.type === "joined");
    const probe = await open(port);
    probe.send(join({ participantId: "mallory", joinCode: "0000-0000-0000" }));
    expect(await probe.next((m) => m.type === "error")).toEqual({ type: "error", code: "unauthorized", message: "unauthorized" });
    expect(holder.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("test_join_repeated_wrong_codes_block_that_role_at_that_address_and_not_the_handshake_or_another_address", async () => {
    const { port, code } = await setup({ limits: { maxAuthFailures: 2 }, trustProxy: true });
    for (let i = 0; i < 3; i++) {
      const c = await open(port, { "x-forwarded-for": "203.0.113.9" });
      c.send(join({ joinCode: `WRNG-000${i}-0000` }));
      await c.closed;
    }
    // The handshake is still open (a player failure no longer blocks the whole address) but the role is refused, even with the right code.
    const blockedRole = await open(port, { "x-forwarded-for": "203.0.113.9" });
    blockedRole.send(join({ joinCode: code }));
    expect((await blockedRole.next((m) => m.type === "error")).code).toBe("unauthorized");
    expect(await blockedRole.closed).toBe(1008);
    const other = await open(port, { "x-forwarded-for": "203.0.113.10" });
    other.send(join({ joinCode: code }));
    expect((await other.next((m) => m.type === "joined")).roleId).toBe("host");
  });

  it("test_join_six_wrong_codes_for_one_role_do_not_refuse_another_role_from_the_same_address", async () => {
    const { port, plain } = await setup({ extraPlayers: ["p2"] });
    for (let i = 0; i < 6; i++) {
      const c = await open(port);
      c.send(join({ joinCode: `WRNG-000${i}-0000` }));
      await c.closed;
    }
    const ok = await open(port); // the handshake is not blocked either
    ok.send(join({ roleId: "p2", participantId: "bob", joinCode: plain.p2! }));
    expect((await ok.next((m) => m.type === "joined")).roleId).toBe("p2");
  });

  it("test_join_nine_players_join_from_one_address_when_the_per_address_cap_allows_it", async () => {
    const ids = Array.from({ length: 9 }, (_, i) => `p${i + 1}`);
    const { port, plain } = await setup({ extraPlayers: ids, limits: { maxConnectionsPerIp: 64 } });
    const clients: Client[] = [];
    for (const id of ids) {
      const c = await open(port);
      c.send(join({ roleId: id, participantId: `u-${id}`, joinCode: plain[id]! }));
      expect((await c.next((m) => m.type === "joined")).roleId).toBe(id);
      clients.push(c);
    }
    expect(clients.every((c) => c.ws.readyState === WebSocket.OPEN)).toBe(true);
  });

  it("test_join_a_blocked_address_and_role_is_refused_with_the_same_unauthorized_without_checking_the_code", async () => {
    let t = 0;
    const throttle = new CountingThrottle({ max: 2, windowMs: 60_000, blockMs: 60_000, now: () => t });
    const { port, code } = await setup({ authThrottle: throttle });
    for (let i = 0; i < 3; i++) {
      const c = await open(port);
      c.send(join({ joinCode: `WRNG-000${i}-0000` }));
      await c.closed;
    }
    const spy = vi.spyOn(JoinCodes.prototype, "verify");
    try {
      const c = await open(port);
      c.send(join({ joinCode: code }));
      expect(await c.next((m) => m.type === "error")).toEqual({ type: "error", code: "unauthorized", message: "unauthorized" });
      expect(await c.closed).toBe(1008);
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
    t += 60_000; // the block has run out: the right code joins
    const d = await open(port);
    d.send(join({ joinCode: code }));
    expect((await d.next((m) => m.type === "joined")).roleId).toBe("host");
  });

  it("the block on an (address, role) expires after blockMs even though attempts kept arriving during it", async () => {
    let t = 0;
    const throttle = new CountingThrottle({ max: 2, windowMs: 60_000, blockMs: 60_000, now: () => t });
    const { port, code } = await setup({ authThrottle: throttle });
    for (let i = 0; i < 3; i++) {
      const c = await open(port);
      c.send(join({ joinCode: `WRNG-000${i}-0000` }));
      await c.closed;
    }
    expect(throttle.calls).toBe(3); // the third failure starts the block
    t += 30_000;
    // A neighbour on the same address keeps trying during the block: each is refused alike but not charged, so the block is not extended.
    for (let i = 0; i < 4; i++) {
      const c = await open(port);
      c.send(join({ joinCode: i % 2 ? code : "0000-0000-0000" }));
      expect(await c.next((m) => m.type === "error")).toEqual({ type: "error", code: "unauthorized", message: "unauthorized" });
      expect(await c.closed).toBe(1008);
    }
    expect(throttle.calls).toBe(3);
    t += 30_000; // blockMs after the block began
    const d = await open(port);
    d.send(join({ joinCode: code }));
    expect((await d.next((m) => m.type === "joined")).roleId).toBe("host");
  });

  it("test_join_an_unknown_role_id_is_counted_under_player_star_and_cannot_fill_the_map", async () => {
    const throttle = new CountingThrottle({ max: 1_000, windowMs: 60_000, blockMs: 60_000, now: Date.now });
    const { port, code } = await setup({ authThrottle: throttle });
    for (let i = 0; i < 8; i++) {
      const c = await open(port);
      c.send(join({ roleId: `made_up_${i}`, joinCode: code }));
      await c.closed;
    }
    const known = await open(port);
    known.send(join({ joinCode: "0000-0000-0000" }));
    await known.closed;
    expect(throttle.scopes).toEqual([...Array(8).fill("player:*"), "player:host"]);
    expect(throttle.size()).toBe(2);
  });

  it("test_join_frames_queued_after_a_refusal_are_dropped_and_charged_at_most_once_more", async () => {
    const throttle = new CountingThrottle({ max: 1_000, windowMs: 60_000, blockMs: 60_000, now: Date.now });
    const { port, host } = await setup({ authThrottle: throttle });
    const c = await open(port);
    const frames = Array.from({ length: 20 }, () => JSON.stringify(join({ joinCode: "0000-0000-0000" }))).join("\u0000");
    for (const f of frames.split("\u0000")) c.ws.send(f);
    await c.closed;
    expect(throttle.calls).toBeGreaterThanOrEqual(1);
    expect(throttle.calls).toBeLessThanOrEqual(2);
    expect(c.inbox.filter((m) => m.type === "error")).toHaveLength(1);
    expect(host.assignments).toEqual({});
  });

  it("test_join_unknown_session_costs_the_same_digest_work_review_M2", async () => {
    const { port, code } = await setup();
    const spy = vi.spyOn(JoinCodes.prototype, "verify");
    try {
      const c = await open(port);
      c.send(join({ sessionId: "other", joinCode: code }));
      expect((await c.next((m) => m.type === "error")).code).toBe("unauthorized");
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.instances[0]).toBe(JoinCodes.none());
    } finally { spy.mockRestore(); }
  });

  it("test_join_over_long_code_is_a_malformed_message_and_not_echoed", async () => {
    const { port } = await setup();
    const c = await open(port);
    c.send(join({ joinCode: "Q".repeat(65) }));
    const err = await c.next((m) => m.type === "error");
    expect(err.code).toBe("bad_message");
    expect(c.raw.join("")).not.toContain("QQQQ");
  });
});

describe("join codes and the other credentials (AC-0122)", () => {
  it("test_reconnect_token_still_takes_over_a_live_role_and_the_code_alone_does_not", async () => {
    const { port, host, code } = await setup();
    const a = await open(port);
    a.send(join({ joinCode: code }));
    const j = await a.next((m) => m.type === "joined");
    // Someone else holding the code (it was shared) cannot take a live role without the reconnect token.
    const b = await open(port);
    b.send(join({ participantId: "mallory", joinCode: code }));
    expect((await b.next((m) => m.type === "error")).code).toBe("role_taken");
    expect(host.assignments.host).toBe("alice");
    // The rightful player rejoins on a new connection with the reconnect token, without retyping the code.
    const a2 = await open(port);
    a2.send(join({ reconnectToken: j.reconnectToken }));
    expect((await a2.next((m) => m.type === "joined")).roleId).toBe("host");
    expect(await a.closed).not.toBe(1008); // the old socket was terminated by the takeover, not refused
  });

  it("test_reconnect_token_alone_does_not_open_a_role_nobody_holds", async () => {
    const { port, code } = await setup();
    const a = await open(port);
    a.send(join({ joinCode: code }));
    const j = await a.next((m) => m.type === "joined");
    a.ws.close(); await a.closed;
    const b = await open(port);
    b.send(join({ reconnectToken: j.reconnectToken }));
    expect(await b.next((m) => m.type === "error")).toEqual({ type: "error", code: "unauthorized", message: "unauthorized" });
    const c = await open(port);
    c.send(join({ joinCode: code }));
    expect((await c.next((m) => m.type === "joined")).roleId).toBe("host"); // the code still opens it after the disconnect
  });

  it("test_facilitator_token_and_join_codes_are_separate_credentials", async () => {
    const { port, code } = await setup({ token: TOKEN });
    const f = await open(port);
    f.send({ type: "join_facilitator", sessionId: "local", token: code });
    expect((await f.next((m) => m.type === "error")).code).toBe("unauthorized");
    const p = await open(port);
    p.send(join({ joinCode: TOKEN }));
    expect((await p.next((m) => m.type === "error")).code).toBe("unauthorized");
    const f2 = await open(port);
    f2.send({ type: "join_facilitator", sessionId: "local", token: TOKEN });
    expect((await f2.next((m) => m.type === "joined")).roleId).toBe("facilitator");
    const p2 = await open(port);
    p2.send(join({ joinCode: code }));
    expect((await p2.next((m) => m.type === "joined")).roleId).toBe("host");
  });

  it("test_without_join_codes_configured_the_previous_behaviour_is_unchanged", async () => {
    const { port } = await setup({ codes: false });
    const c = await open(port);
    c.send(join());
    expect((await c.next((m) => m.type === "joined")).roleId).toBe("host");
    const d = await open(port);
    d.send(join({ roleId: "guest" }));
    expect((await d.next((m) => m.type === "error")).code).toBe("npc_role");
  });
});
