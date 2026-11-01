import { describe, expect, it } from "vitest";
import { countWords, initialState, reduce, reduceReplay, type SessionEvent } from "../index.js";

// US-0059: words and lines per role, folded from `utterance` only.
const env = (seq: number) => ({ seq, ts: 1_000 + seq, sessionId: "s1" });
const started: SessionEvent = { ...env(1), type: "session.started", scenarioId: "x", version: "1", roles: { host: { kind: "player" }, guest: { kind: "npc" } } };
const entered: SessionEvent = { ...env(2), type: "scene.entered", sceneId: "a", participants: ["host", "guest"] };
const said = (seq: number, roleId: string, text: string): SessionEvent => ({ ...env(seq), type: "utterance", roleId, text, channel: "text" });
const log: SessionEvent[] = [started, entered, said(3, "host", "one two three"), said(4, "guest", "hi"), said(5, "host", "four five")];

describe("countWords", () => {
  it("counts whitespace-separated runs of characters", () => {
    for (const t of ["", "  \n\t"]) expect(countWords(t)).toBe(0);
    for (const t of ["Hello there", "a b", "東京 です", "👋 hi"]) expect(countWords(t)).toBe(2);
    expect(countWords("line\nbreak\ttab")).toBe(3);
    expect(countWords(undefined as unknown as string)).toBe(0);
  });
});

describe("talk", () => {
  it("starts empty", () => expect(initialState().talk).toEqual({}));

  it("reduce counts words and lines per role", () => {
    const s = log.reduce(reduce, initialState());
    expect(s.talk).toEqual({ host: { words: 5, lines: 2 }, guest: { words: 1, lines: 1 } });
  });

  it("reduceReplay agrees with reduce on talk", () => {
    expect(log.reduce(reduceReplay, initialState()).talk).toEqual(log.reduce(reduce, initialState()).talk);
  });

  it('an utterance from "__proto__" or "constructor" is counted as an own key and leaves Object.prototype untouched', () => {
    for (const fold of [reduce, reduceReplay]) {
      let s = fold(fold(initialState(), started), entered);
      s = fold(s, said(3, "__proto__", "a b"));
      s = fold(s, said(4, "constructor", "c"));
      s = fold(s, said(5, "__proto__", "d"));
      expect(Object.hasOwn(s.talk, "__proto__")).toBe(true);
      expect(Object.getOwnPropertyDescriptor(s.talk, "__proto__")?.value).toEqual({ words: 3, lines: 2 });
      expect(s.talk["constructor"]).toEqual({ words: 1, lines: 1 });
      expect(Object.getPrototypeOf(s.talk)).toBe(Object.prototype);
      expect(({} as Record<string, unknown>).words).toBeUndefined();
      expect(({} as Record<string, unknown>).lines).toBeUndefined();
    }
  });

  it("reduce does not mutate the previous state's talk", () => {
    const s1 = log.slice(0, 3).reduce(reduce, initialState());
    const before = JSON.stringify(s1.talk);
    const s2 = reduce(s1, said(4, "host", "more words here"));
    expect(JSON.stringify(s1.talk)).toBe(before);
    expect(s2.talk).not.toBe(s1.talk);
  });
});
