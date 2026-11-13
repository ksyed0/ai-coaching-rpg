import { describe, expect, it } from "vitest";
import { consoleActivity, playerActivity } from "../activity-copy";
import { StreamHub, type SessionCookie } from "../stream-hub";
import { FacilitatorHub } from "../facilitator-hub";
import type { FacilitatorJoin } from "../facilitator-socket";
import { consoleEvent } from "../facilitator-copies";
import type { JoinedFrame } from "../wire";
import { asConn, FakeConn, manualTimers, sseRecorder } from "./fakes";

// US-0082 (AC-0480, AC-0482, AC-0496): the BFF's copies of the transient `activity` frame and of an addressed utterance.

describe("activity copies", () => {
  it("test_activity_copy_player_drops_the_outcome_and_any_other_key", () => {
    expect(playerActivity({ roleId: "a", state: "thinking", outcome: "failed", extra: 1 } as never)).toEqual({ roleId: "a", state: "thinking" });
    expect(playerActivity({ roleId: "a", state: "typing" })).toBeNull();
    expect(playerActivity({ roleId: "", state: "idle" })).toBeNull();
    expect(playerActivity({ roleId: "r".repeat(500), state: "idle" })).toBeNull();
    expect(playerActivity({ state: "idle" })).toBeNull();
  });
  it("test_activity_copy_console_keeps_a_known_outcome_only", () => {
    expect(consoleActivity({ roleId: "a", state: "idle", outcome: "timed_out" })).toEqual({ roleId: "a", state: "idle", outcome: "timed_out" });
    expect(consoleActivity({ roleId: "a", state: "idle", outcome: "exploded" })).toEqual({ roleId: "a", state: "idle" });
    expect(consoleActivity({ roleId: 5, state: "idle" })).toBeNull();
  });
  it("test_console_utterance_copy_keeps_to", () => {
    const base = { seq: 3, ts: 3, sessionId: "s", type: "utterance", roleId: "a", text: "t", channel: "text" } as const;
    expect(consoleEvent({ ...base, to: "b" })).toMatchObject({ to: "b" });
    expect(Object.hasOwn(consoleEvent(base), "to")).toBe(false);
  });
});

const cookie: SessionCookie = { sessionId: "s1", roleId: "delivery_lead", participantId: "p-1", credential: "C".repeat(40), logIdentity: "log-1", expiresAt: 10 ** 13 };
const joined = (): JoinedFrame => ({
  type: "joined", roleId: "delivery_lead", brief: "b", privateFacts: [], reconnectToken: "R", state: { lastSeq: 5, status: "running", paused: false, pausedSince: null, currentScene: null, transcript: [] } as unknown as JoinedFrame["state"],
  scenes: [], logIdentity: "log-1", replay: { afterSeq: 0, toSeq: 5, events: 0, complete: true },
});

describe("StreamHub activity", () => {
  it("test_stream_hub_activity_is_a_named_event_without_an_id_or_outcome", () => {
    const t = manualTimers();
    const h = new StreamHub({ maxStreams: 10, maxStreamsPerSession: 10, maxStreamsPerAddress: 10, setTimer: t.setTimer, now: () => 0 });
    const conn = new FakeConn(); const rec = sseRecorder();
    h.open(cookie, "198.51.100.1", asConn(conn), joined(), rec.out);
    conn.emit({ type: "activity", roleId: "client_sponsor", state: "thinking", outcome: "timed_out" } as never);
    conn.emit({ type: "activity", roleId: "client_sponsor", state: "busy" } as never);
    const frames = rec.frames().filter((f) => f.event === "activity");
    expect(frames).toEqual([{ event: "activity", data: { roleId: "client_sponsor", state: "thinking" } }]);
    expect(rec.chunks.join("")).not.toContain("timed_out");
  });
});

describe("FacilitatorHub activity", () => {
  it("test_facilitator_hub_activity_carries_the_outcome", () => {
    const t = manualTimers();
    const h = new FacilitatorHub({ setTimer: t.setTimer, now: () => 0, newChannelId: () => "ch-1", newRef: () => "ref-1" });
    const conn = new FakeConn(); const rec = sseRecorder();
    const state = { status: "running", lastSeq: 5, scenarioId: "sc", version: "1", roles: {}, currentScene: null, sceneHistory: [], paused: false, pausedSince: null, transcript: [], injectsFired: [], npcs: {}, advanceRequested: false, gmVerdicts: {}, factsEarned: {}, talk: {}, aiRoles: [], whispers: {}, whisperFloor: {} };
    const j = { frame: { type: "joined", roleId: "facilitator", state, scenes: [], replay: { afterSeq: 0, toSeq: 5, events: 0, complete: true } }, roster: [], status: "running" } as unknown as FacilitatorJoin;
    h.open({ sessionId: "s1", expiresAt: 10 ** 13, conn: asConn(conn), joined: j, out: rec.out });
    conn.emit({ type: "activity", roleId: "tech_lead", state: "idle", outcome: "timed_out", x: 1 } as never);
    expect(rec.frames().filter((f) => f.event === "activity")).toEqual([{ event: "activity", data: { roleId: "tech_lead", state: "idle", outcome: "timed_out" } }]);
  });
});
