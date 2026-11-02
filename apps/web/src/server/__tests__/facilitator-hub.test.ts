import { describe, expect, it } from "vitest";
import type { SessionState } from "@acr/events";
import { FacilitatorHub } from "../facilitator-hub";
import type { FacilitatorJoin } from "../facilitator-socket";
import type { FacilitatorRosterEntry, JoinedFrame, ServerMessage } from "../wire";
import { sseBody } from "../sse";
import { asConn, FakeConn, manualTimers, parseSse, sseRecorder } from "./fakes";

const state = (lastSeq = 5): SessionState => ({
  status: "running", lastSeq, scenarioId: "sc", version: "1", roles: { lead: { kind: "player", participantId: "P-SECRET" } },
  currentScene: null, sceneHistory: [], paused: false, pausedSince: null, transcript: [], injectsFired: [],
  npcs: { npc: { goals: ["GOAL-SECRET"], knowledge: [], released: [] } }, advanceRequested: false, gmVerdicts: {}, factsEarned: {}, talk: {},
});
const entries: FacilitatorRosterEntry[] = [{ roleId: "lead", name: "Ann", joined: true, consented: true, connected: true }];
const scenes = [{ id: "a", title: "T", goal: "G", timeBoxMinutes: 5 }];
const join = (o: Partial<JoinedFrame> = {}): FacilitatorJoin => ({
  frame: { type: "joined", roleId: "facilitator", state: state(), scenes, replay: { afterSeq: 0, toSeq: 5, events: 0, complete: true }, ...o } as JoinedFrame,
  roster: entries, status: "running",
});
const ev = (seq: number, type = "utterance") => ({ seq, ts: seq, sessionId: "s1", type, roleId: "lead", text: `line ${seq}`, channel: "text" }) as unknown as Extract<ServerMessage, { type: "event" }>["event"];

function setup(o: { maxStreams?: number; maxPendingBytes?: number; now?: () => number; joined?: FacilitatorJoin; expiresAt?: number } = {}) {
  const timers = manualTimers();
  let n = 0;
  const h = new FacilitatorHub({ setTimer: timers.setTimer, now: o.now ?? (() => 0), newChannelId: () => `ch-${++n}`, ...(o.maxStreams !== undefined && { maxStreams: o.maxStreams }), ...(o.maxPendingBytes !== undefined && { maxPendingBytes: o.maxPendingBytes }) });
  const open = (joined = o.joined ?? join()) => {
    const conn = new FakeConn(); const rec = sseRecorder();
    const r = h.open({ sessionId: "s1", expiresAt: o.expiresAt ?? 10 ** 13, conn: asConn(conn), joined, out: rec.out });
    return { conn, rec, r };
  };
  return { h, timers, open };
}

/** After any exit: no timer left, no listener left on the connection, the slot freed. */
const clean = (t: ReturnType<typeof manualTimers>, c: FakeConn, h: FacilitatorHub) => { expect(t.live()).toEqual([]); expect(c.listeners()).toBe(0); expect(h.size()).toBe(0); };

describe("FacilitatorHub", () => {
  it("writes retry, joined with channel and scenes, roster, then events with seq ids; a complete replay with no logIdentity gives no reset", () => {
    const { open } = setup();
    const { conn, rec } = open();
    expect(rec.chunks[0]).toBe("retry: 3000\n\n");
    const f = rec.frames();
    expect(f[1]).toEqual({ event: "joined", data: { channel: "ch-1", scenes } });
    expect(f[2]).toEqual({ event: "roster", data: { entries } });
    expect(f.some((x) => x.event === "reset")).toBe(false);
    conn.emit({ type: "event", event: ev(6) });
    conn.emit({ type: "roster", audience: "facilitator", entries });
    expect(rec.frames().slice(3)).toEqual([{ id: "6", event: "event", data: ev(6) }, { event: "roster", data: { entries } }]);
  });

  it("a missing or incomplete replay writes reset at lastSeq and skips the replayed frames", () => {
    for (const replay of [undefined, { afterSeq: 0, toSeq: 5, events: 2, complete: false }]) {
      const { open } = setup({ joined: join({ replay }) });
      const { conn, rec } = open();
      const f = rec.frames();
      expect(f.map((x) => x.event)).toEqual(["retry:3000", "joined", "reset", "roster"]);
      const reset = f.find((x) => x.event === "reset")!;
      expect(reset.id).toBe("5");
      expect(reset.data.state.roles).toEqual({ lead: { kind: "player" } });
      expect(reset.data.state.npcs).toEqual({});
      const skip = replay?.events ?? 0;
      for (let i = 0; i < skip; i++) conn.emit({ type: "event", event: ev(4 + i) });
      conn.emit({ type: "event", event: ev(6) });
      expect(rec.events().map((e) => e.seq)).toEqual([6]);
    }
  });

  it("a reset whose lastSeq is not a safe integer carries no id", () => {
    const { open } = setup({ joined: join({ replay: undefined, state: { ...state(), lastSeq: 1.5 } }) });
    const reset = open().rec.frames().find((x) => x.event === "reset")!;
    expect(reset.id).toBeUndefined();
  });

  it("two tabs of one session get distinct channels and both receive every event", () => {
    const { open } = setup();
    const a = open(); const b = open();
    expect(a.r).not.toBe("capacity");
    expect((a.r as { channel: string }).channel).toBe("ch-1");
    expect((b.r as { channel: string }).channel).toBe("ch-2");
    a.conn.emit({ type: "event", event: ev(6) }); b.conn.emit({ type: "event", event: ev(6) });
    expect(a.rec.events()).toHaveLength(1); expect(b.rec.events()).toHaveLength(1);
  });

  it("session.ended is forwarded then ended; a runtime close writes reconnecting; the first heartbeat after expiresAt writes expired", () => {
    const s1 = setup(); const a = s1.open();
    a.conn.emit({ type: "event", event: ev(6, "session.ended") });
    expect(a.rec.frames().slice(-2).map((x) => x.event)).toEqual(["event", "ended"]);
    expect(a.rec.ends()).toBe(1); expect(a.conn.closed).toBe(1); clean(s1.timers, a.conn, s1.h);

    const s2 = setup(); const b = s2.open();
    b.conn.drop(1006);
    expect(b.rec.frames().at(-1)!.event).toBe("reconnecting");
    expect(b.conn.closed).toBe(1); clean(s2.timers, b.conn, s2.h);

    let t = 0;
    const s3 = setup({ now: () => t, expiresAt: 100 }); const c = s3.open();
    s3.timers.fire(15_000);
    expect(c.rec.frames().at(-1)).toEqual({ comment: "hb" });
    t = 99; s3.timers.fire(15_000); // before expiresAt: alive
    expect(c.rec.frames().at(-1)).toEqual({ comment: "hb" });
    t = 100; s3.timers.fire(15_000); // now === expiresAt is expired, like the route and the player hub
    expect(c.rec.frames().at(-1)!.event).toBe("expired");
    expect(c.conn.closed).toBe(1); clean(s3.timers, c.conn, s3.h);
  });

  it("error frames carry the fixed message; joined and unknown frames are not forwarded", () => {
    const { open } = setup(); const { conn, rec } = open();
    const before = rec.frames().length;
    conn.emit({ type: "error", code: "log_failed", message: "SECRET RUNTIME TEXT" });
    conn.emit({ type: "joined", roleId: "x", state: state(), hiddenFacts: ["HIDDEN-FACT"], notice: "NOTICE" } as unknown as ServerMessage);
    conn.emit({ type: "mystery", boom: "X" } as unknown as ServerMessage);
    expect(rec.frames().slice(before)).toEqual([{ event: "error", data: { code: "log_failed", message: "the server reported an error" } }]);
  });

  it("a poisoned joined frame never puts hiddenFacts, notice or extra keys in any written byte", () => {
    const poisoned = join({
      hiddenFacts: ["HIDDEN-FACT"], notice: "NOTICE-TEXT", brief: "BRIEF", privateFacts: ["PRIV"], credential: "CRED", reconnectToken: "RECON", logIdentity: "LOGID",
      scenes: [{ id: "a", title: "T", goal: "G", timeBoxMinutes: 5, hiddenFacts: ["SCENE-HIDDEN"] }],
    } as unknown as Partial<JoinedFrame>);
    poisoned.roster = [{ ...entries[0]!, credential: "ROSTER-CRED", participantId: "ROSTER-PID" } as never];
    const { open } = setup({ joined: poisoned }); const { conn, rec } = open();
    conn.emit({ type: "roster", audience: "facilitator", entries: [{ ...entries[0]!, credential: "LIVE-CRED", participantId: "LIVE-PID" } as never] });
    conn.emit({ type: "roster", audience: "peers", entries: [{ roleId: "lead", ready: true, credential: "PEER-CRED" } as never] });
    conn.emit({ type: "event", event: { type: "npc.updated", seq: 6, ts: 6, sessionId: "s1", roleId: "npc", goals: ["GOAL-SECRET"], knowledge: ["K-SECRET"], released: ["R-SECRET"] } as never });
    expect(rec.frames().filter((f) => f.event === "roster")).toHaveLength(2); // the joined roster and the live one; the peers frame is dropped
    const all = rec.chunks.join("");
    for (const bad of ["HIDDEN-FACT", "NOTICE-TEXT", "BRIEF", "PRIV", "CRED", "RECON", "LOGID", "SCENE-HIDDEN", "P-SECRET", "GOAL-SECRET", "K-SECRET", "R-SECRET", "ROSTER-CRED", "ROSTER-PID", "LIVE-CRED", "LIVE-PID", "PEER-CRED"]) expect(all).not.toContain(bad);
  });

  it("a facilitator alert shows a fixed line, never the runtime's text", () => {
    const { open } = setup(); const { conn, rec } = open();
    const poison = "sk-ant-api03-ABCDEF Authorization: Bearer abc.def JOIN-CODE-9Z7K the hidden fact is the vault code";
    conn.emit({ type: "event", event: { type: "facilitator.alert", seq: 6, ts: 6, sessionId: "s1", level: "warning", message: poison } as never });
    conn.emit({ type: "event", event: { type: "facilitator.alert", seq: 7, ts: 7, sessionId: "s1", level: "info", message: poison, extra: "EXTRA-KEY" } as never });
    const all = rec.chunks.join("");
    for (const bad of ["sk-ant", "Bearer", "JOIN-CODE", "vault", "EXTRA-KEY"]) expect(all).not.toContain(bad);
    expect(rec.events().map((e) => [e.seq, e.level])).toEqual([[6, "warning"], [7, "info"]]);
  });

  it("an unknown event type goes as its envelope only; set_npc_stance loses its goal text; extra keys on known types are dropped", () => {
    const { open } = setup(); const { conn, rec } = open();
    conn.emit({ type: "event", event: { type: "future.thing", seq: 6, ts: 6, sessionId: "s1", secret: "FUTURE-SECRET" } as never });
    conn.emit({ type: "event", event: { type: "facilitator.command", command: "set_npc_stance", roleId: "npc", goals: ["STANCE-SECRET"], seq: 7, ts: 7, sessionId: "s1" } as never });
    conn.emit({ type: "event", event: { type: "utterance", roleId: "lead", text: "hi", channel: "text", seq: 8, ts: 8, sessionId: "s1", junk: "JUNK-KEY" } as never });
    const all = rec.chunks.join("");
    for (const bad of ["FUTURE-SECRET", "STANCE-SECRET", "JUNK-KEY"]) expect(all).not.toContain(bad);
    expect(rec.events().map((e) => e.seq)).toEqual([6, 7, 8]);
  });

  it("a copy that throws ends the stream with reconnecting and frees the slot and connection", () => {
    const { open, h, timers } = setup(); const { conn, rec } = open();
    conn.emit({ type: "event", event: { type: "session.started", seq: 6, ts: 6, sessionId: "s1" } as never }); // no roles: the copy throws
    expect(rec.frames().at(-1)!.event).toBe("reconnecting");
    clean(timers, conn, h);
    const bad = join({ state: undefined, replay: undefined } as never);
    const t2 = setup({ joined: bad }); const o = t2.open();
    expect(o.r).not.toBe("capacity");
    expect(o.rec.ends()).toBe(1); expect(o.conn.closed).toBe(1); clean(t2.timers, o.conn, t2.h);
  });

  it("past maxStreams open is capacity, closes the connection and writes nothing", () => {
    const { open } = setup({ maxStreams: 1 });
    open();
    const { conn, rec, r } = open();
    expect(r).toBe("capacity");
    expect(conn.closed).toBe(1); expect(rec.chunks).toEqual([]); expect(rec.ends()).toBe(1);
  });

  it("a stall after the opening ends with reconnecting; the opening writes do not count", () => {
    const timers = manualTimers();
    const h = new FacilitatorHub({ setTimer: timers.setTimer, now: () => 0, maxPendingBytes: 10 });
    const chunks: string[] = []; let ends = 0;
    const conn = new FakeConn();
    const r = h.open({ sessionId: "s1", expiresAt: 10 ** 13, conn: asConn(conn), joined: join(), out: { write: (c) => { chunks.push(c); return false; }, end: () => { ends++; } } });
    expect(r).not.toBe("capacity");
    expect(ends).toBe(0); // retry, joined and roster are over the cap and still open
    conn.emit({ type: "event", event: ev(6) });
    expect(ends).toBe(1);
    expect(conn.closed).toBe(1);
    expect(chunks.join("")).toContain("event: reconnecting");
    clean(timers, conn, h);
  });

  it("a reset over 256 KiB through the real sseBody keeps the stream open", async () => {
    const big = { ...state(), transcript: Array.from({ length: 3000 }, (_, i) => ({ seq: i, ts: i, sceneId: null, roleId: "lead", text: "x".repeat(100), channel: "text" as const })) };
    const timers = manualTimers();
    const h = new FacilitatorHub({ setTimer: timers.setTimer, now: () => 0 });
    const body = sseBody(); const conn = new FakeConn();
    h.open({ sessionId: "s1", expiresAt: 10 ** 13, conn: asConn(conn), joined: join({ replay: undefined, state: big }), out: body.out });
    expect(conn.closed).toBe(0);
    const reader = body.stream.getReader(); const dec = new TextDecoder(); let text = "";
    while (!/event: roster/.test(text)) text += dec.decode((await reader.read()).value);
    expect(text.length).toBeGreaterThan(256 * 1024);
    expect(parseSse(text).map((f) => f.event)).toEqual(["retry:3000", "joined", "reset", "roster"]);
    expect(h.size()).toBe(1);
    await reader.cancel();
  });

  it("an error code that is not a short snake_case word is forwarded as error", () => {
    const { open } = setup(); const { conn, rec } = open();
    conn.emit({ type: "error", code: "log_failed", message: "m" });
    conn.emit({ type: "error", code: "Bearer abc.def-JOIN9", message: "m" });
    conn.emit({ type: "error", code: "a".repeat(41), message: "m" });
    expect(rec.frames().filter((f) => f.event === "error").map((f) => f.data.code)).toEqual(["log_failed", "error", "error"]);
    expect(rec.chunks.join("")).not.toContain("Bearer");
  });

  it("closing the output closes the runtime connection", () => {
    const { open, h, timers } = setup(); const { conn, rec, r } = open();
    (r as { close(): void }).close();
    clean(timers, conn, h);
    expect(conn.closed).toBe(1); expect(rec.ends()).toBe(1); expect(h.size()).toBe(0);
  });
});
