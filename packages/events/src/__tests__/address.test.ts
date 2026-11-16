import { describe, expect, it } from "vitest";
import { applyPlayerEvent, initPlayerView, initialState, reduce, reduceReplay, roleWords, splitLeadingAddress, type PlayerSnapshot, type SessionEvent } from "../index.js";

// US-0082 (AC-0484, AC-0488): the addressing helper and the optional `to` on utterances through the folds.

const cands = [{ id: "tech_lead" }, { id: "account_manager" }, { id: "client_sponsor", labels: ["Priya Raman", "VP Operations, client side"] }];

describe("splitLeadingAddress", () => {
  it("test_address_role_id_and_label_are_parsed_and_stripped", () => {
    expect(splitLeadingAddress("@tech_lead can you size it?", cands)).toEqual({ to: "tech_lead", text: "can you size it?" });
    expect(splitLeadingAddress("  @Tech lead, can you size it?", cands)).toEqual({ to: "tech_lead", text: "can you size it?" });
    expect(splitLeadingAddress("@ACCOUNT-MANAGER: price?", cands)).toEqual({ to: "account_manager", text: "price?" });
    expect(splitLeadingAddress("@Priya Raman — what date works?", cands)).toEqual({ to: "client_sponsor", text: "what date works?" });
  });
  it("test_address_unknown_or_invented_role_is_left_unchanged", () => {
    expect(splitLeadingAddress("@cfo what now?", cands)).toBeNull();
    expect(splitLeadingAddress("@techie hello", cands)).toBeNull(); // whole words only
    expect(splitLeadingAddress("Hello @tech_lead", cands)).toBeNull(); // only at the start
    expect(splitLeadingAddress("@tech_lead", cands)).toBeNull(); // nothing would remain
    expect(splitLeadingAddress("@tech_lead ...", cands)).toBeNull();
    expect(splitLeadingAddress("no address", cands)).toBeNull();
    expect(splitLeadingAddress("@tech_lead hi", [])).toBeNull();
    expect(splitLeadingAddress(5 as unknown as string, cands)).toBeNull();
  });
  it("test_address_longest_name_wins", () => {
    const c = [{ id: "tech" }, { id: "tech_lead" }];
    expect(splitLeadingAddress("@tech lead hi", c)).toEqual({ to: "tech_lead", text: "hi" });
    expect(splitLeadingAddress("@tech hi", c)).toEqual({ to: "tech", text: "hi" });
  });
  it("test_address_roleWords_turns_ids_into_words", () => {
    expect(roleWords("tech_lead")).toBe("tech lead");
    expect(roleWords("a-b_c")).toBe("a b c");
  });
});

const env = (seq: number) => ({ seq, ts: 1_000 + seq, sessionId: "s" });
const started: SessionEvent = { ...env(1), type: "session.started", scenarioId: "sc", version: "1", roles: { me: { kind: "player" }, npc: { kind: "npc" } } };
const entered: SessionEvent = { ...env(2), type: "scene.entered", sceneId: "s1", participants: ["me", "npc"] };

describe("utterance `to` in the folds", () => {
  it("test_state_keeps_to_only_when_present", () => {
    let s = reduce(reduce(initialState(), started), entered);
    s = reduce(s, { ...env(3), type: "utterance", roleId: "npc", text: "hi", channel: "text", to: "me" });
    s = reduce(s, { ...env(4), type: "utterance", roleId: "me", text: "yo", channel: "text" });
    expect(s.transcript[0]).toEqual({ seq: 3, ts: 1_003, sceneId: "s1", roleId: "npc", text: "hi", channel: "text", to: "me" });
    expect(Object.hasOwn(s.transcript[1]!, "to")).toBe(false);
    // reduceReplay agrees
    let r = reduceReplay(reduceReplay(initialState(), started), entered);
    r = reduceReplay(r, { ...env(3), type: "utterance", roleId: "npc", text: "hi", channel: "text", to: "me" });
    expect(r.transcript[0]).toEqual(s.transcript[0]);
    // a malformed `to` (hand-edited log) is not kept
    const bad = reduce(reduce(reduce(initialState(), started), entered), { ...env(3), type: "utterance", roleId: "npc", text: "hi", channel: "text", to: 7 } as unknown as SessionEvent);
    expect(Object.hasOwn(bad.transcript[0]!, "to")).toBe(false);
  });
  it("test_player_view_carries_to_and_scene_participants", () => {
    const snap = { ...initialState(), whispers: [], status: "running", lastSeq: 3, currentScene: { id: "s1", enteredAt: 1, participants: ["me", "npc"], pausedMs: 0 },
      transcript: [{ seq: 3, ts: 1, sceneId: "s1", roleId: "npc", text: "hi", channel: "text", to: "me" }] } as PlayerSnapshot;
    const v = initPlayerView(snap);
    expect(v.scene?.participants).toEqual(["me", "npc"]);
    expect(v.transcript[0]!.to).toBe("me");
    const v2 = applyPlayerEvent(v, { ...env(4), type: "utterance", roleId: "me", text: "ok", channel: "text", to: "npc" });
    expect(v2.transcript.at(-1)!.to).toBe("npc");
    const v3 = applyPlayerEvent(v2, { ...env(5), type: "scene.entered", sceneId: "s2", participants: ["me"] });
    expect(v3.scene).toEqual({ id: "s2", enteredAt: 1_005, pausedMs: 0, participants: ["me"] });
    const v4 = applyPlayerEvent(v3, { ...env(6), type: "utterance", roleId: "me", text: "plain", channel: "text" });
    expect(Object.hasOwn(v4.transcript.at(-1)!, "to")).toBe(false);
  });
});
