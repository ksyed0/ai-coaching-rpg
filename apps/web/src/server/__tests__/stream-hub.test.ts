import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { initPlayerView } from "@acr/events";
import { RuntimeConnection } from "../runtime-connection";
import { NoStreamError, StreamHub, type SessionCookie } from "../stream-hub";
import type { ClientMessage, JoinedFrame, ServerMessage } from "../wire";
import { fakeRuntime, manualTimers, sseRecorder, until } from "./fakes";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/** A scripted runtime connection: the test pushes frames and closes; what the hub sends is recorded. */
class FakeConn {
  sent: ClientMessage[] = [];
  closed = 0;
  private frameFns = new Set<(m: ServerMessage) => void>();
  private closeFns = new Set<(code: number) => void>();
  private code: number | null = null;
  /** Answers each sent message (an error frame, say), like the runtime would, after the send returns. */
  answer: ((m: ClientMessage) => ServerMessage | null) | null = null;
  get isOpen() { return this.code === null && this.closed === 0; }
  send(m: ClientMessage) { if (!this.isOpen) throw new Error("closed"); this.sent.push(m); const a = this.answer?.(m); if (a) queueMicrotask(() => this.emit(a)); }
  onFrame(fn: (m: ServerMessage) => void) { this.frameFns.add(fn); return () => { this.frameFns.delete(fn); }; }
  onClose(fn: (code: number) => void) { if (this.code !== null) { fn(this.code); return () => {}; } this.closeFns.add(fn); return () => { this.closeFns.delete(fn); }; }
  close() { this.closed++; }
  emit(m: ServerMessage) { for (const fn of [...this.frameFns]) fn(m); }
  drop(code: number) { this.code = code; for (const fn of [...this.closeFns]) fn(code); }
  listeners() { return this.frameFns.size + this.closeFns.size; }
}
const asConn = (c: FakeConn) => c as unknown as RuntimeConnection;

const state = (lastSeq: number) => ({ lastSeq, status: "running", paused: false, pausedSince: null, currentScene: null, transcript: [{ seq: 2, ts: 2, roleId: "delivery_lead", text: "hi", sceneId: null, channel: "room" }] }) as unknown as JoinedFrame["state"];
const joinedFrame = (o: Partial<JoinedFrame> = {}): JoinedFrame => ({
  type: "joined", roleId: "delivery_lead", brief: "Your brief", privateFacts: ["a fact"], reconnectToken: "RECONNECT-TOKEN-XYZ", credential: "CREDENTIAL-0123456789abcdef0123456789ab",
  state: state(5), scenes: [], logIdentity: "log-1", consent: { noticeVersion: "v1", notice: "n", given: false }, replay: { afterSeq: 0, toSeq: 5, events: 0, complete: true }, ...o,
});
const ev = (seq: number, type = "utterance") => ({ seq, ts: seq, type, roleId: "tech_lead", text: `line ${seq}`, channel: "room" }) as unknown as Extract<ServerMessage, { type: "event" }>["event"];
const cookieFor = (participantId = "p-1", o: Partial<SessionCookie> = {}): SessionCookie => ({ sessionId: "s1", roleId: "delivery_lead", participantId, credential: "CREDENTIAL-0123456789abcdef0123456789ab", logIdentity: "log-1", expiresAt: 10 ** 13, ...o });

function hub(o: Partial<ConstructorParameters<typeof StreamHub>[0]> = {}) {
  const timers = manualTimers();
  const h = new StreamHub({ maxStreams: 10, maxStreamsPerSession: 10, maxStreamsPerAddress: 10, setTimer: timers.setTimer, now: () => 0, ...o });
  return { h, timers };
}
function opened(h: StreamHub, o: { cookie?: SessionCookie; address?: string; joined?: JoinedFrame } = {}) {
  const conn = new FakeConn();
  const rec = sseRecorder();
  const handle = h.open(o.cookie ?? cookieFor(), o.address ?? "198.51.100.1", asConn(conn), o.joined ?? joinedFrame(), rec.out);
  return { conn, rec, handle };
}

let stops: (() => Promise<void>)[] = [];
afterEach(async () => { for (const s of stops) await s(); stops = []; });

describe("StreamHub SSE output", () => {
  it("writes retry first, then the player-safe joined frame (no credential, no reconnect token), then events with their seq as id", () => {
    const { h } = hub();
    const { conn, rec } = opened(h);
    expect(rec.chunks[0]).toBe("retry: 3000\n\n");
    const joined = rec.frames()[1]!;
    expect(joined.event).toBe("joined");
    expect(joined.id).toBeUndefined(); // an id here could skip replayed events after a drop
    expect(Object.keys(joined.data).sort()).toEqual(["brief", "consent", "logIdentity", "privateFacts", "replay", "roleId", "scenes", "state"]);
    expect(rec.chunks.join("")).not.toContain("CREDENTIAL-");
    expect(rec.chunks.join("")).not.toContain("RECONNECT-TOKEN");
    conn.emit({ type: "event", event: ev(6) });
    conn.emit({ type: "roster", audience: "peers", entries: [{ roleId: "tech_lead", ready: true }] });
    const f = rec.frames();
    expect(f[2]).toEqual({ id: "6", event: "event", data: ev(6) });
    expect(f[3]).toEqual({ event: "roster", data: { audience: "peers", entries: [{ roleId: "tech_lead", ready: true }] } });
  });

  it("sends a heartbeat comment every 15 s through the injected timer", () => {
    const { h, timers } = hub();
    const { rec } = opened(h);
    timers.fire(15_000); timers.fire(15_000);
    expect(rec.chunks.filter((c) => c === ": hb\n\n")).toHaveLength(2);
    expect(timers.live().map((t) => t.ms)).toEqual([15_000]);
  });

  it("a runtime error frame nobody waits for is forwarded as an error event; frames of unknown type are not", () => {
    const { h } = hub();
    const { conn, rec } = opened(h);
    conn.emit({ type: "error", code: "log_failed", message: "the server is stopping" });
    conn.emit({ type: "mystery", secret: "x" } as unknown as ServerMessage);
    conn.emit(joinedFrame());
    expect(rec.frames().slice(2)).toEqual([{ event: "error", data: { code: "log_failed", message: "the server is stopping" } }]);
  });
});

describe("StreamHub reset", () => {
  it("a lastSeq beyond the head or from another log identity yields a reset frame", () => {
    const { h } = hub();
    // Another log identity: the browser's projection belongs to another log. The replayed events are skipped (the reset covers them).
    const other = opened(h, { cookie: cookieFor("p-1", { logIdentity: "log-OLD" }), joined: joinedFrame({ replay: { afterSeq: 3, toSeq: 5, events: 1, complete: true } }) });
    other.conn.emit({ type: "event", event: ev(4) });
    other.conn.emit({ type: "event", event: ev(6) });
    const f = other.rec.frames();
    expect(f[2]).toEqual({ id: "5", event: "reset", data: initPlayerView(state(5)) });
    expect(f.slice(3)).toEqual([{ id: "6", event: "event", data: ev(6) }]);
    // Beyond the head: the connection retried without lastSeq, so joined carries no replay summary.
    const beyond = opened(h, { cookie: cookieFor("p-2"), joined: joinedFrame({ replay: undefined }) });
    expect(beyond.rec.frames()[2]).toMatchObject({ id: "5", event: "reset" });
    // Incomplete replay.
    const old = opened(h, { cookie: cookieFor("p-3"), joined: joinedFrame({ replay: { afterSeq: 1, toSeq: 5, events: 0, complete: false } }) });
    expect(old.rec.frames()[2]).toMatchObject({ id: "5", event: "reset" });
    // A complete replay of the same log: no reset.
    const fine = opened(h, { cookie: cookieFor("p-4") });
    expect(fine.rec.frames().map((x) => x.event)).toEqual(["retry:3000", "joined"]);
  });
});

describe("StreamHub endings: out.end() exactly once, timers cancelled, listeners removed", () => {
  it("on runtime close 4001 it writes superseded and ends without reconnecting", () => {
    const { h, timers } = hub();
    const { conn, rec } = opened(h);
    conn.drop(4001);
    expect(rec.frames().at(-1)!.event).toBe("superseded");
    expect(rec.chunks.join("")).not.toContain("reconnecting");
    expect(rec.ends()).toBe(1);
    expect(timers.live()).toEqual([]);
    expect(conn.listeners()).toBe(0);
  });

  it("on any other runtime close it writes reconnecting and ends (the browser reconnects with Last-Event-ID)", () => {
    const { h, timers } = hub();
    const { conn, rec, handle } = opened(h);
    conn.drop(1006);
    expect(rec.frames().at(-1)!.event).toBe("reconnecting");
    expect(rec.ends()).toBe(1);
    expect(timers.live()).toEqual([]);
    if (handle !== "capacity") handle.close(); // a later abort changes nothing
    expect(rec.ends()).toBe(1);
  });

  it("on session.ended it forwards the event, writes ended, ends and closes the runtime socket", () => {
    const { h, timers } = hub();
    const { conn, rec } = opened(h);
    conn.emit({ type: "event", event: ev(9, "session.ended") });
    expect(rec.frames().slice(-2).map((f) => f.event)).toEqual(["event", "ended"]);
    expect(rec.ends()).toBe(1);
    expect(conn.closed).toBe(1);
    expect(timers.live()).toEqual([]);
    conn.drop(1000); // the runtime's own close afterwards writes nothing more
    expect(rec.ends()).toBe(1);
  });

  it("closing the output (request abort) closes the runtime socket", () => {
    const { h, timers } = hub();
    const { conn, rec, handle } = opened(h);
    if (handle === "capacity") throw new Error("unexpected capacity");
    handle.close(); handle.close();
    expect(conn.closed).toBe(1);
    expect(rec.ends()).toBe(1);
    expect(timers.live()).toEqual([]);
    expect(rec.chunks.join("")).not.toContain("reconnecting");
  });

  it("a write that throws (the client is gone) ends the stream once and closes the runtime socket", () => {
    const { h } = hub();
    const conn = new FakeConn();
    let ends = 0;
    let fail = false;
    const out = { write: () => { if (fail) throw new Error("gone"); }, end: () => { ends++; } };
    h.open(cookieFor(), "a", asConn(conn), joinedFrame(), out);
    fail = true;
    conn.emit({ type: "event", event: ev(6) });
    expect(ends).toBe(1);
    expect(conn.closed).toBe(1);
  });

  it("a connection that closed before open is reported at once", () => {
    const { h } = hub();
    const conn = new FakeConn();
    conn.drop(1006);
    const rec = sseRecorder();
    h.open(cookieFor(), "a", asConn(conn), joinedFrame(), rec.out);
    expect(rec.frames().at(-1)!.event).toBe("reconnecting");
    expect(rec.ends()).toBe(1);
  });
});

describe("StreamHub one stream per participant", () => {
  it("a second open for the same participant ends the first with a superseded event and the first does not reconnect", () => {
    const { h, timers } = hub();
    const first = opened(h);
    const second = opened(h);
    expect(first.rec.frames().at(-1)!.event).toBe("superseded");
    expect(first.rec.chunks.join("")).not.toContain("reconnecting");
    expect(first.rec.ends()).toBe(1);
    expect(first.conn.closed).toBe(1);
    first.conn.drop(4001); // the runtime's kick arriving afterwards changes nothing
    expect(first.rec.ends()).toBe(1);
    expect(second.rec.ends()).toBe(0);
    expect(timers.live()).toHaveLength(1); // only the second stream's heartbeat
    // The first stream's late close did not remove the second from the hub.
    second.conn.emit({ type: "event", event: ev(7) });
    expect(second.rec.events().map((e) => e.seq)).toEqual([7]);
  });
});

describe("StreamHub capacity", () => {
  it("capacity is returned past the global, per-session and per-address caps", () => {
    const capped = (o: Partial<ConstructorParameters<typeof StreamHub>[0]>, opens: { participant: string; session?: string; address?: string }[]) => {
      const { h, timers } = hub(o);
      const results = opens.map((x) => {
        const conn = new FakeConn(); const rec = sseRecorder();
        const r = h.open(cookieFor(x.participant, { sessionId: x.session ?? "s1" }), x.address ?? "a", asConn(conn), joinedFrame(), rec.out);
        return { r, conn, rec };
      });
      return { results, timers, h };
    };
    const global = capped({ maxStreams: 2 }, [{ participant: "1", session: "x", address: "1" }, { participant: "2", session: "y", address: "2" }, { participant: "3", session: "z", address: "3" }]);
    expect(global.results.map((x) => x.r === "capacity")).toEqual([false, false, true]);
    // Refused: nothing written, the output ended once, the connection closed, no timer left behind.
    const refused = global.results[2]!;
    expect(refused.rec.chunks).toEqual([]);
    expect(refused.rec.ends()).toBe(1);
    expect(refused.conn.closed).toBe(1);
    expect(global.timers.live()).toHaveLength(2);
    const perSession = capped({ maxStreamsPerSession: 1 }, [{ participant: "1", address: "1" }, { participant: "2", address: "2" }, { participant: "3", session: "other", address: "3" }]);
    expect(perSession.results.map((x) => x.r === "capacity")).toEqual([false, true, false]);
    const perAddress = capped({ maxStreamsPerAddress: 1 }, [{ participant: "1", session: "x" }, { participant: "2", session: "y" }, { participant: "3", address: "other" }]);
    expect(perAddress.results.map((x) => x.r === "capacity")).toEqual([false, true, false]);
    // A participant replacing its own stream does not count twice.
    const full = capped({ maxStreams: 1 }, [{ participant: "1" }, { participant: "1" }]);
    expect(full.results.map((x) => x.r === "capacity")).toEqual([false, false]);
  });

  it("the caps free up on every exit path", () => {
    const { h } = hub({ maxStreams: 1, maxStreamsPerSession: 1, maxStreamsPerAddress: 1 });
    const again = () => opened(h, { cookie: cookieFor("next") });
    const a = opened(h, { cookie: cookieFor("a") });
    expect(again().handle).toBe("capacity");
    a.conn.drop(1006); // runtime close
    const b = again();
    expect(b.handle).not.toBe("capacity");
    b.conn.emit({ type: "event", event: ev(9, "session.ended") }); // ended
    const c = opened(h, { cookie: cookieFor("c") });
    if (c.handle === "capacity") throw new Error("still full after ended");
    c.handle.close(); // abort
    const d = opened(h, { cookie: cookieFor("d") });
    expect(d.handle).not.toBe("capacity");
    d.conn.drop(4001); // superseded
    expect(opened(h, { cookie: cookieFor("e") }).handle).not.toBe("capacity");
  });
});

describe("StreamHub send", () => {
  it("send with no stream open throws NoStreamError", async () => {
    const { h } = hub();
    await expect(h.send(cookieFor(), { type: "leave" })).rejects.toBeInstanceOf(NoStreamError);
    const { conn } = opened(h);
    conn.drop(1006);
    await expect(h.send(cookieFor(), { type: "leave" })).rejects.toBeInstanceOf(NoStreamError);
    // A stream for another participant of the same role is not this participant's.
    opened(h, { cookie: cookieFor("p-2") });
    await expect(h.send(cookieFor("p-1"), { type: "leave" })).rejects.toBeInstanceOf(NoStreamError);
  });

  it("send resolves with the runtime's error frame, which is not also written to the stream", async () => {
    const { h } = hub();
    const { conn, rec } = opened(h);
    conn.answer = () => ({ type: "error", code: "consent_version", message: "consent_version" });
    const r = await h.send(cookieFor(), { type: "consent", noticeVersion: "v0" });
    expect(r).toEqual({ type: "error", code: "consent_version", message: "consent_version" });
    expect(conn.sent).toEqual([{ type: "consent", noticeVersion: "v0" }]);
    expect(rec.chunks.join("")).not.toContain("consent_version");
  });

  it("send resolves null once the bounded wait passes with no error, and null when the stream ends while waiting", async () => {
    const { h, timers } = hub({ sendWaitMs: 250 });
    const { conn } = opened(h);
    const p = h.send(cookieFor(), { type: "say", text: "hello" });
    await Promise.resolve();
    timers.fire(250);
    expect(await p).toBeNull();
    const q = h.send(cookieFor(), { type: "say", text: "again" });
    await Promise.resolve();
    conn.drop(1006);
    expect(await q).toBeNull();
    expect(timers.live()).toEqual([]);
  });

  it("send on a connection that just closed throws NoStreamError", async () => {
    const { h } = hub();
    const { conn } = opened(h);
    conn.closed = 1; // the socket went away; the close event has not arrived yet
    await expect(h.send(cookieFor(), { type: "leave" })).rejects.toBeInstanceOf(NoStreamError);
  });
});

describe("StreamHub with a real RuntimeConnection (scripted runtime)", () => {
  async function scripted(onMessage: (ws: WebSocket, m: any) => void) {
    const rt = await fakeRuntime(onMessage);
    stops.push(rt.stop);
    return rt;
  }

  it("closing the output (request abort) closes the runtime socket", async () => {
    const rt = await scripted((ws, m) => { if (m.type === "join") ws.send(JSON.stringify({ ...joinedFrame(), roleId: m.roleId })); });
    const conn = await RuntimeConnection.connect(rt.url, "198.51.100.1");
    const joined = await conn.joinWithCredential({ sessionId: "s1", roleId: "delivery_lead", participantId: "p-1", credential: "k".repeat(32) });
    const { h } = hub();
    const rec = sseRecorder();
    const handle = h.open(cookieFor(), "198.51.100.1", conn, joined, rec.out);
    if (handle === "capacity") throw new Error("unexpected capacity");
    handle.close();
    await rt.closed();
    expect(rec.ends()).toBe(1);
  });

  it("the replay that follows joined comes out after the joined frame, in order, before live events", async () => {
    const rt = await scripted((ws, m) => {
      if (m.type !== "join") return;
      ws.send(JSON.stringify({ ...joinedFrame({ replay: { afterSeq: 2, toSeq: 5, events: 2, complete: true } }), roleId: m.roleId }));
      ws.send(JSON.stringify({ type: "event", event: ev(3) }));
      ws.send(JSON.stringify({ type: "event", event: ev(5) }));
      ws.send(JSON.stringify({ type: "event", event: ev(6) }));
    });
    const conn = await RuntimeConnection.connect(rt.url, "198.51.100.1");
    const joined = await conn.joinWithCredential({ sessionId: "s1", roleId: "delivery_lead", participantId: "p-1", credential: "k".repeat(32), lastSeq: 2 });
    const { h } = hub();
    const rec = sseRecorder();
    const handle = h.open(cookieFor(), "a", conn, joined, rec.out);
    await until(() => rec.events().length === 3);
    expect(rec.frames().map((f) => f.id ?? f.event)).toEqual(["retry:3000", "joined", "3", "5", "6"]);
    if (handle !== "capacity") handle.close();
  });
});
