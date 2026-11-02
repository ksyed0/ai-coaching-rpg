// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MESSAGES } from "../messages";
import { MAX_GAP_RESYNCS, consoleStreamReducer, consoleStreamUrl, initialConsoleState, useConsoleStream } from "../use-console-stream";
import { FakeEventSource, ev, fakeFetch, snapshot } from "./fakes";

afterEach(cleanup);
beforeEach(() => FakeEventSource.reset());

const scenes = [{ id: "s1", title: "Kick-off", goal: "Agree.", timeBoxMinutes: 5 }];
function start(enabled = true, sessionId = "sess-1") {
  const f = fakeFetch();
  const hook = renderHook((p: { enabled: boolean }) => useConsoleStream(sessionId, { EventSource: FakeEventSource, fetch: f.fetch }, { enabled: p.enabled }), { initialProps: { enabled } });
  return { hook, es: () => FakeEventSource.last() };
}
const emit = (es: FakeEventSource, type: string, data: unknown, id?: string) => act(() => es.emit(type, data, id));
const joined = (es: FakeEventSource) => emit(es, "joined", { channel: "c1", scenes });
const utt = (seq: number, text: string) => ev(seq, "utterance", { roleId: "x", text, channel: "text" });
const texts = (h: ReturnType<typeof start>["hook"]) => h.result.current.view?.state.transcript.map((l) => l.text);

describe("useConsoleStream", () => {
  it("opens the console route; joined, reset, roster and events build the view", () => {
    const { hook, es } = start();
    expect(es().url).toBe(consoleStreamUrl("sess-1"));
    expect(es().url).toBe("/api/v1/console/sessions/sess-1/stream");
    expect(hook.result.current.conn).toBe("connecting");
    joined(es());
    expect(hook.result.current.conn).toBe("live");
    expect(hook.result.current.channel).toBe("c1");
    expect(hook.result.current.scenes).toEqual(scenes.map((c) => ({ ...c, injects: [] })));
    expect(hook.result.current.view).toBeNull();
    emit(es(), "reset", { state: snapshot({ status: "running", lastSeq: 2, transcript: [{ seq: 2, ts: 1, sceneId: null, roleId: "x", text: "hi", channel: "text" }] }) }, "2");
    emit(es(), "roster", { entries: [{ roleId: "x", name: "Sam", joined: true, consented: true, connected: true }] });
    emit(es(), "event", utt(3, "next"), "3");
    expect(texts(hook)).toEqual(["hi", "next"]);
    expect(hook.result.current.roster).toHaveLength(1);
  });

  it("a joined after a reconnect keeps the view and the next events continue it", () => {
    const { hook, es } = start();
    joined(es());
    emit(es(), "reset", { state: snapshot({ status: "running", lastSeq: 1 }) });
    emit(es(), "event", utt(2, "a"));
    act(() => es().drop());
    expect(hook.result.current.conn).toBe("reconnecting");
    expect(FakeEventSource.instances).toHaveLength(1);
    joined(es());
    expect(hook.result.current.conn).toBe("live");
    expect(texts(hook)).toEqual(["a"]);
    emit(es(), "event", utt(3, "b"));
    expect(texts(hook)).toEqual(["a", "b"]);
  });

  it("a gap closes the source and opens a new one; the fourth consecutive gap is final lost", () => {
    const { hook, es } = start();
    joined(es());
    emit(es(), "reset", { state: snapshot({ status: "running", lastSeq: 1 }) });
    emit(es(), "event", utt(2, "a"));
    for (let i = 1; i <= MAX_GAP_RESYNCS; i++) {
      const old = es();
      emit(old, "event", utt(10 * i, "hole"));
      expect(old.closed).toBe(true);
      expect(FakeEventSource.instances).toHaveLength(i + 1);
      expect(es().url).toBe(consoleStreamUrl("sess-1"));
      expect(hook.result.current.view?.state.transcript.map((l) => l.text)).toEqual(["a"]); // kept meanwhile
      expect(hook.result.current.final).toBeNull();
      joined(es()); // joined never replaces the view
      expect(texts(hook)).toEqual(["a"]);
    }
    emit(es(), "event", utt(99, "hole"));
    expect(hook.result.current.final).toEqual({ kind: "lost", message: MESSAGES.consoleLost });
    expect(es().closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(MAX_GAP_RESYNCS + 1);
  });

  it("a reset after a gap replaces the view", () => {
    const { hook, es } = start();
    joined(es());
    emit(es(), "reset", { state: snapshot({ status: "running", lastSeq: 1 }) });
    emit(es(), "event", utt(5, "hole"));
    emit(es(), "reset", { state: snapshot({ status: "running", lastSeq: 7, transcript: [{ seq: 7, ts: 1, sceneId: null, roleId: "x", text: "fresh", channel: "text" }] }) });
    expect(texts(hook)).toEqual(["fresh"]);
    expect(hook.result.current.view?.gap).toBe(false);
  });

  it("ended keeps the view and closes; stopped, expired and busy are final with their messages; reconnecting keeps the view", () => {
    const { hook, es } = start();
    joined(es());
    emit(es(), "reset", { state: snapshot({ status: "running", lastSeq: 1 }) });
    emit(es(), "event", utt(2, "a"));
    emit(es(), "reconnecting", {});
    expect(hook.result.current.conn).toBe("reconnecting");
    expect(es().closed).toBe(false);
    expect(texts(hook)).toEqual(["a"]);
    emit(es(), "ended", {});
    expect(hook.result.current.final).toEqual({ kind: "ended", message: MESSAGES.consoleEnded });
    expect(es().closed).toBe(true);
    expect(texts(hook)).toEqual(["a"]);
    const expected = { stopped: MESSAGES.consoleStopped, expired: MESSAGES.consoleExpired, busy: MESSAGES.consoleBusy } as const;
    for (const kind of ["stopped", "expired", "busy"] as const) {
      cleanup();
      FakeEventSource.reset();
      const s = start();
      emit(s.es(), kind, kind === "busy" ? { message: "ignored server text" } : {});
      expect(s.hook.result.current.final).toEqual({ kind, message: expected[kind] });
      expect(s.es().closed).toBe(true);
    }
  });

  it("readyState CLOSED on error is final closed", () => {
    const { hook, es } = start();
    act(() => es().fail());
    expect(hook.result.current.final).toEqual({ kind: "closed", message: MESSAGES.consoleClosed });
  });

  it("a server error event shows a notice and a malformed frame is ignored", () => {
    const { hook, es } = start();
    joined(es());
    emit(es(), "reset", { state: snapshot({ status: "running", lastSeq: 1 }) });
    emit(es(), "error", { code: "x", message: "the server reported an error" });
    expect(hook.result.current.notice).toBe(MESSAGES.consoleServerError);
    expect(hook.result.current.final).toBeNull();
    for (const t of ["joined", "reset", "event", "roster"]) { emit(es(), t, "{not json"); emit(es(), t, "null"); emit(es(), t, "[1]"); }
    emit(es(), "roster", { entries: [{ roleId: 1 }] });
    emit(es(), "reset", { state: { lastSeq: "x" } });
    expect(hook.result.current.conn).toBe("live");
    expect(hook.result.current.view?.state.lastSeq).toBe(1);
    expect(hook.result.current.roster).toEqual([]);
    emit(es(), "event", utt(2, "ok"));
    expect(hook.result.current.notice).toBeNull();
  });

  it("enabled false opens nothing; switching it on opens the stream; unmount and disable close it", () => {
    const { hook, es } = start(false);
    expect(FakeEventSource.instances).toHaveLength(0);
    hook.rerender({ enabled: true });
    expect(FakeEventSource.instances).toHaveLength(1);
    const first = es();
    hook.rerender({ enabled: false });
    expect(first.closed).toBe(true);
    hook.rerender({ enabled: true });
    const second = es();
    hook.unmount();
    expect(second.closed).toBe(true);
  });

  it("a resync that recovers resets the count: five gaps each followed by an in-order event never reach lost", () => {
    const { hook, es } = start();
    joined(es());
    emit(es(), "reset", { state: snapshot({ status: "running", lastSeq: 1 }) });
    let seq = 1;
    for (let i = 0; i < 5; i++) {
      emit(es(), "event", utt(seq + 5, "hole"));
      expect(FakeEventSource.instances).toHaveLength(i + 2);
      joined(es());
      emit(es(), "event", utt(seq + 1, "ok"));
      seq += 1;
      expect(hook.result.current.view?.gap).toBe(false);
    }
    expect(hook.result.current.final).toBeNull();
  });

  it("state does not survive stopped, then disable and enable", () => {
    const { hook, es } = start();
    joined(es());
    emit(es(), "reset", { state: snapshot({ status: "running", lastSeq: 1 }) });
    emit(es(), "roster", { entries: [{ roleId: "x", joined: true, consented: true, connected: true }] });
    emit(es(), "event", utt(9, "hole")); // one gap counted
    emit(es(), "stopped", {});
    expect(hook.result.current.final?.kind).toBe("stopped");
    hook.rerender({ enabled: false });
    hook.rerender({ enabled: true });
    const r = hook.result.current;
    expect(r.view).toBeNull();
    expect(r.final).toBeNull();
    expect(r.roster).toEqual([]);
    expect(r.scenes).toEqual([]);
    expect(r.channel).toBeNull();
    expect((r as unknown as { gaps: number }).gaps).toBe(0);
  });

  it("joined scenes keep their injects; a malformed inject is dropped", () => {
    const { hook, es } = start();
    const wire = [
      { ...scenes[0], injects: [{ id: "i1", to: ["a", "b"], content: "Alarm", atMinute: 2 }, { id: "i2", to: [], content: "Quiet" }, { id: 3, to: [], content: "x" }, { id: "i4", to: "all", content: "x" }, { id: "i5", to: [], content: 9 }, null, "s"] },
      { id: "s2", title: "Two", goal: "g", timeBoxMinutes: 3 },
      { id: "s3", title: "Three", goal: "g", timeBoxMinutes: 3, injects: "nope" },
      { id: "bad", title: 1, goal: "g", timeBoxMinutes: 3, injects: [] },
    ];
    emit(es(), "joined", { channel: "c1", scenes: wire });
    expect(hook.result.current.scenes).toEqual([
      { ...scenes[0], injects: [{ id: "i1", to: ["a", "b"], content: "Alarm", atMinute: 2 }, { id: "i2", to: [], content: "Quiet" }] },
      { id: "s2", title: "Two", goal: "g", timeBoxMinutes: 3, injects: [] },
      { id: "s3", title: "Three", goal: "g", timeBoxMinutes: 3, injects: [] },
    ]);
  });

  it("a characters frame replaces the list; a malformed entry is ignored, the rest kept", () => {
    const { hook, es } = start();
    joined(es());
    expect(hook.result.current.characters).toEqual([]);
    emit(es(), "characters", { roles: [{ roleId: "npc1", goals: ["g1"], facts: [{ n: 1, released: false }, { n: "2", released: true }, { n: 2, released: true }] }, { roleId: 5, goals: [], facts: [] }, { roleId: "npc2", goals: "x", facts: [] }, null] });
    expect(hook.result.current.characters).toEqual([{ roleId: "npc1", goals: ["g1"], facts: [{ n: 1, released: false }, { n: 2, released: true }] }]);
    emit(es(), "characters", { roles: [{ roleId: "npc3", goals: [], facts: [] }] });
    expect(hook.result.current.characters).toEqual([{ roleId: "npc3", goals: [], facts: [] }]);
    emit(es(), "characters", { nope: 1 });
    emit(es(), "characters", "junk");
    expect(hook.result.current.characters).toEqual([{ roleId: "npc3", goals: [], facts: [] }]);
  });

  it("a character fact that carries a text field keeps only its number and state: the text never enters the hook's state", () => {
    const { hook, es } = start();
    joined(es());
    emit(es(), "characters", { roles: [{ roleId: "npc1", goals: ["g1"], facts: [{ n: 1, released: false, text: "LEAKED-FACT-TEXT" }], knowledge: ["LEAKED-KNOWLEDGE"], text: "LEAKED-ROLE-TEXT" }] });
    expect(hook.result.current.characters).toEqual([{ roleId: "npc1", goals: ["g1"], facts: [{ n: 1, released: false }] }]);
    expect(JSON.stringify(hook.result.current)).not.toContain("LEAKED");
  });

  it("a reconnect's joined keeps characters until the next characters frame", () => {
    const { hook, es } = start();
    joined(es());
    emit(es(), "characters", { roles: [{ roleId: "npc1", goals: ["g"], facts: [] }] });
    act(() => es().drop());
    joined(es());
    expect(hook.result.current.characters).toEqual([{ roleId: "npc1", goals: ["g"], facts: [] }]);
    emit(es(), "characters", { roles: [] });
    expect(hook.result.current.characters).toEqual([]);
    emit(es(), "characters", { roles: [{ roleId: "npc1", goals: ["g"], facts: [] }] });
    emit(es(), "stopped", {});
    hook.rerender({ enabled: false });
    hook.rerender({ enabled: true });
    expect(hook.result.current.characters).toEqual([]);
  });

  it("actions after a final do not change the state (reducer)", () => {
    const base = consoleStreamReducer(consoleStreamReducer(initialConsoleState, { type: "reset", state: snapshot({ status: "running", lastSeq: 1 }) }), { type: "final", kind: "lost" });
    expect(base.final?.kind).toBe("lost");
    const actions: Parameters<typeof consoleStreamReducer>[1][] = [
      { type: "event", event: utt(2, "late") }, { type: "reset", state: snapshot({ lastSeq: 9 }) }, { type: "roster", entries: [] }, { type: "characters", characters: [] },
      { type: "joined", channel: "c", scenes: [] }, { type: "notice", text: "n" },
    ];
    for (const a of actions) expect(consoleStreamReducer(base, a)).toBe(base);
  });
});
