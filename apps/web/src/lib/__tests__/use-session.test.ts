// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initPlayerView } from "@acr/events";
import { REMOVED_MESSAGE, SIGNED_OUT_MESSAGE } from "../../server/handlers";
import { MESSAGES } from "../messages";
import { MAX_TRANSCRIPT_LINES, useSession, type SessionDeps } from "../use-session";
import { FakeEventSource, ev, fakeFetch, joinedFrame, ok, refused, snapshot } from "./fakes";

afterEach(cleanup);
beforeEach(() => FakeEventSource.reset());

function start(deps: Partial<SessionDeps> = {}, sessionId = "sess-1") {
  const f = fakeFetch();
  const hook = renderHook(() => useSession(sessionId, { EventSource: FakeEventSource, fetch: f.fetch, ...deps }));
  return { hook, f, es: () => FakeEventSource.last() };
}
const emit = (es: FakeEventSource, type: string, data: unknown, id?: string) => act(() => es.emit(type, data, id));

describe("useSession: the stream", () => {
  it("opens the native EventSource on the stream route for this session (no cookie handling, no reconnect loop of its own)", () => {
    const { es } = start({}, "sess/1?x");
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(es().url).toBe("/api/v1/stream?session=sess%2F1%3Fx");
  });

  it("seeds the view from the joined snapshot and applies events after it; duplicates are dropped", () => {
    const { hook, es } = start();
    emit(es(), "joined", joinedFrame({ state: snapshot({ status: "running", lastSeq: 3 }) }));
    expect(hook.result.current.state.conn).toBe("live");
    expect(hook.result.current.state.view?.lastSeq).toBe(3);
    emit(es(), "event", ev(2, "utterance", { roleId: "x", text: "old", channel: "text" }), "2");
    emit(es(), "event", ev(4, "utterance", { roleId: "x", text: "new", channel: "text" }), "4");
    expect(hook.result.current.state.view?.transcript.map((l) => l.text)).toEqual(["new"]);
  });

  it("a reconnect whose replay is complete keeps the local view and applies the replayed events", () => {
    const { hook, es } = start();
    emit(es(), "joined", joinedFrame({ state: snapshot({ status: "running", lastSeq: 1 }) }));
    emit(es(), "event", ev(2, "utterance", { roleId: "x", text: "a", channel: "text" }));
    act(() => es().drop());
    // The runtime's snapshot is the head; the replay brings 3 again after it.
    emit(es(), "joined", joinedFrame({ state: snapshot({ status: "running", lastSeq: 3 }), replay: { afterSeq: 2, toSeq: 3, events: 1, complete: true } }));
    emit(es(), "event", ev(3, "utterance", { roleId: "x", text: "b", channel: "text" }));
    expect(hook.result.current.state.view?.transcript.map((l) => l.text)).toEqual(["a", "b"]);
  });

  it("the reconnect banner appears after a dropped stream and clears after reset", () => {
    const { hook, es } = start();
    emit(es(), "joined", joinedFrame({ state: snapshot({ status: "running", lastSeq: 1 }) }));
    emit(es(), "event", ev(2, "utterance", { roleId: "x", text: "before", channel: "text" }));
    act(() => es().drop());
    expect(hook.result.current.state.conn).toBe("reconnecting");
    expect(hook.result.current.state.notice).toBeNull(); // the browser's own "error" event is not a server error frame
    expect(es().closed).toBe(false); // the browser reconnects with Last-Event-ID; we never close or reopen it ourselves
    expect(FakeEventSource.instances).toHaveLength(1);
    // Back: the log changed, so the BFF sends a reset with the whole view, which replaces ours.
    const fresh = snapshot({ status: "running", lastSeq: 7, transcript: [{ seq: 7, ts: 5, sceneId: null, roleId: "y", text: "after", channel: "text" }] });
    emit(es(), "joined", joinedFrame({ state: fresh, logIdentity: "log-2", replay: { afterSeq: 2, toSeq: 7, events: 0, complete: false } }));
    emit(es(), "reset", initPlayerView(fresh), "7");
    expect(hook.result.current.state.conn).toBe("live");
    expect(hook.result.current.state.view?.transcript.map((l) => l.text)).toEqual(["after"]);
  });

  it("a final `reconnecting` event shows the banner and leaves the EventSource to reconnect", () => {
    const { hook, es } = start();
    emit(es(), "reconnecting", {});
    expect(hook.result.current.state.conn).toBe("reconnecting");
    expect(es().closed).toBe(false);
  });

  it("a reset clears the local view: lines from the old log do not survive", () => {
    const { hook, es } = start();
    emit(es(), "joined", joinedFrame({ state: snapshot({ status: "running", lastSeq: 9 }) }));
    emit(es(), "event", ev(10, "utterance", { roleId: "x", text: "old log", channel: "text" }));
    emit(es(), "reset", initPlayerView(snapshot({ status: "running", lastSeq: 0 })), "0");
    expect(hook.result.current.state.view?.transcript).toEqual([]);
    emit(es(), "event", ev(1, "utterance", { roleId: "x", text: "new log", channel: "text" }));
    expect(hook.result.current.state.view?.transcript.map((l) => l.text)).toEqual(["new log"]);
  });

  it("superseded and signed_out call es.close and show their messages", () => {
    const a = start();
    emit(a.es(), "joined", joinedFrame());
    emit(a.es(), "superseded", {});
    expect(a.es().closed).toBe(true);
    expect(a.hook.result.current.state.final).toEqual({ kind: "superseded", message: MESSAGES.superseded });
    expect(MESSAGES.superseded).toMatch(/open in another tab/);
    a.hook.unmount();

    // A bare final event with no joined first.
    const b = start();
    emit(b.es(), "signed_out", { message: SIGNED_OUT_MESSAGE });
    expect(b.es().closed).toBe(true);
    expect(b.hook.result.current.state.final?.kind).toBe("signed_out");
    expect(b.hook.result.current.state.final?.message).toContain(SIGNED_OUT_MESSAGE);
  });

  it("use-session finishes on removed with MESSAGES.removed", () => {
    const a = start();
    emit(a.es(), "joined", joinedFrame());
    emit(a.es(), "removed", { message: "ignored: the page uses its own text" });
    expect(a.es().closed).toBe(true);
    expect(a.hook.result.current.state.final).toEqual({ kind: "removed", message: MESSAGES.removed });
  });

  it("REMOVED_MESSAGE equals MESSAGES.removed", () => {
    expect(REMOVED_MESSAGE).toBe(MESSAGES.removed);
    expect(MESSAGES.removed).toBe("The facilitator removed you from this session.");
  });

  it("ended and expired also close the EventSource, so the browser does not reconnect", () => {
    for (const kind of ["ended", "expired"] as const) {
      const s = start();
      emit(s.es(), kind, {});
      expect(s.es().closed).toBe(true);
      expect(s.hook.result.current.state.final?.kind).toBe(kind);
      s.hook.unmount();
    }
  });

  it("a joined snapshot of an ended session closes the stream", () => {
    const { hook, es } = start();
    emit(es(), "joined", joinedFrame({ state: snapshot({ status: "ended" }) }));
    expect(es().closed).toBe(true);
    expect(hook.result.current.state.final?.kind).toBe("ended");
  });

  it("a stream the browser closed (an HTTP error: 401, 403, 406 or a 503 from a full cap) says to reload, then ask the facilitator, with no retry loop", () => {
    const { hook, es } = start();
    act(() => es().fail());
    expect(hook.result.current.state.final?.kind).toBe("closed");
    expect(hook.result.current.state.final?.message).toBe("The connection to this session was closed. Reload the page; if that does not help, ask your facilitator.");
    expect(hook.result.current.state.final?.message).not.toContain(SIGNED_OUT_MESSAGE);
    expect(es().closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect("retry" in hook.result.current).toBe(false);
  });

  it("a server error frame (which a browser also hands to onerror, readyState OPEN) keeps the stream live; the notice clears on the next event, joined or reset", () => {
    const { hook, es } = start();
    emit(es(), "joined", joinedFrame({ state: snapshot({ status: "running", lastSeq: 1 }) }));
    emit(es(), "error", { code: "log_failed", message: "x" });
    expect(hook.result.current.state.conn).toBe("live");
    expect(hook.result.current.state.final).toBeNull();
    expect(hook.result.current.state.notice).toBe(MESSAGES.serverError);
    emit(es(), "event", ev(2, "utterance", { roleId: "x", text: "a", channel: "text" }));
    expect(hook.result.current.state.notice).toBeNull();
    emit(es(), "error", { code: "log_failed", message: "x" });
    emit(es(), "joined", joinedFrame({ state: snapshot({ status: "running", lastSeq: 2 }) }));
    expect(hook.result.current.state.notice).toBeNull();
    emit(es(), "error", { code: "log_failed", message: "x" });
    emit(es(), "reset", initPlayerView(snapshot({ status: "running", lastSeq: 2 })));
    expect(hook.result.current.state.notice).toBeNull();
  });

  it("an error after a final event does not replace the final message", () => {
    const { hook, es } = start();
    emit(es(), "superseded", {});
    act(() => es().onerror?.(new Event("error")));
    expect(hook.result.current.state.final?.kind).toBe("superseded");
  });

  it("roster frames replace the roster; an error frame shows a notice; malformed data is ignored", () => {
    const { hook, es } = start();
    emit(es(), "roster", { audience: "peers", entries: [{ roleId: "a", name: "Sam", ready: true }] });
    expect(hook.result.current.state.roster).toEqual([{ roleId: "a", name: "Sam", ready: true }]);
    emit(es(), "roster", "{not json");
    emit(es(), "roster", { audience: "peers", entries: "nope" });
    emit(es(), "joined", { roleId: 5 });
    emit(es(), "reset", { lastSeq: "x" });
    emit(es(), "event", null);
    expect(hook.result.current.state.roster).toHaveLength(1);
    expect(hook.result.current.state.joined).toBeNull();
    emit(es(), "error", { code: "log_failed", message: "the server reported an error" });
    expect(hook.result.current.state.notice).toBe(MESSAGES.serverError);
  });

  it("a joined frame with only the required fields is accepted; bad optional fields are dropped, not trusted", () => {
    const { hook, es } = start();
    emit(es(), "event", ev(1, "utterance", { roleId: "x", text: "before any join", channel: "text" }));
    expect(hook.result.current.state.view).toBeNull();
    emit(es(), "joined", { roleId: "am", state: snapshot(), consent: { noticeVersion: 1 }, scenes: [{ id: "s1" }, "x"], privateFacts: [3], brief: 7 });
    const j = hook.result.current.state.joined!;
    expect(j).toEqual({ roleId: "am", scenes: [] });
    emit(es(), "joined", { roleId: "am", state: snapshot(), scenes: "x" });
    expect(hook.result.current.state.joined?.scenes).toEqual([]);
    emit(es(), "joined", { roleId: "am", state: { lastSeq: 0 } });
    emit(es(), "roster", { audience: "peers", entries: [{ roleId: "a", ready: true, name: 5 }] });
    expect(hook.result.current.state.roster).toEqual([]);
  });

  it("a long reset view is capped too", () => {
    const { hook, es } = start();
    const v = initPlayerView(snapshot());
    const lines = Array.from({ length: MAX_TRANSCRIPT_LINES + 1 }, (_, i) => ({ seq: i + 1, ts: 1, roleId: "x", text: `l${i}`, sceneId: null }));
    emit(es(), "reset", { ...v, transcript: lines });
    expect(hook.result.current.state.view!.transcript).toHaveLength(MAX_TRANSCRIPT_LINES);
  });

  it("keeps at most MAX_TRANSCRIPT_LINES lines", () => {
    const { hook, es } = start();
    emit(es(), "joined", joinedFrame({ state: snapshot({ status: "running" }) }));
    act(() => {
      for (let i = 1; i <= MAX_TRANSCRIPT_LINES + 5; i++) es().emit("event", ev(i, "utterance", { roleId: "x", text: `l${i}`, channel: "text" }));
    });
    const t = hook.result.current.state.view!.transcript;
    expect(t).toHaveLength(MAX_TRANSCRIPT_LINES);
    expect(t.at(-1)!.text).toBe(`l${MAX_TRANSCRIPT_LINES + 5}`);
  });

  it("closes the EventSource on unmount", () => {
    const { hook, es } = start();
    hook.unmount();
    expect(es().closed).toBe(true);
  });
});

describe("useSession: actions", () => {
  it("consent posts the notice version over fetch with the custom header, same-origin credentials and a JSON body", async () => {
    const f = fakeFetch();
    const hook = renderHook(() => useSession("sess-1", { EventSource: FakeEventSource, fetch: f.fetch }));
    emit(FakeEventSource.last(), "joined", joinedFrame());
    let r: unknown;
    await act(async () => { r = await hook.result.current.consent(); });
    expect(r).toEqual({ ok: true });
    expect(f.calls).toHaveLength(1);
    const c = f.calls[0]!;
    expect(c.url).toBe("/api/v1/consent");
    expect(c.init.method).toBe("POST");
    expect(c.init.credentials).toBe("same-origin");
    expect(new Headers(c.init.headers).get("X-Requested-With")).toBe("scenecoach");
    expect(new Headers(c.init.headers).get("Content-Type")).toBe("application/json");
    expect(c.body).toEqual({ noticeVersion: "v1" });
    expect(hook.result.current.state.joined?.consent?.given).toBe(true);
  });

  it("consent before the stream has delivered a notice sends nothing", async () => {
    const f = fakeFetch();
    const hook = renderHook(() => useSession("sess-1", { EventSource: FakeEventSource, fetch: f.fetch }));
    let r: { ok: boolean } | undefined;
    await act(async () => { r = await hook.result.current.consent(); });
    expect(r?.ok).toBe(false);
    expect(f.calls).toHaveLength(0);
  });

  it("withdraw posts {withdraw:true}, then closes the stream and says the seat is free", async () => {
    const f = fakeFetch();
    const hook = renderHook(() => useSession("sess-1", { EventSource: FakeEventSource, fetch: f.fetch }));
    emit(FakeEventSource.last(), "joined", joinedFrame());
    await act(async () => { await hook.result.current.withdraw(); });
    expect(f.calls[0]!.url).toBe("/api/v1/consent");
    expect(f.calls[0]!.body).toEqual({ withdraw: true });
    expect(FakeEventSource.last().closed).toBe(true);
    expect(hook.result.current.state.final?.kind).toBe("left");
  });

  it("leave posts to /leave and closes the stream; a refusal keeps it open and returns the server's message", async () => {
    let answer: { status: number; body: unknown } = { status: 409, body: refused("already_started", "The session has already started.") };
    const f = fakeFetch(() => answer);
    const hook = renderHook(() => useSession("sess-1", { EventSource: FakeEventSource, fetch: f.fetch }));
    emit(FakeEventSource.last(), "joined", joinedFrame());
    let r: unknown;
    await act(async () => { r = await hook.result.current.leave(); });
    expect(r).toEqual({ ok: false, message: "The session has already started." });
    expect(FakeEventSource.last().closed).toBe(false);
    answer = { status: 200, body: ok({}) };
    await act(async () => { r = await hook.result.current.leave(); });
    expect(f.calls.map((c) => c.url)).toEqual(["/api/v1/leave", "/api/v1/leave"]);
    expect(FakeEventSource.last().closed).toBe(true);
    expect(hook.result.current.state.final?.kind).toBe("left");
  });

  it("say before any scene sends no scene id; a failed post reports a generic message", async () => {
    const f = fakeFetch(() => ({ status: 500, body: "nope" }));
    const hook = renderHook(() => useSession("sess-1", { EventSource: FakeEventSource, fetch: f.fetch }));
    let r: unknown;
    await act(async () => { r = await hook.result.current.say("hi"); });
    expect(f.calls[0]!.body).toEqual({ text: "hi" });
    expect(r).toEqual({ ok: false, message: MESSAGES.generic });
    await act(async () => { r = await hook.result.current.withdraw(); });
    expect(FakeEventSource.last().closed).toBe(false);
  });

  it("a send with no open stream (409 no_stream) reads as reconnecting", async () => {
    const f = fakeFetch(() => ({ status: 409, body: refused("no_stream", "Open the session page first.") }));
    const hook = renderHook(() => useSession("sess-1", { EventSource: FakeEventSource, fetch: f.fetch }));
    let r: unknown;
    await act(async () => { r = await hook.result.current.say("hi"); });
    expect(r).toEqual({ ok: false, message: MESSAGES.reconnecting });
  });

  it("say sends the text and the current scene id", async () => {
    const f = fakeFetch();
    const hook = renderHook(() => useSession("sess-1", { EventSource: FakeEventSource, fetch: f.fetch }));
    emit(FakeEventSource.last(), "joined", joinedFrame({ state: snapshot({ status: "running", lastSeq: 1, currentScene: { id: "s2", enteredAt: 1, participants: [], pausedMs: 0 } }) }));
    await act(async () => { await hook.result.current.say("Hello <b>there</b>"); });
    expect(f.calls[0]!.url).toBe("/api/v1/say");
    expect(f.calls[0]!.body).toEqual({ text: "Hello <b>there</b>", expectSceneId: "s2" });
  });
});
