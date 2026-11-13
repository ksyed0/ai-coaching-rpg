import { describe, expect, expectTypeOf, it } from "vitest";
import type { RosterEntry as ConsoleApiRosterEntry } from "../../lib/console-api";
import type { SessionState } from "@acr/events";
import { COMMAND_TIMEOUT_MS, FacilitatorHub } from "../facilitator-hub";
import type { FacilitatorJoin } from "../facilitator-socket";
import type { FacilitatorRosterEntry, JoinedFrame, ServerMessage } from "../wire";
import type { FacilitatorRosterEntry as ClientEntry } from "../../lib/use-console-stream";
import { sseBody } from "../sse";
import { asConn, FakeConn, manualTimers, parseSse, sseRecorder } from "./fakes";

const state = (lastSeq = 5): SessionState => ({
  status: "running", lastSeq, scenarioId: "sc", version: "1", roles: { lead: { kind: "player", participantId: "P-SECRET" } },
  currentScene: null, sceneHistory: [], paused: false, pausedSince: null, transcript: [], injectsFired: [],
  npcs: { npc: { goals: ["GOAL-SECRET"], knowledge: [], released: [] } }, advanceRequested: false, gmVerdicts: {}, factsEarned: {}, talk: {}, aiRoles: [], whispers: {}, whisperFloor: {},
});
const entries: FacilitatorRosterEntry[] = [{ roleId: "lead", name: "Ann", joined: true, consented: true, connected: true }];
const scenes = [{ id: "a", title: "T", goal: "G", timeBoxMinutes: 5 }];
const join = (o: Partial<JoinedFrame> = {}): FacilitatorJoin => ({
  frame: { type: "joined", roleId: "facilitator", state: state(), scenes, replay: { afterSeq: 0, toSeq: 5, events: 0, complete: true }, ...o } as JoinedFrame,
  roster: entries, status: "running",
});
const ev = (seq: number, type = "utterance") => ({ seq, ts: seq, sessionId: "s1", type, roleId: "lead", text: `line ${seq}`, channel: "text" }) as unknown as Extract<ServerMessage, { type: "event" }>["event"];

function setup(o: { commandTimeoutMs?: number; maxStreams?: number; maxPendingBytes?: number; now?: () => number; joined?: FacilitatorJoin; expiresAt?: number } = {}) {
  const timers = manualTimers();
  let n = 0; let r = 0;
  const h = new FacilitatorHub({ setTimer: timers.setTimer, now: o.now ?? (() => 0), newChannelId: () => `ch-${++n}`, newRef: () => `ref-${++r}`, ...(o.commandTimeoutMs !== undefined && { commandTimeoutMs: o.commandTimeoutMs }), ...(o.maxStreams !== undefined && { maxStreams: o.maxStreams }), ...(o.maxPendingBytes !== undefined && { maxPendingBytes: o.maxPendingBytes }) });
  const open = (joined = o.joined ?? join()) => {
    const conn = new FakeConn(); const rec = sseRecorder();
    const res = h.open({ sessionId: "s1", expiresAt: o.expiresAt ?? 10 ** 13, conn: asConn(conn), joined, out: rec.out });
    return { conn, rec, r: res };
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
    expect(f[1]).toEqual({ event: "joined", data: { channel: "ch-1", scenes: [{ ...scenes[0], injects: [] }] } });
    expect(f[2]!.event).toBe("characters");
    expect(f[3]).toEqual({ event: "roster", data: { entries } });
    expect(f.some((x) => x.event === "reset")).toBe(false);
    conn.emit({ type: "event", event: ev(6) });
    conn.emit({ type: "roster", audience: "facilitator", entries });
    expect(rec.frames().slice(4)).toEqual([{ id: "6", event: "event", data: ev(6) }, { event: "roster", data: { entries } }]);
  });

  it("a missing or incomplete replay writes reset at lastSeq and skips the replayed frames", () => {
    for (const replay of [undefined, { afterSeq: 0, toSeq: 5, events: 2, complete: false }]) {
      const { open } = setup({ joined: join({ replay }) });
      const { conn, rec } = open();
      const f = rec.frames();
      expect(f.map((x) => x.event)).toEqual(["retry:3000", "joined", "reset", "characters", "roster"]);
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
    for (const bad of ["HIDDEN-FACT", "NOTICE-TEXT", "BRIEF", "PRIV", "CRED", "RECON", "LOGID", "SCENE-HIDDEN", "P-SECRET", "K-SECRET", "R-SECRET", "ROSTER-CRED", "ROSTER-PID", "LIVE-CRED", "LIVE-PID", "PEER-CRED"]) expect(all).not.toContain(bad);
    // The goal text is on the page only inside characters frames.
    for (const f of rec.frames().filter((x) => x.event !== undefined && x.event !== "characters")) expect(JSON.stringify(f), `${f.event} carried a goal`).not.toContain("GOAL-SECRET");
    expect(rec.frames().filter((x) => x.event === "characters").map((x) => JSON.stringify(x.data)).join("")).toContain("GOAL-SECRET");
  });

  const chars = (rec: ReturnType<typeof sseRecorder>) => rec.frames().filter((f) => f.event === "characters");
  const withNpcs = (npcs: unknown, hiddenFacts: unknown, extra: Partial<JoinedFrame> = {}) =>
    join({ state: { ...state(), npcs } as never, hiddenFacts, ...extra } as never);

  it("writes characters after joined from the joined state and hidden facts, without fact text", () => {
    const j = withNpcs({ npc: { goals: ["GOAL-1"], knowledge: ["KNOW-SECRET"], released: ["FACT-TWO"] }, other: { goals: [], knowledge: [], released: [] } },
      { npc: ["FACT-ONE", "FACT-TWO"], other: ["OTHER-FACT"] });
    const { rec } = setup({ joined: j }).open();
    expect(rec.frames().map((f) => f.event)).toEqual(["retry:3000", "joined", "characters", "roster"]);
    const c = chars(rec);
    expect(c).toHaveLength(1);
    expect(c[0]).toEqual({ event: "characters", data: { roles: [
      { roleId: "npc", goals: ["GOAL-1"], facts: [{ n: 1, released: false }, { n: 2, released: true }] },
      { roleId: "other", goals: [], facts: [{ n: 1, released: false }] },
    ] } });
    expect(c[0]!.id).toBeUndefined();
    const all = rec.chunks.join("");
    for (const bad of ["FACT-ONE", "FACT-TWO", "OTHER-FACT", "KNOW-SECRET", "knowledge", "hiddenFacts"]) expect(all).not.toContain(bad);
  });

  it("a reset is followed by characters, then roster", () => {
    const j = withNpcs({ npc: { goals: ["G"], knowledge: [], released: [] } }, { npc: ["F"] }, { replay: undefined });
    expect(setup({ joined: j }).open().rec.frames().map((f) => f.event)).toEqual(["retry:3000", "joined", "reset", "characters", "roster"]);
  });

  it("poisoned hidden facts and npcs never put fact text, knowledge or a non-string anywhere; a malformed hiddenFacts counts as none", () => {
    const npcs = JSON.parse('{"__proto__":{"goals":["PG",7],"knowledge":["PK-SECRET"],"released":["PF-SECRET"]},"npc":{"goals":[1,{"x":"OBJ-GOAL"},"ok"],"knowledge":["K2-SECRET"],"released":[{"t":"OBJ-REL"},"NOPE-SECRET"]},"bad":"BAD-ENTRY-SECRET","nul":null}');
    const poisonedFacts = JSON.parse('{"__proto__":["PF-SECRET"],"npc":["NPC-F1",42,{"t":"OBJ-FACT"},"NPC-F2"]}');
    for (const hidden of [poisonedFacts, ["ARR-SECRET"], "STR-SECRET", null, { npc: "NOT-AN-ARRAY-SECRET" }, { npc: ["MIX-SECRET", 5] }]) {
      const { rec, h } = (() => { const x = setup({ joined: withNpcs(npcs, hidden) }); return { rec: x.open().rec, h: x.h }; })();
      const all = rec.chunks.join("");
      for (const bad of ["PK-SECRET", "PF-SECRET", "K2-SECRET", "NOPE-SECRET", "BAD-ENTRY-SECRET", "OBJ-", "ARR-SECRET", "STR-SECRET", "NOT-AN-ARRAY-SECRET", "MIX-SECRET", "NPC-F1", "NPC-F2", "knowledge", "hiddenFacts"]) expect(all, `${bad} leaked`).not.toContain(bad);
      const roles = chars(rec)[0]!.data.roles as { roleId: string; goals: string[]; facts: unknown[] }[];
      expect(roles.map((r) => r.roleId)).toEqual(["__proto__", "npc", "bad", "nul"]);
      expect(roles.slice(2)).toEqual([{ roleId: "bad", goals: [], facts: [] }, { roleId: "nul", goals: [], facts: [] }]);
      expect(roles[0]!.goals).toEqual(["PG"]);
      expect(roles[1]!.goals).toEqual(["ok"]);
      expect(roles.every((r) => Object.keys(r).sort().join() === "facts,goals,roleId")).toBe(true);
      expect(h.size()).toBe(1);
    }
    // a poisoned frame whose hiddenFacts is well formed except for one non-string entry in one role is also treated as none (not partially trusted)
    const s = setup({ joined: withNpcs({ npc: { goals: [], knowledge: [], released: [] } }, { npc: ["MIX-SECRET", 5] }) });
    const o = s.open();
    expect(chars(o.rec)[0]!.data.roles).toEqual([{ roleId: "npc", goals: [], facts: [] }]);
    expect(s.h.factsFor("s1", (o.r as { channel: string }).channel)).toEqual([]);
  });

  it("a poisoned npc.updated never carries text, knowledge or a released text that is no hidden fact", () => {
    const { open } = setup({ joined: withNpcs({ npc: { goals: ["G0"], knowledge: [], released: [] } }, { npc: ["REAL-F1"] }) });
    const { conn, rec } = open();
    conn.emit({ type: "event", event: { type: "npc.updated", seq: 6, ts: 6, sessionId: "s1", roleId: "npc", goals: ["G1", 5], knowledge: ["EVT-K-SECRET"], released: ["INVENTED-SECRET", {}, "REAL-F1"], extra: "EVT-EXTRA" } as never });
    conn.emit({ type: "event", event: { type: "npc.updated", seq: 7, ts: 7, sessionId: "s1", roleId: 9, goals: ["X"], knowledge: [], released: [] } as never });
    conn.emit({ type: "event", event: { type: "npc.updated", seq: 8, ts: 8, sessionId: "s1", roleId: "npc", goals: "no", knowledge: [], released: null } as never });
    const all = rec.chunks.join("");
    for (const bad of ["EVT-K-SECRET", "INVENTED-SECRET", "EVT-EXTRA", "REAL-F1", "knowledge\":[\"" ]) expect(all).not.toContain(bad);
    const last = chars(rec).at(-1)!.data.roles;
    // seq 8 has a malformed released: the role keeps what it had released (seq 6)
    expect(last).toEqual([{ roleId: "npc", goals: [], facts: [{ n: 1, released: true }] }]);
    expect(rec.events().map((e) => e.seq)).toEqual([6, 7, 8]);
  });

  it("an npc.updated without released keeps the facts already released (the reducer keeps the previous list)", () => {
    const j = withNpcs({ npc: { goals: ["G0"], knowledge: [], released: [] } }, { npc: ["F1", "F2"] });
    const { conn, rec } = setup({ joined: j }).open();
    conn.emit({ type: "event", event: { type: "npc.updated", seq: 6, ts: 6, sessionId: "s1", roleId: "npc", goals: [], knowledge: [], released: ["F2"] } as never });
    const before = rec.frames().length;
    conn.emit({ type: "event", event: { type: "npc.updated", seq: 7, ts: 7, sessionId: "s1", roleId: "npc", goals: ["G7"], knowledge: ["K7-SECRET"] } as never });
    const f = rec.frames().slice(before);
    expect(f.map((x) => x.event)).toEqual(["event", "characters"]);
    expect(f[0]!.data).toEqual({ type: "npc.updated", seq: 7, ts: 7, sessionId: "s1", roleId: "npc", goals: [], knowledge: [], released: [] });
    expect(f[1]!.data.roles).toEqual([{ roleId: "npc", goals: ["G7"], facts: [{ n: 1, released: false }, { n: 2, released: true }] }]);
    // a role not seen before starts with nothing released
    conn.emit({ type: "event", event: { type: "npc.updated", seq: 8, ts: 8, sessionId: "s1", roleId: "fresh", goals: ["N"], knowledge: [] } as never });
    expect(chars(rec).at(-1)!.data.roles.at(-1)).toEqual({ roleId: "fresh", goals: ["N"], facts: [] });
    expect(rec.chunks.join("")).not.toContain("K7-SECRET");
  });

  it("factsFor returns the text for this session's channel, null for another session's or an unknown channel, and null after the stream closes", () => {
    const j = withNpcs({ npc: { goals: [], knowledge: [], released: [] } }, { npc: ["FACT-ONE", "FACT-TWO"], other: ["OTHER"] });
    const { h, open } = setup({ joined: j });
    const a = open(); const ch = (a.r as { channel: string }).channel;
    expect(h.factsFor("s1", ch)).toEqual([{ roleId: "npc", facts: [{ n: 1, text: "FACT-ONE" }, { n: 2, text: "FACT-TWO" }] }, { roleId: "other", facts: [{ n: 1, text: "OTHER" }] }]);
    expect(h.factsFor("s2", ch)).toBeNull();
    expect(h.factsFor("s1", "nope")).toBeNull();
    // a caller cannot change what the hub keeps
    (h.factsFor("s1", ch) as { facts: unknown[] }[])[0]!.facts.length = 0;
    expect(h.factsFor("s1", ch)![0]!.facts).toHaveLength(2);
    // the text is in no byte the stream wrote
    expect(a.rec.chunks.join("")).not.toContain("FACT-ONE");
    a.conn.drop(1006);
    expect(h.factsFor("s1", ch)).toBeNull();
    const b = open(); const ch2 = (b.r as { channel: string }).channel;
    (b.r as { close(): void }).close();
    expect(h.factsFor("s1", ch2)).toBeNull();
  });

  it("after an npc.updated it writes characters with that role updated while the event keeps empty goals and released", () => {
    const j = withNpcs({ npc: { goals: ["G0"], knowledge: [], released: [] }, other: { goals: ["O"], knowledge: [], released: [] } }, { npc: ["F1", "F2"], other: ["OF"], extraRole: ["X1"] });
    const { open } = setup({ joined: j });
    const { conn, rec } = open();
    const before = rec.frames().length;
    conn.emit({ type: "event", event: { type: "npc.updated", seq: 6, ts: 6, sessionId: "s1", roleId: "npc", goals: ["G1", "G2"], knowledge: ["KK"], released: ["F2"] } as never });
    const f = rec.frames().slice(before);
    expect(f.map((x) => x.event)).toEqual(["event", "characters"]);
    expect(f[0]!.data).toEqual({ type: "npc.updated", seq: 6, ts: 6, sessionId: "s1", roleId: "npc", goals: [], knowledge: [], released: [] });
    expect(f[1]!.id).toBeUndefined();
    expect(f[1]!.data.roles).toEqual([
      { roleId: "npc", goals: ["G1", "G2"], facts: [{ n: 1, released: false }, { n: 2, released: true }] },
      { roleId: "other", goals: ["O"], facts: [{ n: 1, released: false }] },
    ]);
    // a role the joined state did not list is added, with its facts
    conn.emit({ type: "event", event: { type: "npc.updated", seq: 7, ts: 7, sessionId: "s1", roleId: "extraRole", goals: ["E"], knowledge: [], released: ["X1"] } as never });
    expect((chars(rec).at(-1)!.data.roles as { roleId: string }[]).map((r) => r.roleId)).toEqual(["npc", "other", "extraRole"]);
    expect(chars(rec).at(-1)!.data.roles.at(-1)).toEqual({ roleId: "extraRole", goals: ["E"], facts: [{ n: 1, released: true }] });
    expect(rec.chunks.join("")).not.toMatch(/KK|"F2"|"F1"|"X1"/);
  });

  it("a complete replay folds its npc.updated events in order, so the last frame equals the current state", () => {
    const j = withNpcs({ npc: { goals: ["OLD"], knowledge: [], released: [] } }, { npc: ["F1", "F2"] }, { replay: { afterSeq: 0, toSeq: 7, events: 2, complete: true } });
    const { conn, rec } = setup({ joined: j }).open();
    conn.emit({ type: "event", event: { type: "npc.updated", seq: 6, ts: 6, sessionId: "s1", roleId: "npc", goals: ["MID"], knowledge: [], released: ["F1"] } as never });
    conn.emit({ type: "event", event: { type: "npc.updated", seq: 7, ts: 7, sessionId: "s1", roleId: "npc", goals: ["NEW"], knowledge: [], released: ["F1", "F2"] } as never });
    expect(chars(rec).at(-1)!.data.roles).toEqual([{ roleId: "npc", goals: ["NEW"], facts: [{ n: 1, released: true }, { n: 2, released: true }] }]);
  });

  it("a skipped replayed npc.updated after a reset writes no characters frame", () => {
    const j = withNpcs({ npc: { goals: ["G"], knowledge: [], released: [] } }, { npc: ["F1"] }, { replay: { afterSeq: 0, toSeq: 5, events: 1, complete: false } });
    const { conn, rec } = setup({ joined: j }).open();
    const n = chars(rec).length;
    conn.emit({ type: "event", event: { type: "npc.updated", seq: 5, ts: 5, sessionId: "s1", roleId: "npc", goals: ["SKIPPED"], knowledge: [], released: ["F1"] } as never });
    expect(chars(rec)).toHaveLength(n);
    expect(rec.events()).toHaveLength(0);
    conn.emit({ type: "event", event: { type: "npc.updated", seq: 6, ts: 6, sessionId: "s1", roleId: "npc", goals: ["LIVE"], knowledge: [], released: [] } as never });
    expect(chars(rec)).toHaveLength(n + 1);
    expect(chars(rec).at(-1)!.data.roles[0].goals).toEqual(["LIVE"]);
  });

  it("the scenes in joined keep each inject and drop malformed ones", () => {
    const j = join({ scenes: [{ id: "a", title: "T", goal: "G", timeBoxMinutes: 5, injects: [{ id: "i1", to: ["lead"], content: "C", atMinute: 2, hidden: "INJ-HIDDEN" }, { id: 3, to: [], content: "x" }] }, "junk"] } as never);
    const { rec } = setup({ joined: j }).open();
    expect(rec.frames()[1]!.data.scenes).toEqual([{ id: "a", title: "T", goal: "G", timeBoxMinutes: 5, injects: [{ id: "i1", to: ["lead"], content: "C", atMinute: 2 }] }]);
    expect(rec.chunks.join("")).not.toContain("INJ-HIDDEN");
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
    expect(ends).toBe(0); // retry, joined, characters and roster are over the cap and still open
    conn.emit({ type: "event", event: ev(6) });
    expect(ends).toBe(1);
    expect(conn.closed).toBe(1);
    expect(chunks.join("")).toContain("event: reconnecting");
    clean(timers, conn, h);
  });

  it("a replay flushed right after the opening is part of the opening; a stall after it still ends the stream (BUG-0024)", () => {
    const timers = manualTimers();
    const h = new FacilitatorHub({ setTimer: timers.setTimer, now: () => 0, maxPendingBytes: 1_200 });
    const chunks: string[] = []; let ends = 0;
    const conn = new FakeConn();
    for (let i = 6; i <= 15; i++) conn.queued.push({ type: "event", event: { ...ev(i), text: "x".repeat(400) } } as ServerMessage); // ~5 KB of replay
    h.open({ sessionId: "s1", expiresAt: 10 ** 13, conn: asConn(conn), joined: join({ replay: { afterSeq: 5, toSeq: 15, events: 10, complete: true } }), out: { write: (c) => { chunks.push(c); return false; }, end: () => { ends++; } } });
    expect(chunks.filter((c) => c.includes("event: event"))).toHaveLength(10); // the whole replay is delivered, in order
    expect(ends).toBe(0);
    for (let i = 16; i <= 18; i++) conn.emit({ type: "event", event: { ...ev(i), text: "x".repeat(400) } } as ServerMessage);
    expect(ends).toBe(1);
    expect(chunks.at(-1)).toContain("event: reconnecting");
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
    expect(parseSse(text).map((f) => f.event)).toEqual(["retry:3000", "joined", "reset", "characters", "roster"]);
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

describe("FacilitatorHub and voice (US-0071)", () => {
  it("a voice answer or a voice notice never reaches the console stream; the roster keeps voice and speaking picked (characterisation for the frames)", () => {
    const { open } = setup();
    const { conn, rec } = open();
    const before = rec.chunks.length;
    conn.emit({ type: "voice", state: "voice", muted: false });
    conn.emit({ type: "voice_notice", code: "stt_failed" });
    conn.emit({ type: "voice_notice", code: "voice_unavailable" });
    expect(rec.chunks.slice(before)).toEqual([]);
    conn.emit({ type: "roster", audience: "facilitator", entries: [{ ...entries[0]!, voice: "voice", speaking: true, participantId: "P-SECRET" } as FacilitatorRosterEntry] });
    expect(rec.frames().at(-1)).toEqual({ event: "roster", data: { entries: [{ ...entries[0], voice: "voice", speaking: true }] } });
  });
});

describe("FacilitatorHub commands", () => {
  const PAUSE = { type: "command", command: { command: "pause" }, by: "Kim" } as const;
  const END = { type: "end_now", by: "Kim" } as const;
  const opened = (o: Parameters<typeof setup>[0] = {}) => {
    const t = setup(o); const x = t.open();
    const channel = (x.r as { channel: string }).channel;
    const send = (message: Parameters<FacilitatorHub["send"]>[0]["message"] = PAUSE, sessionId = "s1", ch = channel) => t.h.send({ sessionId, channel: ch, message });
    return { ...t, ...x, channel, send };
  };
  const settled = async (p: Promise<unknown>) => { let v: unknown = "unsettled"; void p.then((x) => { v = x; }); await Promise.resolve(); await Promise.resolve(); return v; };

  it("send writes the message with a fresh ref and resolves ok on its ack", async () => {
    const { send, conn, rec } = opened();
    const before = rec.chunks.length;
    const p = send();
    expect(conn.sent).toEqual([{ ...PAUSE, ref: "ref-1" }]);
    expect(await settled(p)).toBe("unsettled");
    conn.emit({ type: "ack", ref: "ref-1" });
    expect(await p).toEqual({ kind: "ok" });
    expect(rec.chunks.length).toBe(before);
    const p2 = send(END);
    expect(conn.sent[1]).toEqual({ ...END, ref: "ref-2" });
    conn.emit({ type: "ack", ref: "ref-2" });
    expect(await p2).toEqual({ kind: "ok" });
  });

  it("an error with the ref resolves refused with its code and nothing reaches the page", async () => {
    const { send, conn, rec } = opened();
    const before = rec.chunks.length;
    const p = send();
    conn.emit({ type: "error", code: "stale_scene", message: "SECRET RUNTIME TEXT", ref: "ref-1" });
    expect(await p).toEqual({ kind: "refused", code: "stale_scene" });
    expect(rec.chunks.length).toBe(before);
  });

  it("a ref-less rate_limited, bad_json or bad_message while pending answers it; a ref-less log_failed is forwarded and answers nothing", async () => {
    for (const code of ["rate_limited", "bad_json", "bad_message"]) {
      const { send, conn } = opened();
      const p = send();
      conn.emit({ type: "error", code, message: "m" });
      expect(await p).toEqual({ kind: "refused", code });
    }
    const { send, conn, rec, timers } = opened();
    const p = send();
    conn.emit({ type: "error", code: "log_failed", message: "m" });
    expect(rec.frames().at(-1)).toEqual({ event: "error", data: { code: "log_failed", message: "the server reported an error" } });
    expect(await settled(p)).toBe("unsettled");
    timers.fire(10_000);
    expect(await p).toEqual({ kind: "unconfirmed" });
  });

  it("a ref-less rate_limited with nothing pending is forwarded as before", () => {
    const { conn, rec } = opened();
    conn.emit({ type: "error", code: "rate_limited", message: "m" });
    expect(rec.frames().at(-1)!.event).toBe("error");
  });

  it("an ack or error with another ref is dropped, not forwarded", async () => {
    const { send, conn, rec, timers } = opened();
    const before = rec.chunks.length;
    conn.emit({ type: "ack", ref: "ref-9" }); // nothing pending
    const p = send();
    conn.emit({ type: "ack", ref: "other" });
    conn.emit({ type: "error", code: "stale_scene", message: "m", ref: "other" });
    expect(rec.chunks.length).toBe(before);
    expect(await settled(p)).toBe("unsettled");
    timers.fire(10_000);
    expect(await p).toEqual({ kind: "unconfirmed" });
  });

  it("a second send while one is pending is pending and writes nothing to the socket", async () => {
    const { send, conn } = opened();
    const p = send();
    expect(await send()).toEqual({ kind: "pending" });
    expect(conn.sent).toHaveLength(1);
    conn.emit({ type: "ack", ref: "ref-1" });
    expect(await p).toEqual({ kind: "ok" });
    const p2 = send(); // free again
    expect(conn.sent).toHaveLength(2);
    conn.emit({ type: "ack", ref: "ref-2" });
    expect(await p2).toEqual({ kind: "ok" });
  });

  it("an unknown channel, another session's channel and a finished stream are no_channel", async () => {
    const { send, h, conn, channel, timers } = opened();
    expect(await send(PAUSE, "s1", "nope")).toEqual({ kind: "no_channel" });
    expect(await send(PAUSE, "s2")).toEqual({ kind: "no_channel" });
    expect(conn.sent).toEqual([]);
    conn.drop(1006);
    expect(await h.send({ sessionId: "s1", channel, message: PAUSE })).toEqual({ kind: "no_channel" });
    expect(timers.live()).toEqual([]);
  });

  it("the timeout resolves unconfirmed and a later ack is dropped", async () => {
    const { send, conn, timers, rec } = opened({ commandTimeoutMs: 777 });
    const p = send();
    timers.fire(777);
    expect(await p).toEqual({ kind: "unconfirmed" });
    const before = rec.chunks.length;
    conn.emit({ type: "ack", ref: "ref-1" });
    expect(rec.chunks.length).toBe(before);
    const p2 = send(); // the slot is free again
    conn.emit({ type: "ack", ref: "ref-2" });
    expect(await p2).toEqual({ kind: "ok" });
  });

  it("the default timeout is COMMAND_TIMEOUT_MS", async () => {
    expect(COMMAND_TIMEOUT_MS).toBe(10_000);
    const { send, timers } = opened();
    const p = send();
    expect(timers.live().some((t) => t.ms === COMMAND_TIMEOUT_MS)).toBe(true);
    timers.fire(COMMAND_TIMEOUT_MS);
    expect(await p).toEqual({ kind: "unconfirmed" });
  });

  it("a runtime close or a stalled page resolves the pending command unconfirmed", async () => {
    const a = opened(); const pa = a.send();
    a.conn.drop(1006);
    expect(await pa).toEqual({ kind: "unconfirmed" });
    clean(a.timers, a.conn, a.h);

    const timers = manualTimers();
    const h = new FacilitatorHub({ setTimer: timers.setTimer, now: () => 0, maxPendingBytes: 10, newChannelId: () => "ch-x", newRef: () => "r" });
    const conn = new FakeConn();
    h.open({ sessionId: "s1", expiresAt: 10 ** 13, conn: asConn(conn), joined: join(), out: { write: () => false, end: () => {} } });
    const p = h.send({ sessionId: "s1", channel: "ch-x", message: PAUSE });
    conn.emit({ type: "event", event: ev(6) }); // a write after the opening stalls the page
    expect(await p).toEqual({ kind: "unconfirmed" });
    clean(timers, conn, h);
  });

  it("closing the stream resolves the pending command unconfirmed and cancels its timer", async () => {
    const { send, r, timers, conn, h } = opened();
    const p = send();
    (r as { close(): void }).close();
    expect(await p).toEqual({ kind: "unconfirmed" });
    clean(timers, conn, h);
  });

  it("conn.send throwing is unconfirmed and frees the slot", async () => {
    const { send, conn, timers } = opened();
    conn.send = () => { throw new Error("closed"); };
    expect(await send()).toEqual({ kind: "unconfirmed" });
    expect(timers.live().some((t) => t.ms === 10_000)).toBe(false);
  });

  it("session.ended forwarded while an end_now is pending resolves it ok, and the stream still ends with ended", async () => {
    const { send, conn, rec, timers, h } = opened();
    const p = send(END);
    conn.emit({ type: "event", event: ev(6, "session.ended") });
    expect(await p).toEqual({ kind: "ok" });
    expect(rec.frames().slice(-2).map((x) => x.event)).toEqual(["event", "ended"]);
    clean(timers, conn, h);
  });

  it("session.ended while a pause is pending resolves it unconfirmed", async () => {
    const { send, conn, rec, timers, h } = opened();
    const p = send();
    conn.emit({ type: "event", event: ev(6, "session.ended") });
    expect(await p).toEqual({ kind: "unconfirmed" });
    expect(rec.frames().at(-1)!.event).toBe("ended");
    clean(timers, conn, h);
  });

  it("two tabs keep separate pending commands", async () => {
    const t = setup(); const a = t.open(); const b = t.open();
    const ca = (a.r as { channel: string }).channel; const cb = (b.r as { channel: string }).channel;
    const pa = t.h.send({ sessionId: "s1", channel: ca, message: PAUSE });
    const pb = t.h.send({ sessionId: "s1", channel: cb, message: PAUSE });
    expect(a.conn.sent).toHaveLength(1); expect(b.conn.sent).toHaveLength(1);
    b.conn.emit({ type: "ack", ref: (b.conn.sent[0] as { ref: string }).ref });
    expect(await pb).toEqual({ kind: "ok" });
    expect(await settled(pa)).toBe("unsettled");
    a.conn.emit({ type: "ack", ref: (a.conn.sent[0] as { ref: string }).ref });
    expect(await pa).toEqual({ kind: "ok" });
  });
});

describe("client and server roster types", () => {
  it("the console hook's roster entry equals the wire type", () => {
    expectTypeOf<ClientEntry>().toEqualTypeOf<FacilitatorRosterEntry>();
  });

  it("the console API's roster entry equals the wire type, ai key included", () => {
    expectTypeOf<ConsoleApiRosterEntry>().toEqualTypeOf<FacilitatorRosterEntry>();
    expectTypeOf<ConsoleApiRosterEntry["ai"]>().toEqualTypeOf<true | undefined>();
    expectTypeOf<FacilitatorRosterEntry["ai"]>().toEqualTypeOf<true | undefined>();
  });
});
