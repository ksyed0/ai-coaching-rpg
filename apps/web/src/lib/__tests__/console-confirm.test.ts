import { describe, expect, it } from "vitest";
import { audienceText, confirmCopy, who } from "../console-confirm";

describe("confirmCopy", () => {
  it("advance", () => {
    expect(confirmCopy({ kind: "advance", scene: "Kick-off" })).toEqual({
      title: "Move on from “Kick-off”?",
      description: "The scene ends for everyone in the room and the next scene begins. This cannot be undone.",
      confirmLabel: "Move on",
      tone: "danger",
    });
  });
  it("end_now", () => {
    expect(confirmCopy({ kind: "end_now" })).toEqual({
      title: "End the session now?",
      description: "The session ends for everyone in the room. Nobody can speak after this and the session cannot be restarted.",
      confirmLabel: "End session",
      tone: "danger",
    });
  });
  it("fire_inject, first time and again", () => {
    expect(confirmCopy({ kind: "fire_inject", injectId: "i1", audience: ["Ann (Client sponsor)", "Delivery lead"], again: false })).toEqual({
      title: "Fire inject “i1”?",
      description: "It is shown to Ann (Client sponsor) and Delivery lead. It cannot be taken back.",
      confirmLabel: "Fire inject",
      tone: "primary",
    });
    expect(confirmCopy({ kind: "fire_inject", injectId: "i1", audience: ["A"], again: true }).title).toBe("Fire inject “i1” again?");
  });
  it("whisper", () => {
    expect(confirmCopy({ kind: "whisper", recipient: "Ann (Client sponsor)" })).toEqual({
      title: "Whisper to Ann (Client sponsor)?",
      description: "Only Ann (Client sponsor) sees this message. It cannot be taken back.",
      confirmLabel: "Send whisper",
      tone: "primary",
    });
  });
  it("release_hidden", () => {
    expect(confirmCopy({ kind: "release_hidden", fact: 2, character: "Sam (Cfo) (AI character)" })).toEqual({
      title: "Release fact 2 of Sam (Cfo) (AI character)?",
      description: "Sam (Cfo) (AI character) may now share this fact with everyone in the room. It cannot be taken back.",
      confirmLabel: "Release fact",
      tone: "primary",
    });
  });
  it("remove, with and without a name", () => {
    expect(confirmCopy({ kind: "remove", name: "Ann", role: "Client sponsor" })).toEqual({
      title: "Remove Ann from Client sponsor?",
      description: "They are signed out of the Client sponsor seat and their code stops working. A new code for the seat is shown once. This affects the Client sponsor role only.",
      confirmLabel: "Remove",
      tone: "danger",
    });
    expect(confirmCopy({ kind: "remove", role: "Client sponsor" }).title).toBe("Remove the participant from Client sponsor?");
  });
  it("a name with U+202E is isolated in the title", () => {
    const t = confirmCopy({ kind: "remove", name: "ev‮il", role: "Cfo" }).title;
    expect(t).toBe("Remove ⁨ev‮il⁩ from Cfo?");
    expect(confirmCopy({ kind: "advance", scene: "a‮b" }).title).toBe("Move on from “⁨a‮b⁩”?");
  });
});

describe("audienceText", () => {
  it("of one, two and three labels", () => {
    expect(audienceText(["A"])).toBe("A");
    expect(audienceText(["A", "B"])).toBe("A and B");
    expect(audienceText(["A", "B", "C"])).toBe("A, B and C");
  });
});

describe("who", () => {
  it("names a seated player with the role label, an empty seat by label, an AI character marked", () => {
    expect(who("client_sponsor", { names: { client_sponsor: "Ann" }, ai: false })).toBe("Ann (Client sponsor)");
    expect(who("client_sponsor", { names: {}, ai: false })).toBe("Client sponsor");
    expect(who("cfo", { names: { cfo: "Sam" }, ai: true })).toBe("Sam (Cfo) (AI character)");
    expect(who("tech_lead", { names: { tech_lead: "Pat" }, ai: false, aiPlayer: true })).toBe("Tech lead (AI player)");
    expect(who("cfo", { names: {}, ai: true })).toBe("Cfo (AI character)");
  });
  it("isolates a name with a bidi control", () => {
    expect(who("cfo", { names: { cfo: "x‮y" }, ai: false })).toBe("⁨x‮y⁩ (Cfo)");
  });
});
