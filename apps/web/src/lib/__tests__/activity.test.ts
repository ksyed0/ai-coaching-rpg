import { describe, expect, it } from "vitest";
import type { PlayerLine, SessionEvent } from "@acr/events";
import { ACTIVITY_EXPIRY_MS, activityAfterEvent, applyActivity, isAiSpeaker, nextExpiryMs, speakerName, thinkingRoles, toActivity, waitingForYou } from "../activity";
import { initialUi, sessionReducer } from "../use-session";
import { consoleStreamReducer, initialConsoleState } from "../use-console-stream";

// US-0082 (AC-0480 to AC-0487): the browser's activity map and "waiting for you".

const env = (seq: number) => ({ seq, ts: seq, sessionId: "s" });
const line = (seq: number, roleId: string, to?: string, sceneId = "s1"): PlayerLine => ({ seq, ts: seq, roleId, text: "t", sceneId, ...(to ? { to } : {}) });

describe("activity map", () => {
  it("test_activity_parse_is_default_deny", () => {
    expect(toActivity({ roleId: "a", state: "thinking" })).toEqual({ roleId: "a", state: "thinking" });
    expect(toActivity({ roleId: "a", state: "idle", outcome: "timed_out" })).toEqual({ roleId: "a", state: "idle", outcome: "timed_out" });
    expect(toActivity({ roleId: "a", state: "idle", outcome: "boom" })).toEqual({ roleId: "a", state: "idle" });
    for (const bad of [null, "x", { state: "thinking" }, { roleId: "", state: "idle" }, { roleId: "a", state: "busy" }, { roleId: "r".repeat(200), state: "idle" }]) expect(toActivity(bad)).toBeNull();
  });
  it("test_activity_lines_clear_on_reply_scene_pause_end_and_expiry", () => {
    let m = applyActivity({}, { roleId: "npc", state: "thinking" }, 1_000);
    m = applyActivity(m, { roleId: "bot", state: "thinking" }, 2_000);
    expect(thinkingRoles(m, 3_000)).toEqual(["npc", "bot"]);
    expect(nextExpiryMs(m, 3_000)).toBe(1_000 + ACTIVITY_EXPIRY_MS - 3_000);
    // the reply lands
    m = activityAfterEvent(m, { ...env(5), type: "utterance", roleId: "npc", text: "hi", channel: "text" });
    expect(thinkingRoles(m, 3_000)).toEqual(["bot"]);
    // a lost idle: gone after the expiry
    expect(thinkingRoles(m, 2_000 + ACTIVITY_EXPIRY_MS)).toEqual([]);
    for (const e of [{ ...env(6), type: "scene.exited", sceneId: "s1", reason: "facilitator_advance" }, { ...env(6), type: "facilitator.command", command: "pause" }, { ...env(6), type: "session.ended", reason: "script_complete" }] as SessionEvent[]) {
      expect(thinkingRoles(activityAfterEvent(m, e), 3_000)).toEqual([]);
    }
    expect(activityAfterEvent(m, { ...env(6), type: "facilitator.command", command: "resume" })).toBe(m);
    expect(nextExpiryMs({}, 0)).toBeNull();
  });
  it("test_activity_reducers_take_frames_and_a_fresh_joined_clears", () => {
    const s = sessionReducer(initialUi, { type: "activity", roleId: "npc", state: "thinking", at: 5 });
    expect(s.activity).toEqual({ npc: { state: "thinking", at: 5 } });
    const c = consoleStreamReducer(initialConsoleState, { type: "activity", roleId: "bot", state: "idle", outcome: "timed_out", at: 7 });
    expect(c.activity).toEqual({ bot: { state: "idle", at: 7, outcome: "timed_out" } });
    const rejoined = sessionReducer(s, { type: "joined", joined: { roleId: "me", scenes: [] }, state: { lastSeq: 0, transcript: [], status: "running", paused: false, pausedSince: null, currentScene: null, aiRoles: [], whispers: [] } as never });
    expect(rejoined.activity).toEqual({});
  });
});

describe("naming and waiting for you", () => {
  const ai = new Set(["bot"]); const players = new Set(["me", "bot", "peer"]);
  it("test_speaker_name_follows_the_transcript_rule", () => {
    const o = { selfRole: "me", names: { peer: "Pat", bot: "Not shown" }, aiRoles: ai };
    expect(speakerName("me", o)).toBe("You");
    expect(speakerName("peer", o)).toBe("Pat");
    expect(speakerName("bot", o)).toBe("Bot"); // an AI player seat is named by its role
    expect(speakerName("client_sponsor", o)).toBe("Client sponsor");
    expect(isAiSpeaker("client_sponsor", ai, players)).toBe(true);
    expect(isAiSpeaker("peer", ai, players)).toBe(false);
  });
  it("test_waiting_for_you_until_the_player_speaks_or_the_scene_moves", () => {
    const o = { selfRole: "me", aiRoles: ai, playerRoles: players };
    const v = (transcript: PlayerLine[], over: Record<string, unknown> = {}) => ({ status: "running", scene: { id: "s1" }, transcript, ...over });
    expect(waitingForYou(v([line(1, "client_sponsor", "me")]), o)?.seq).toBe(1);
    expect(waitingForYou(v([line(1, "bot", "me")]), o)?.seq).toBe(1); // an AI player too
    expect(waitingForYou(v([line(1, "client_sponsor", "me"), line(2, "me")]), o)).toBeNull(); // answered
    expect(waitingForYou(v([line(1, "peer", "me")]), o)).toBeNull(); // a human's line is not an AI's
    expect(waitingForYou(v([line(1, "client_sponsor", "peer")]), o)).toBeNull(); // someone else's
    expect(waitingForYou(v([line(1, "client_sponsor", "me", "s0")]), o)).toBeNull(); // another scene
    expect(waitingForYou(v([line(1, "client_sponsor", "me")], { status: "ended" }), o)).toBeNull();
    expect(waitingForYou(v([line(1, "client_sponsor", "me")], { scene: null }), o)).toBeNull();
    expect(waitingForYou(v([line(1, "client_sponsor", "bot")]), { ...o, selfRole: "bot" })).toBeNull(); // an AI seat gets no banner
  });
});
