import { describe, expect, it } from "vitest";
import { isFacilitatorRoster } from "../wire";
import type { ClientMessage, JoinedFrame, ServerMessage } from "../wire";

// Type-level check only: wire.ts has no runtime code. A drift against the real runtime is caught by the Task 12 contract test.
describe("wire types", () => {
  it("accept the frames the BFF sends and reads", () => {
    const sent: ClientMessage[] = [
      { type: "join", sessionId: "s", roleId: "r", participantId: "p", issueCredential: true, joinCode: "ABCD", displayName: "Ann" },
      { type: "join", sessionId: "s", roleId: "r", participantId: "p", credential: "c", lastSeq: 3 },
      { type: "consent", noticeVersion: "v1" }, { type: "withdraw_consent" }, { type: "leave" }, { type: "say", text: "hi", expectSceneId: "sc" },
      { type: "join_facilitator", sessionId: "s", token: "t" }, { type: "start" },
      // US-0071: the voice choice and mute.
      { type: "voice_opt_in", noticeVersion: "v3" }, { type: "voice_opt_out" }, { type: "voice_mute", muted: true },
    ];
    const joined: JoinedFrame = { type: "joined", roleId: "r", state: {} as JoinedFrame["state"], credential: "c", logIdentity: "l", consent: { noticeVersion: "v1", notice: "n", given: false }, scenes: [], replay: { afterSeq: 0, toSeq: 0, events: 0, complete: true }, brief: "b", privateFacts: [], reconnectToken: "t" };
    const received: ServerMessage[] = [joined, { type: "roster", audience: "peers", entries: [{ roleId: "r", ready: true }] }, { type: "roster", audience: "facilitator", entries: [{ roleId: "r", joined: true, consented: true, connected: false }] }, { type: "error", code: "x", message: "m" },
      // US-0071: the voice answer, a private notice, and joined's own voice state.
      { type: "voice", state: "voice", muted: false }, { type: "voice_notice", code: "empty" }, { ...joined, voice: { state: "text_only", muted: true } }];
    expect(sent).toHaveLength(11);
    expect(received).toHaveLength(7);
  });

  it("isFacilitatorRoster accepts only the facilitator's roster frame", () => {
    expect(isFacilitatorRoster({ type: "roster", audience: "facilitator", entries: [] })).toBe(true);
    expect(isFacilitatorRoster({ type: "roster", audience: "peers", entries: [] })).toBe(false);
    expect(isFacilitatorRoster({ type: "error", code: "x", message: "m" })).toBe(false);
  });
});
