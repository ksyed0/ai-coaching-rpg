import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { MAX_QUEUED_FRAMES, RuntimeConnection, RuntimeError } from "../runtime-connection";
import type { ServerMessage } from "../wire";
import { fakeRuntime, manualTimers, until } from "./fakes";

// Real sockets against a scripted runtime: a generous explicit limit; nothing measures elapsed time.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const state = (lastSeq: number) => ({ lastSeq, status: "running", paused: false, pausedSince: null, currentScene: null, transcript: [] });
const ev = (seq: number) => ({ type: "event", event: { seq, ts: seq, type: "facilitator.command", command: "pause" } });
const send = (ws: WebSocket, m: unknown) => ws.send(JSON.stringify(m));
const ids = { sessionId: "s1", roleId: "delivery_lead", participantId: "p-1" };

let stops: (() => Promise<void>)[] = [];
let conns: RuntimeConnection[] = [];
afterEach(async () => {
  for (const c of conns) c.close();
  conns = [];
  for (const s of stops) await s();
  stops = [];
});
async function runtime(onMessage?: (ws: WebSocket, m: any) => void, o?: { status?: number }) {
  const rt = await fakeRuntime(onMessage, o);
  stops.push(rt.stop);
  return rt;
}
async function connect(url: string, o?: Parameters<typeof RuntimeConnection.connect>[2]) {
  const c = await RuntimeConnection.connect(url, "203.0.113.7", o);
  conns.push(c);
  return c;
}
async function rejection(p: Promise<unknown>): Promise<RuntimeError> {
  try { await p; } catch (err) { expect(err).toBeInstanceOf(RuntimeError); return err as RuntimeError; }
  throw new Error("expected a rejection");
}

describe("RuntimeConnection", () => {
  it("joinWithCode returns the credential and passes a lower-case code with spaces and hyphens through unchanged", async () => {
    const rt = await runtime((ws, m) => { if (m.type === "join") send(ws, { type: "joined", roleId: m.roleId, state: state(0), credential: "c".repeat(32), logIdentity: "l1", replay: { afterSeq: 0, toSeq: 0, events: 0, complete: true } }); });
    const c = await connect(rt.url);
    const joined = await c.joinWithCode({ ...ids, joinCode: "abcd - efgh-jk mn", displayName: "Ann" });
    expect(joined.credential).toBe("c".repeat(32));
    expect(rt.received).toEqual([{ type: "join", ...ids, joinCode: "abcd - efgh-jk mn", displayName: "Ann", issueCredential: true, lastSeq: 0 }]);
  });

  it("sends the client address as X-Forwarded-For", async () => {
    const rt = await runtime();
    await connect(rt.url);
    await until(() => rt.headers.length === 1);
    expect(rt.headers[0]!["x-forwarded-for"]).toBe("203.0.113.7");
  });

  it("joinWithCredential sends the credential and lastSeq, and the replay that follows joined reaches a listener added later, in order", async () => {
    const rt = await runtime((ws, m) => {
      if (m.type !== "join") return;
      // Like the runtime: joined with the summary, the replayed events, then the roster, all in one go.
      send(ws, { type: "joined", roleId: m.roleId, state: state(5), replay: { afterSeq: 2, toSeq: 5, events: 2, complete: true } });
      send(ws, ev(3)); send(ws, ev(5));
      send(ws, { type: "roster", audience: "peers", entries: [] });
    });
    const c = await connect(rt.url);
    const joined = await c.joinWithCredential({ ...ids, credential: "k".repeat(32), lastSeq: 2 });
    expect(rt.received[0]).toEqual({ type: "join", ...ids, credential: "k".repeat(32), lastSeq: 2 });
    expect(joined.replay).toEqual({ afterSeq: 2, toSeq: 5, events: 2, complete: true });
    // The frames sent with joined are already parsed when the join resolves (one read); the listener comes later and still gets them in order.
    const seen: ServerMessage[] = [];
    c.onFrame((m) => seen.push(m));
    await until(() => seen.length === 3);
    expect(seen.map((m) => (m.type === "event" ? m.event.seq : m.type))).toEqual([3, 5, "roster"]);
    send(rt.sockets[0]!, ev(6));
    await until(() => seen.length === 4);
    expect(seen[3]).toEqual(ev(6));
  });

  it("joinWithCredential without lastSeq sends none", async () => {
    const rt = await runtime((ws, m) => { if (m.type === "join") send(ws, { type: "joined", roleId: m.roleId, state: state(0) }); });
    const c = await connect(rt.url);
    await c.joinWithCredential({ ...ids, credential: "k".repeat(32) });
    expect(rt.received[0]).toEqual({ type: "join", ...ids, credential: "k".repeat(32) });
  });

  it("a lastSeq past the head is retried once without lastSeq, so the caller gets a snapshot (no replay)", async () => {
    const rt = await runtime((ws, m) => {
      if (m.type !== "join") return;
      if (m.lastSeq !== undefined) send(ws, { type: "error", code: "bad_message", message: "lastSeq: after the last event of this session" });
      else send(ws, { type: "joined", roleId: m.roleId, state: state(4) });
    });
    const c = await connect(rt.url);
    const joined = await c.joinWithCredential({ ...ids, credential: "k".repeat(32), lastSeq: 99 });
    expect(joined.replay).toBeUndefined();
    expect(rt.received.map((m) => m.lastSeq)).toEqual([99, undefined]);
  });

  it.each([
    ["unauthorized", "unauthorized"], ["session_ended", "session_ended"], ["role_taken", "role_taken"], ["bad_message", "bad_message"], ["internal", "internal"],
  ])("an error frame %s rejects the join with code %s, closes the socket and names no secret", async (code, expected) => {
    const rt = await runtime((ws, m) => { if (m.type === "join") send(ws, { type: "error", code, message: code }); });
    const c = await connect(rt.url);
    const err = await rejection(c.joinWithCode({ ...ids, joinCode: "SECRET-CODE", displayName: "Ann" }));
    expect(err.code).toBe(expected);
    expect(err.message).not.toContain("SECRET-CODE");
    expect(err.message).not.toContain("203.0.113.7");
    await rt.closed();
    expect(c.isOpen).toBe(false);
  });

  // A bare 1008 is the runtime's join timeout or queue cap (load), not a refused credential: a later task deletes the cookie on unauthorized.
  it.each([
    [1008, "unauthorized", "unauthorized"], [1008, "join timeout", "unavailable"], [1008, "too many queued messages", "unavailable"],
    [4001, "superseded", "superseded"], [1011, "x", "unavailable"],
  ])("a close %i (%s) before joined rejects with %s", async (closeCode, reason, expected) => {
    const rt = await runtime((ws, m) => { if (m.type === "join") ws.close(closeCode, reason); });
    const c = await connect(rt.url);
    expect((await rejection(c.joinWithCredential({ ...ids, credential: "k".repeat(32) }))).code).toBe(expected);
  });

  it("a join with no answer times out through the injected timer as unavailable", async () => {
    const rt = await runtime();
    const timers = manualTimers();
    const c = await connect(rt.url, { setTimer: timers.setTimer, timeoutMs: 5_000 });
    const p = c.joinWithCredential({ ...ids, credential: "k".repeat(32) });
    await until(() => rt.received.length === 1);
    timers.fire(5_000);
    expect((await rejection(p)).code).toBe("unavailable");
    await rt.closed();
  });

  it("a second join on the same connection is refused", async () => {
    const rt = await runtime((ws, m) => { if (m.type === "join") send(ws, { type: "joined", roleId: m.roleId, state: state(0) }); });
    const c = await connect(rt.url);
    await c.joinWithCredential({ ...ids, credential: "k".repeat(32) });
    expect((await rejection(c.joinWithCredential({ ...ids, credential: "k".repeat(32) }))).code).toBe("already_joined");
  });

  it("a join on a closed connection is refused as unavailable", async () => {
    const rt = await runtime();
    const c = await connect(rt.url);
    c.close();
    expect((await rejection(c.joinWithCredential({ ...ids, credential: "k".repeat(32) }))).code).toBe("unavailable");
  });

  it("connect: a refused connection, a handshake 503 and 429, and a timeout are classified", async () => {
    const gone = await runtime();
    await gone.stop();
    expect((await rejection(RuntimeConnection.connect(gone.url, "a"))).code).toBe("unavailable");
    const busy = await runtime(undefined, { status: 503 });
    expect((await rejection(RuntimeConnection.connect(busy.url, "a"))).code).toBe("unavailable");
    const blocked = await runtime(undefined, { status: 429 });
    expect((await rejection(RuntimeConnection.connect(blocked.url, "a"))).code).toBe("rate_limited");
    // A server that accepts TCP but never answers the upgrade: the injected timer gives up.
    const net = await import("node:net");
    const silent = net.createServer(() => {});
    await new Promise<void>((r) => silent.listen(0, "127.0.0.1", () => r()));
    stops.push(() => new Promise<void>((r) => silent.close(() => r())));
    const timers = manualTimers();
    const p = RuntimeConnection.connect(`ws://127.0.0.1:${(silent.address() as { port: number }).port}`, "a", { setTimer: timers.setTimer, timeoutMs: 7_000 });
    await until(() => timers.live().length === 1);
    timers.fire(7_000);
    expect((await rejection(p)).code).toBe("unavailable");
  });

  it("send, onClose and close: frames reach the runtime, the close code reaches listeners, and close is idempotent", async () => {
    const rt = await runtime((ws, m) => { if (m.type === "join") send(ws, { type: "joined", roleId: m.roleId, state: state(0) }); });
    const c = await connect(rt.url);
    await c.joinWithCredential({ ...ids, credential: "k".repeat(32) });
    c.send({ type: "consent", noticeVersion: "v1" });
    await until(() => rt.received.length === 2);
    expect(rt.received[1]).toEqual({ type: "consent", noticeVersion: "v1" });
    const codes: number[] = [];
    const off = c.onClose((code) => codes.push(code));
    const kept: number[] = [];
    c.onClose((code) => kept.push(code));
    off();
    rt.sockets[0]!.close(4001, "superseded");
    await until(() => kept.length === 1);
    expect(kept).toEqual([4001]);
    expect(codes).toEqual([]);
    // Registered after the close: told at once.
    const late: number[] = [];
    c.onClose((code) => late.push(code));
    expect(late).toEqual([4001]);
    expect(() => c.send({ type: "leave" })).toThrow(RuntimeError);
    c.close(); c.close();
  });

  it("close() closes the socket on the runtime side", async () => {
    const rt = await runtime();
    const c = await connect(rt.url);
    await until(() => rt.sockets.length === 1);
    c.close();
    await rt.closed();
    expect(c.isOpen).toBe(false);
  });

  it("joinOrder records the order in which joins resolved; closeCode the runtime's close code", async () => {
    const rt = await runtime((ws, m) => { if (m.type === "join") send(ws, { type: "joined", roleId: m.roleId, state: state(0) }); });
    const a = await connect(rt.url);
    const b = await connect(rt.url);
    expect(a.joinOrder).toBe(0);
    await b.joinWithCredential({ ...ids, credential: "k".repeat(32) });
    await a.joinWithCredential({ ...ids, credential: "k".repeat(32) });
    expect(a.joinOrder).toBeGreaterThan(b.joinOrder);
    expect(a.closeCode).toBeNull();
    rt.sockets[0]!.close(4001, "superseded");
    await until(() => a.closeCode !== null || b.closeCode !== null);
    expect([a.closeCode, b.closeCode]).toContain(4001);
  });

  it("frames that pile up with nobody listening are bounded: past the cap the socket is dropped", async () => {
    const rt = await runtime((ws, m) => {
      if (m.type !== "join") return;
      send(ws, { type: "joined", roleId: m.roleId, state: state(0) });
      for (let i = 1; i <= MAX_QUEUED_FRAMES + 1; i++) send(ws, ev(i));
    });
    const c = await connect(rt.url);
    await c.joinWithCredential({ ...ids, credential: "k".repeat(32) });
    await until(() => !c.isOpen);
    const seen: ServerMessage[] = [];
    c.onFrame((m) => seen.push(m));
    expect(seen).toEqual([]); // dropped, never delivered half
    // Under the cap nothing is dropped (the replay case).
    const rt2 = await runtime((ws, m) => {
      if (m.type !== "join") return;
      send(ws, { type: "joined", roleId: m.roleId, state: state(0) });
      for (let i = 1; i <= 1000; i++) send(ws, ev(i));
    });
    const c2 = await connect(rt2.url);
    await c2.joinWithCredential({ ...ids, credential: "k".repeat(32) });
    const seen2: ServerMessage[] = [];
    c2.onFrame((m) => seen2.push(m));
    await until(() => seen2.length === 1000);
    expect(c2.isOpen).toBe(true);
  });

  it("frames that are not JSON objects with a type are ignored", async () => {
    const rt = await runtime((ws, m) => { if (m.type === "join") { ws.send("not json"); ws.send("42"); send(ws, { type: "joined", roleId: m.roleId, state: state(0) }); ws.send("null"); send(ws, ev(1)); } });
    const c = await connect(rt.url);
    await c.joinWithCredential({ ...ids, credential: "k".repeat(32) });
    const seen: ServerMessage[] = [];
    const off = c.onFrame((m) => seen.push(m));
    await until(() => seen.length === 1);
    expect(seen).toEqual([ev(1)]);
    off();
  });
});

describe("RuntimeConnection facilitator sockets", () => {
  const fstate = { lastSeq: 0, status: "lobby", paused: false, pausedSince: null, currentScene: null, transcript: [] };
  const entries = [{ roleId: "tech_lead", name: "Ann", joined: true, consented: true, connected: true }, { roleId: "account_manager", joined: false, consented: false, connected: false }];
  const facilitatorRoster = { type: "roster", audience: "facilitator", entries };

  it("a null client address sends no X-Forwarded-For; a string still does", async () => {
    const rt = await runtime();
    conns.push(await RuntimeConnection.connect(rt.url, null));
    conns.push(await RuntimeConnection.connect(rt.url, "203.0.113.9"));
    await until(() => rt.headers.length === 2);
    expect(Object.keys(rt.headers[0]!)).not.toContain("x-forwarded-for");
    expect(rt.headers[1]!["x-forwarded-for"]).toBe("203.0.113.9");
  });

  it("joinFacilitator sends join_facilitator and returns the roster that follows joined, with the status", async () => {
    const rt = await runtime((ws, m) => { if (m.type === "join_facilitator") { send(ws, { type: "joined", roleId: "facilitator", state: fstate }); send(ws, facilitatorRoster); } });
    const c = await connect(rt.url);
    const r = await c.joinFacilitator("s1", "tok");
    expect(r).toEqual({ roster: entries, status: "lobby" });
    expect(rt.received).toEqual([{ type: "join_facilitator", sessionId: "s1", token: "tok" }]);
    expect(c.isOpen).toBe(true);
  });

  it("joinFacilitator takes only the roster frame: frames around it stay queued for a later listener, in order", async () => {
    const rt = await runtime((ws, m) => {
      if (m.type !== "join_facilitator") return;
      send(ws, { type: "joined", roleId: "facilitator", state: fstate });
      send(ws, ev(1));
      send(ws, facilitatorRoster);
      send(ws, ev(2));
    });
    const c = await connect(rt.url);
    await c.joinFacilitator("s1", "tok");
    const seen: ServerMessage[] = [];
    c.onFrame((m) => seen.push(m));
    await until(() => seen.length === 2);
    expect(seen).toEqual([ev(1), ev(2)]);
  });

  it("joinFacilitator waits for a roster that arrives later, and ignores a peers roster", async () => {
    let hold: (() => void) | null = null;
    const rt = await runtime((ws, m) => {
      if (m.type !== "join_facilitator") return;
      send(ws, { type: "joined", roleId: "facilitator", state: fstate });
      send(ws, { type: "roster", audience: "peers", entries: [] });
      hold = () => send(ws, facilitatorRoster);
    });
    const c = await connect(rt.url);
    const p = c.joinFacilitator("s1", "tok");
    let done = false;
    void p.then(() => { done = true; });
    await until(() => hold !== null);
    await new Promise((r) => setImmediate(r));
    expect(done).toBe(false);
    hold!();
    expect((await p).roster).toEqual(entries);
  });

  it("a refused token is RuntimeError unauthorized and the connection is closed", async () => {
    const rt = await runtime((ws, m) => { if (m.type === "join_facilitator") { send(ws, { type: "error", code: "unauthorized", message: "unauthorized" }); ws.close(1008, "unauthorized"); } });
    const c = await connect(rt.url);
    expect((await rejection(c.joinFacilitator("s1", "stale"))).code).toBe("unauthorized");
    expect(c.isOpen).toBe(false);
  });

  it("no roster within the timeout, a close before the roster and a session that is gone all fail and close the connection", async () => {
    const t = manualTimers();
    const silent = await runtime((ws, m) => { if (m.type === "join_facilitator") send(ws, { type: "joined", roleId: "facilitator", state: fstate }); });
    const c1 = await connect(silent.url, { setTimer: t.setTimer, timeoutMs: 1234 });
    const p1 = rejection(c1.joinFacilitator("s1", "tok"));
    await until(() => t.live().length === 1 && silent.received.length === 1);
    await new Promise((r) => setImmediate(r)); // joined processed: the roster timer replaces the join timer
    await until(() => t.live().some((x) => x.ms === 1234));
    t.fire(1234);
    expect((await p1).code).toBe("unavailable");
    expect(c1.isOpen).toBe(false);

    const dropping = await runtime((ws, m) => { if (m.type === "join_facilitator") { send(ws, { type: "joined", roleId: "facilitator", state: fstate }); ws.close(1011, "x"); } });
    const c2 = await connect(dropping.url);
    expect((await rejection(c2.joinFacilitator("s1", "tok"))).code).toBe("unavailable");

    const gone = await runtime((ws, m) => { if (m.type === "join_facilitator") send(ws, { type: "error", code: "unknown_session", message: "no such session" }); });
    const c3 = await connect(gone.url);
    expect((await rejection(c3.joinFacilitator("s1", "tok"))).code).toBe("unknown_session");
    expect(c3.isOpen).toBe(false);
  });

  it("a close with code 4002 is classified reissued, 4001 superseded", async () => {
    for (const [code, word] of [[4002, "reissued"], [4001, "superseded"]] as const) {
      const rt = await runtime((ws, m) => { if (m.type === "join") ws.close(code, "x"); });
      const c = await connect(rt.url);
      expect((await rejection(c.joinWithCredential({ ...ids, credential: "k".repeat(32) }))).code).toBe(word);
    }
  });
});
