import { describe, expect, it } from "vitest";
import { initialState, reduce, type SessionEvent, type SessionState } from "@acr/events";
import { MAX_CONSOLE_LINES, applyConsoleEvent, talkRows, timelineText, viewFromReset, type ConsoleView } from "../console-view";

const scenes = [{ id: "s1", title: "The Gate", goal: "g", timeBoxMinutes: 5 }];
const ctx = { scenes, label: (r: string) => `<${r}>` };
const base = (seq: number) => ({ seq, ts: 1000 + seq, sessionId: "x" });
const started = (seq = 1): SessionEvent => ({ ...base(seq), type: "session.started", scenarioId: "sc", version: "1", roles: { a: { kind: "player" }, b: { kind: "player" }, n: { kind: "npc" } } });
const utter = (seq: number, roleId: string, text: string): SessionEvent => ({ ...base(seq), type: "utterance", roleId, text, channel: "voice" });
const fold = (events: SessionEvent[]): ConsoleView | null => events.reduce<ConsoleView | null>((v, e) => applyConsoleEvent(v, e, ctx), null);
const text = (e: SessionEvent, before: SessionState = initialState()) => timelineText(e, before, ctx)?.text;

describe("applyConsoleEvent", () => {
  it("folding a recorded sequence from seq 1 gives reduce's state and a timeline in seq order", () => {
    const evs: SessionEvent[] = [started(), { ...base(2), type: "scene.entered", sceneId: "s1", participants: ["a"] }, utter(3, "a", "hello there")];
    const v = fold(evs)!;
    expect(v.state).toEqual(evs.reduce(reduce, initialState()));
    expect(v.timeline.map((t) => t.seq)).toEqual([1, 2, 3]);
    expect(v.timeline[2]).toMatchObject({ kind: "line", text: "hello there", roleId: "a" });
    expect(v.gap).toBe(false);
  });

  it("null takes only seq 1", () => {
    expect(applyConsoleEvent(null, utter(2, "a", "x"), ctx)).toBeNull();
    expect(applyConsoleEvent(null, started(1), ctx)!.state.lastSeq).toBe(1);
  });

  it("a duplicate changes nothing (same object); a gap sets gap and folds nothing; the next in-order event clears gap; an unknown event type does not throw", () => {
    const v1 = fold([started()])!;
    expect(applyConsoleEvent(v1, started(1), ctx)).toBe(v1);
    const g = applyConsoleEvent(v1, utter(5, "a", "x"), ctx)!;
    expect(g.gap).toBe(true);
    expect(g.state).toBe(v1.state);
    const ok = applyConsoleEvent(g, utter(2, "a", "x"), ctx)!;
    expect(ok.gap).toBe(false);
    const unknown = { type: "future.thing", ...base(3) } as unknown as SessionEvent;
    const u = applyConsoleEvent(ok, unknown, ctx)!;
    expect(u.state.lastSeq).toBe(3);
    expect(u.timeline).toHaveLength(ok.timeline.length);
  });

  it("transcript and timeline are capped at 1000 while talk keeps the full count", () => {
    let v = fold([started()])!;
    for (let i = 2; i <= MAX_CONSOLE_LINES + 51; i++) v = applyConsoleEvent(v, utter(i, "a", "one two"), ctx)!;
    expect(v.state.transcript).toHaveLength(MAX_CONSOLE_LINES);
    expect(v.timeline).toHaveLength(MAX_CONSOLE_LINES);
    expect(v.state.talk.a).toEqual({ words: (MAX_CONSOLE_LINES + 50) * 2, lines: MAX_CONSOLE_LINES + 50 });
  });

  it("gm.decision appears only when the verdict changes", () => {
    const d = (seq: number, verdict: boolean): SessionEvent => ({ ...base(seq), type: "gm.decision", sceneId: "s1", condition: "c", verdict, reasoning: "r" });
    const v = fold([started(), { ...base(2), type: "scene.entered", sceneId: "s1", participants: ["a"] }, d(3, true), d(4, true), d(5, false)])!;
    expect(v.timeline.map((t) => t.text).filter((t) => t.startsWith("Game Master"))).toEqual(["Game Master: “c” is met", "Game Master: “c” is not met"]);
  });
});

describe("timelineText", () => {
  it("renders every event type", () => {
    expect(text(utter(1, "a", "hi"))).toBe("hi");
    expect(timelineText({ ...base(1), type: "facilitator.alert", level: "warning", message: "M" }, initialState(), ctx)).toMatchObject({ kind: "alert", text: "M", level: "warning" });
    expect(text({ ...base(1), type: "gm.no_verdict", sceneId: "s1", condition: "c", reason: "empty", attempts: 1 })).toBe("Game Master gave no verdict on “c”");
    const fe: SessionEvent = { ...base(1), type: "gm.fact_earned", sceneId: "s1", roleId: "n", fact: 2, reasoning: "" };
    expect(text(fe)).toBe("Game Master suggests releasing fact 2 of <n>");
    expect(text({ ...fe, autoRelease: true } as SessionEvent)).toBe("Game Master suggests releasing fact 2 of <n> (released automatically)");
    expect(text({ ...base(1), type: "inject.fired", injectId: "i", sceneId: "s1", to: ["a", "b"], content: "C" })).toBe("Inject to <a>, <b>: C");
    expect(text({ ...base(1), type: "scene.entered", sceneId: "s1", participants: [] })).toBe("Scene “The Gate” begins");
    expect(text({ ...base(1), type: "scene.exited", sceneId: "zz", reason: "gm_detects" })).toBe("Scene “zz” ends");
    expect(text(started())).toBe("Session started");
    expect(text({ ...base(1), type: "session.resumed", downFromTs: 1 })).toBe("The session server restarted; the session is paused");
    expect(text({ ...base(1), type: "session.ended", reason: "script_complete" })).toBe("Session ended");
    expect(text({ ...base(1), type: "session.ended", reason: "facilitator_end", message: "Bye" })).toBe("Session ended. Message to participants: Bye");
    expect(timelineText({ ...base(1), type: "npc.updated", roleId: "n", goals: [], knowledge: [], released: [] }, initialState(), ctx)).toBeNull();
  });

  it("renders facilitator commands with and without by", () => {
    const c = (by: string | undefined, rest: object) => text({ ...base(1), type: "facilitator.command", ...(by !== undefined && { by }), ...rest } as SessionEvent);
    expect(c("Ann", { command: "pause" })).toBe("Paused by Ann");
    expect(c(undefined, { command: "pause" })).toBe("Paused by the facilitator");
    expect(c("Ann", { command: "resume" })).toBe("Resumed by Ann");
    expect(c("Ann", { command: "advance" })).toBe("Advance requested by Ann");
    expect(c(undefined, { command: "fire_inject", injectId: "i1" })).toBe("Inject i1 fired by the facilitator");
    expect(c("Ann", { command: "whisper", roleId: "a", text: "psst" })).toBe("Whisper to <a> by Ann: psst");
    expect(c("Ann", { command: "release_hidden", roleId: "n", fact: 3 })).toBe("Fact 3 of <n> released by Ann");
    expect(c(undefined, { command: "set_npc_stance", roleId: "n", goals: [] })).toBe("Stance of <n> changed by the facilitator");
    expect(c("Ann", { command: "prompt_ai", roleId: "a" })).toBe("AI player for <a> prompted by Ann");
    expect(c(undefined, { command: "prompt_ai", roleId: "a" })).toBe("AI player for <a> prompted by the facilitator");
  });

  it("the timeline reads \"AI player for Tech lead prompted by Sam\", from the role label and never a participant name", () => {
    const labelled = { scenes, label: (r: string) => (r === "tech_lead" ? "Tech lead" : r) };
    const e = { ...base(1), type: "facilitator.command", command: "prompt_ai", roleId: "tech_lead", by: "Sam" } as SessionEvent;
    expect(timelineText(e, initialState(), labelled)?.text).toBe("AI player for Tech lead prompted by Sam");
  });
});

describe("talkRows", () => {
  it("lists silent players with 0, AI characters after the players, and a \"__proto__\" role as an ordinary row", () => {
    const roles = JSON.parse('{"n":{"kind":"npc"},"a":{"kind":"player"},"__proto__":{"kind":"player"}}');
    const state = { ...initialState(), roles, talk: { a: { words: 4, lines: 2 } } } as SessionState;
    expect(talkRows(state)).toEqual([
      { roleId: "a", kind: "player", words: 4, lines: 2 },
      { roleId: "__proto__", kind: "player", words: 0, lines: 0 },
      { roleId: "n", kind: "npc", words: 0, lines: 0 },
    ]);
  });
});

const deepFreeze = <T>(o: T): T => { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };

describe("hardening", () => {
  it("never throws on a null event or a non-integer seq and returns the view unchanged", () => {
    const v = fold([started()])!;
    for (const bad of [null, undefined, { ...utter(2, "a", "x"), seq: NaN }, { ...utter(2, "a", "x"), seq: 1.5 }, { ...utter(2, "a", "x"), seq: "2" }] as unknown as SessionEvent[]) {
      expect(applyConsoleEvent(v, bad, ctx)).toBe(v);
      expect(applyConsoleEvent(null, bad, ctx)).toBeNull();
    }
  });

  it("does not mutate the view or the event", () => {
    const v = deepFreeze(fold([started()])!);
    const e = deepFreeze(utter(2, "a", "x y"));
    expect(() => applyConsoleEvent(v, e, ctx)).not.toThrow();
    expect(v.timeline).toHaveLength(1);
    expect(v.state.lastSeq).toBe(1);
  });

  it("a reduce that throws still advances lastSeq only", () => {
    const v = fold([started()])!;
    const broken: ConsoleView = { ...v, state: { ...v.state, talk: undefined as unknown as SessionState["talk"] } };
    const out = applyConsoleEvent(broken, utter(2, "a", "x"), ctx)!;
    expect(out.state.lastSeq).toBe(2);
    expect(out.state.transcript).toHaveLength(0);
  });

  it("a gap followed by a duplicate keeps the gap and the same state", () => {
    const v = fold([started()])!;
    const g = applyConsoleEvent(v, utter(5, "a", "x"), ctx)!;
    const d = applyConsoleEvent(g, started(1), ctx)!;
    expect(d).toBe(g);
    expect(d.gap).toBe(true);
  });

  it("the cap keeps the newest lines", () => {
    let v = fold([started()])!;
    for (let i = 2; i <= MAX_CONSOLE_LINES + 11; i++) v = applyConsoleEvent(v, utter(i, "a", `m${i}`), ctx)!;
    expect(v.timeline[0]!.seq).toBe(12 + 0);
    expect(v.timeline.at(-1)!.text).toBe(`m${MAX_CONSOLE_LINES + 11}`);
    expect(v.state.transcript.at(-1)!.text).toBe(`m${MAX_CONSOLE_LINES + 11}`);
    expect(v.state.transcript[0]!.seq).toBe(12);
  });
});

describe("viewFromReset", () => {
  it("caps a long reset, keeps the notice first and the newest lines, and leaves talk whole", () => {
    let s = reduce(initialState(), started());
    for (let i = 2; i <= 1201; i++) s = reduce(s, utter(i, "a", "w"));
    const v = viewFromReset(s);
    expect(v.timeline).toHaveLength(MAX_CONSOLE_LINES);
    expect(v.timeline[0]!.kind).toBe("notice");
    expect(v.timeline.at(-1)!.seq).toBe(1201);
    expect(v.timeline[1]!.seq).toBe(1201 - (MAX_CONSOLE_LINES - 1) + 1);
    expect(v.state.transcript).toHaveLength(MAX_CONSOLE_LINES);
    expect(v.state.transcript.at(-1)!.seq).toBe(1201);
    expect(v.state.talk.a).toEqual({ words: 1200, lines: 1200 });
    expect(s.transcript).toHaveLength(1200);
  });

  it("adds the not-shown notice only after seq 0", () => {
    expect(viewFromReset(initialState()).timeline).toEqual([]);
    const s = [started(), utter(2, "a", "hey")].reduce(reduce, initialState());
    const v = viewFromReset(s);
    expect(v.timeline.map((t) => [t.kind, t.text])).toEqual([["notice", "Earlier Game Master notices and alerts are not shown after a reconnect."], ["line", "hey"]]);
    expect(v.gap).toBe(false);
  });
});

describe("timeline source and bidi isolation", () => {
  const ev = (e: object) => ({ ...base(2), ...e }) as SessionEvent;
  const entry = (e: SessionEvent) => timelineText(e, initialState(), ctx)!;
  it("labels every notice by its source", () => {
    expect(entry(ev({ type: "facilitator.command", command: "pause", by: "Sam" })).source).toBe("facilitator");
    expect(entry(ev({ type: "gm.no_verdict", condition: "c" })).source).toBe("gm");
    expect(entry(ev({ type: "gm.fact_earned", roleId: "n", fact: 1, autoRelease: false })).source).toBe("gm");
    expect(entry(ev({ type: "scene.entered", sceneId: "s1", participants: [] })).source).toBe("session");
    expect(entry(ev({ type: "session.ended", message: "bye" })).source).toBe("session");
    expect(entry(ev({ type: "session.resumed" })).source).toBe("session");
    expect(entry(ev({ type: "inject.fired", injectId: "i", to: ["a"], content: "x" })).source).toBe("session");
    expect(entry(ev({ type: "facilitator.alert", level: "info", message: "m" })).source).toBe("alert");
    expect(entry(utter(2, "a", "hi")).source).toBeUndefined();
    expect(viewFromReset({ ...initialState(), lastSeq: 3 }).timeline[0]!.source).toBe("session");
  });
  it("isolates a by, a role label and a whisper that hold a bidi control; normal values stay as they are", () => {
    expect(entry(ev({ type: "facilitator.command", command: "pause", by: "S\u202Eam" })).text).toBe("Paused by \u2068S\u202Eam\u2069");
    expect(entry(ev({ type: "facilitator.command", command: "pause", by: "Sam" })).text).toBe("Paused by Sam");
    expect(entry(ev({ type: "facilitator.command", command: "whisper", roleId: "a", text: "x\u2067y", by: "Sam" })).text).toBe("Whisper to <a> by Sam: \u2068x\u2067y\u2069");
    const bidi = { ...ctx, label: (r: string) => `\u202E${r}` };
    expect(timelineText(ev({ type: "gm.fact_earned", roleId: "n", fact: 2, autoRelease: false }), initialState(), bidi)!.text).toBe("Game Master suggests releasing fact 2 of \u2068\u202En\u2069");
  });
  it("isolates a Game Master condition and a scene title that hold a bidi control; normal ones stay as they are", () => {
    expect(entry(ev({ type: "gm.no_verdict", condition: "a\u202Eb" })).text).toBe("Game Master gave no verdict on \u201C\u2068a\u202Eb\u2069\u201D");
    expect(entry(ev({ type: "gm.no_verdict", condition: "plain" })).text).toBe("Game Master gave no verdict on \u201Cplain\u201D");
    const titled = { ...ctx, scenes: [{ id: "s1", title: "T\u2067x", goal: "g", timeBoxMinutes: 1 }] };
    expect(timelineText(ev({ type: "scene.entered", sceneId: "s1", participants: [] }), initialState(), titled)!.text).toBe("Scene \u201C\u2068T\u2067x\u2069\u201D begins");
    expect(entry(ev({ type: "scene.entered", sceneId: "zz", participants: [] })).text).toBe("Scene \u201Czz\u201D begins");
  });
});
