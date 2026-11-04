// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initialState } from "@acr/events";
import { SessionConsole } from "../console/SessionConsole";
import { FakeClock, FakeEventSource, fakeFetch, fakeTimer, ok, readiness } from "../../lib/__tests__/fakes";
import type { EventSourceCtor } from "../../lib/use-session";

beforeEach(() => FakeEventSource.reset());
afterEach(cleanup);

const SID = "abcd1234efgh5678";
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

function mount(initial: unknown, routes: Record<string, { status: number; body: unknown }> = {}) {
  const current = { readiness: initial as unknown };
  const f = fakeFetch((url) => {
    const tail = url.split(`/${SID}`)[1] ?? "";
    if (tail === "/readiness") return { status: 200, body: ok(current.readiness) };
    return routes[tail] ?? { status: 200, body: ok({}) };
  });
  const t = fakeTimer();
  const r = render(
    <SessionConsole
      sessionId={SID}
      deps={{ EventSource: FakeEventSource as unknown as EventSourceCtor, fetch: f.fetch, setTimer: t.setTimer, clock: new FakeClock(1_000_000) }}
    />,
  );
  return { ...r, f, t, current };
}
const joined = (es: FakeEventSource) => act(() => es.emit("joined", { channel: "c1", scenes: [] }));
const reset = (es: FakeEventSource) => act(() => es.emit("reset", { state: { ...initialState(), status: "running", lastSeq: 1 } }));

describe("SessionConsole", () => {
  it("an idle session never opens the stream", async () => {
    const m = mount(readiness({ canStart: true }));
    await screen.findByText(/Model:/);
    await flush();
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(m.t.pending).toBe(1);
  });

  it("a running readiness answer opens the console stream and stops polling", async () => {
    const m = mount(readiness({ status: "running" }));
    await screen.findByText(/Model:/);
    await flush();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.last().url).toBe(`/api/v1/console/sessions/${SID}/stream`);
    expect(m.t.pending).toBe(0);
    expect(m.f.calls.filter((c) => c.url.endsWith("/readiness"))).toHaveLength(1);
  });

  it("a successful Start opens the stream", async () => {
    mount(readiness({ canStart: true }));
    await screen.findByText(/Model:/);
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  });

  it("live shows the live view below the readiness view", async () => {
    mount(readiness({ status: "running" }));
    await screen.findByText(/Model:/);
    await flush();
    await joined(FakeEventSource.last());
    await reset(FakeEventSource.last());
    expect(screen.getByRole("heading", { name: "Live session" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Who is in the room" })).toBeTruthy();
  });

  it("live mode shows Facilitator controls; an ended final hides them and keeps the view", async () => {
    mount(readiness({ status: "running" }));
    await screen.findByText(/Model:/);
    await flush();
    await joined(FakeEventSource.last());
    await reset(FakeEventSource.last());
    expect(screen.getByRole("heading", { name: "Facilitator controls" })).toBeTruthy();
    const card = screen.getByRole("heading", { name: "Live session" }).closest("section")!;
    expect(card.nextElementSibling?.contains(screen.getByRole("heading", { name: "Facilitator controls" }))).toBe(true);
    await act(async () => FakeEventSource.last().emit("ended", {}));
    expect(screen.queryByRole("heading", { name: "Facilitator controls" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Live session" })).toBeTruthy();
    expect(screen.getAllByText("The session has ended.")).toHaveLength(1);
  });

  it("the lobby shows no controls", async () => {
    mount(readiness({ canStart: true }));
    await screen.findByText(/Model:/);
    expect(screen.queryByRole("heading", { name: "Facilitator controls" })).toBeNull();
  });

  it("a stopped final returns to polling and shows Restart, with its message once", async () => {
    const m = mount(readiness({ status: "running" }));
    await screen.findByText(/Model:/);
    await flush();
    await joined(FakeEventSource.last());
    m.current.readiness = readiness({ launcherStatus: "stopped", status: null, roster: [] });
    await act(async () => FakeEventSource.last().emit("stopped", {}));
    await flush();
    expect(m.t.pending).toBe(1);
    act(() => m.t.fire());
    await flush();
    expect(await screen.findByRole("button", { name: "Restart" })).toBeTruthy();
    expect(screen.getAllByText("The session stopped. Restart it from this page.")).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "Live session" })).toBeNull();
  });

  it("the ended final message appears exactly once", async () => {
    mount(readiness({ status: "running" }));
    await screen.findByText(/Model:/);
    await flush();
    await joined(FakeEventSource.last());
    await act(async () => FakeEventSource.last().emit("ended", {}));
    expect(screen.getAllByText("The session has ended.")).toHaveLength(1);
  });

  it("the stopped message goes away once the session is restarted, and a new stream starts with no view", async () => {
    const m = mount(readiness({ status: "running" }));
    await screen.findByText(/Model:/);
    await flush();
    await joined(FakeEventSource.last());
    await reset(FakeEventSource.last());
    m.current.readiness = readiness({ launcherStatus: "stopped", status: null, roster: [] });
    await act(async () => FakeEventSource.last().emit("stopped", {}));
    await flush();
    act(() => m.t.fire());
    await flush();
    await screen.findByRole("button", { name: "Restart" });
    m.current.readiness = readiness({ canStart: true });
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    await waitFor(() => expect(screen.queryByText("The session stopped. Restart it from this page.")).toBeNull());
    m.current.readiness = readiness({ status: "running" });
    fireEvent.click(await screen.findByRole("button", { name: "Start" }));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
    expect(screen.queryByText("The session stopped. Restart it from this page.")).toBeNull();
    expect(screen.queryByText("Nothing has been said yet.")).not.toBeNull();
  });

  const endedBanners = () => screen.queryAllByText(/(this|the) session has ended/i);
  const goLive = async (m: ReturnType<typeof mount>) => {
    await screen.findByText(/Model:/);
    await flush();
    await joined(FakeEventSource.last());
    await reset(FakeEventSource.last());
    return m;
  };

  it("session.ended then the ended final shows one ended message and no started banner", async () => {
    await goLive(mount(readiness({ status: "running" })));
    const es = FakeEventSource.last();
    await act(async () => es.emit("event", { seq: 2, ts: 5, sessionId: "s", type: "session.ended", message: "bye" }));
    await act(async () => es.emit("ended", {}));
    expect(endedBanners()).toHaveLength(1);
    expect(screen.queryByText("The session has started.")).toBeNull();
  });

  it("the ended final without a session.ended event shows one ended message and no started banner", async () => {
    await goLive(mount(readiness({ status: "running" })));
    await act(async () => FakeEventSource.last().emit("ended", {}));
    expect(endedBanners()).toHaveLength(1);
    expect(screen.queryByText("The session has started.")).toBeNull();
  });

  it("the stopped message is announced once, Restart stays", async () => {
    const m = await goLive(mount(readiness({ status: "running" })));
    m.current.readiness = readiness({ launcherStatus: "stopped", status: null, roster: [] });
    await act(async () => FakeEventSource.last().emit("stopped", {}));
    await flush();
    act(() => m.t.fire());
    await flush();
    await screen.findByRole("button", { name: "Restart" });
    expect(screen.queryByText("The session service stopped this session.")).toBeNull();
  });

  it.each([
    ["seats_not_ready 409", { status: 409, body: { success: false, data: { reason: "seats_not_ready", missing: ["x"] }, error: { code: "conflict", message: "m" }, meta: { version: "1.0", timestamp: "x" } } }],
    ["a 500", { status: 500, body: { success: false, data: null, error: { code: "internal", message: "boom" }, meta: { version: "1.0", timestamp: "x" } } }],
  ])("a Start refused with %s opens no stream and polling continues", async (_n, answer) => {
    const m = mount(readiness({ canStart: true }), { "/start": answer });
    await screen.findByText(/Model:/);
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await flush();
    await flush();
    expect(FakeEventSource.instances).toHaveLength(0);
    expect(m.t.pending).toBe(1);
  });

  it("the polled roster shows until the first stream roster frame replaces it", async () => {
    await goLive(mount(readiness({ status: "running" })));
    expect(screen.getByText("Sam")).toBeTruthy();
    await act(async () => FakeEventSource.last().emit("roster", { entries: [{ roleId: "account_manager", name: "Streamed", joined: true, consented: true, connected: true }] }));
    expect(screen.getByText("Streamed")).toBeTruthy();
    expect(screen.queryByText("Sam")).toBeNull();
  });

  it("the live view shows the AI players panel for state.aiRoles, with Prompt enabled once live and running", async () => {
    mount(readiness({ status: "running" }));
    await screen.findByText(/Model:/);
    await flush();
    await joined(FakeEventSource.last());
    await act(async () => FakeEventSource.last().emit("reset", { state: { ...initialState(), status: "running", lastSeq: 1, aiRoles: ["tech_lead"], currentScene: { id: "s1", enteredAt: 1, participants: ["tech_lead"], pausedMs: 0 } } }));
    expect(screen.getByRole("heading", { name: "AI players" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Prompt the AI player for Tech lead" }) as HTMLButtonElement).disabled).toBe(false);
  });

  const aiState = (over: Record<string, unknown>) => ({ ...initialState(), status: "running", lastSeq: 1, aiRoles: ["tech_lead"], currentScene: { id: "s1", enteredAt: 1, participants: ["tech_lead"], pausedMs: 0 }, ...over });
  const prompt = () => screen.getByRole("button", { name: "Prompt the AI player for Tech lead" }) as HTMLButtonElement;
  const liveWith = async (state: unknown) => {
    mount(readiness({ status: "running" }));
    await screen.findByText(/Model:/);
    await flush();
    await joined(FakeEventSource.last());
    await act(async () => FakeEventSource.last().emit("reset", { state }));
  };

  it("Prompt is off while the session is paused and comes back on resume", async () => {
    await liveWith(aiState({ paused: true, pausedSince: 5 }));
    expect(prompt().disabled).toBe(true);
    expect(screen.getByText("Resume the session before you prompt an AI player.")).toBeTruthy();
    await act(async () => FakeEventSource.last().emit("reset", { state: aiState({}) }));
    expect(prompt().disabled).toBe(false);
  });

  it("Prompt is off for an AI role that is not in the current scene", async () => {
    await liveWith(aiState({ currentScene: { id: "s1", enteredAt: 1, participants: ["account_manager"], pausedMs: 0 } }));
    expect(prompt().disabled).toBe(true);
    expect(screen.getByText("This AI player is not in the current scene.")).toBeTruthy();
  });

  it("no AI players panel when the session has no AI roles", async () => {
    await goLive(mount(readiness({ status: "running" })));
    expect(screen.queryByRole("heading", { name: "AI players" })).toBeNull();
  });
});
