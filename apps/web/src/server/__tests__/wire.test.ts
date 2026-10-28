import { describe, expect, it } from "vitest";
import type { ClientMessage, JoinedFrame, ServerMessage } from "../wire";

// Type-level check only: wire.ts has no runtime code. A drift against the real runtime is caught by the Task 12 contract test.
describe("wire types", () => {
  it("accept the frames the BFF sends and reads", () => {
    const sent: ClientMessage[] = [
      { type: "join", sessionId: "s", roleId: "r", participantId: "p", issueCredential: true, joinCode: "ABCD", displayName: "Ann" },
      { type: "join", sessionId: "s", roleId: "r", participantId: "p", credential: "c", lastSeq: 3 },
      { type: "consent", noticeVersion: "v1" }, { type: "withdraw_consent" }, { type: "leave" }, { type: "say", text: "hi", expectSceneId: "sc" },
    ];
    const joined: JoinedFrame = { type: "joined", roleId: "r", state: {} as JoinedFrame["state"], credential: "c", logIdentity: "l", consent: { noticeVersion: "v1", notice: "n", given: false }, scenes: [], replay: { afterSeq: 0, toSeq: 0, events: 0, complete: true }, brief: "b", privateFacts: [], reconnectToken: "t" };
    const received: ServerMessage[] = [joined, { type: "roster", audience: "peers", entries: [{ roleId: "r", ready: true }] }, { type: "roster", audience: "facilitator", entries: [{ roleId: "r", joined: true, consented: true, connected: false }] }, { type: "error", code: "x", message: "m" }];
    expect(sent).toHaveLength(6);
    expect(received).toHaveLength(4);
  });
});
