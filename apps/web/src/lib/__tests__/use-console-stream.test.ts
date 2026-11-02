// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MESSAGES } from "../messages";
import { MAX_GAP_RESYNCS, consoleStreamUrl, useConsoleStream } from "../use-console-stream";
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
    expect(hook.result.current.scenes).toEqual(scenes);
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

  it("a gap closes the source and opens a new one; the fourth gap is final lost", () => {
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
});
