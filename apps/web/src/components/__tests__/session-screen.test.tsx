// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionScreen } from "../SessionScreen";
import { MESSAGES } from "../../lib/messages";
import { FakeClock, FakeEventSource, ev, fakeFetch, joinedFrame, snapshot } from "../../lib/__tests__/fakes";

afterEach(cleanup);
beforeEach(() => FakeEventSource.reset());

function mount() {
  const f = fakeFetch();
  const clock = new FakeClock(10_000_000);
  // fetch is wrapped so the test can see whether the stream already existed when the first POST went out.
  const streamsAtPost: number[] = [];
  const fetchSpy = ((input: RequestInfo | URL, init?: RequestInit) => { streamsAtPost.push(FakeEventSource.instances.length); return f.fetch(input, init); }) as typeof fetch;
  const r = render(<SessionScreen sessionId="sess-1" deps={{ EventSource: FakeEventSource, fetch: fetchSpy, clock }} />);
  return { ...r, f, clock, streamsAtPost, es: () => FakeEventSource.last() };
}
const emit = (es: FakeEventSource, type: string, data: unknown) => act(() => es.emit(type, data));

describe("SessionScreen", () => {
  it("opens the stream before anything is posted, and offers consent only once the stream delivered the notice", async () => {
    const m = mount();
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(screen.getByText(MESSAGES.connecting)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "I agree" })).toBeNull();
    emit(m.es(), "joined", joinedFrame());
    emit(m.es(), "roster", { audience: "peers", entries: [{ roleId: "account_manager", name: "Sam", ready: false }, { roleId: "delivery_lead", ready: false }] });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Join your session");
    expect(screen.getByText("Lobby")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("I have read this notice and agree to take part."));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "I agree" })); });
    expect(m.f.calls.map((c) => c.url)).toEqual(["/api/v1/consent"]);
    expect(m.streamsAtPost).toEqual([1]);
    expect(screen.getByText(/You agreed to notice v1/)).toBeTruthy();
    expect(screen.getByText(MESSAGES.waiting)).toBeTruthy();
    expect(m.container.querySelectorAll("[style]")).toHaveLength(0);
  });

  it("before consent the lobby offers to leave; leaving closes the stream and says so", async () => {
    const m = mount();
    emit(m.es(), "joined", joinedFrame());
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Leave" })); });
    expect(m.f.calls.map((c) => c.url)).toEqual(["/api/v1/leave"]);
    expect(m.es().closed).toBe(true);
    expect(screen.getByText(MESSAGES.left)).toBeTruthy();
  });

  it("shows the session view: scene, timer, transcript, brief and facts, and a say box that pauses with the scene", async () => {
    const m = mount();
    const T = m.clock.t - 60_000;
    const state = snapshot({ status: "running", lastSeq: 5, currentScene: { id: "s2", enteredAt: T, participants: [], pausedMs: 0 } });
    emit(m.es(), "joined", joinedFrame({ state, consent: { noticeVersion: "v1", notice: "n", given: true } }));
    emit(m.es(), "roster", { audience: "peers", entries: [{ roleId: "account_manager", name: "Sam", ready: true }, { roleId: "delivery_lead", name: "Jo", ready: true }] });
    emit(m.es(), "event", ev(6, "utterance", { roleId: "delivery_lead", text: "We can size it today.", channel: "text" }, T + 1));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Play the scene");
    expect(screen.getByText(/Scene 2 of 2: Client call/)).toBeTruthy();
    expect(screen.getByRole("timer").textContent).toBe("09:00");
    expect(screen.getByText("We can size it today.")).toBeTruthy();
    expect(screen.getAllByText("Jo").length).toBeGreaterThanOrEqual(2); // the transcript speaker and the roster
    expect(screen.getByText("You own the client relationship.")).toBeTruthy();
    expect(screen.getByText("The contract allows one paid change request.")).toBeTruthy();
    const box = screen.getByLabelText("Say something") as HTMLInputElement;
    expect(box.disabled).toBe(false);
    fireEvent.change(box, { target: { value: "Let me check." } });
    await act(async () => { fireEvent.submit(box.form!); });
    expect(m.f.calls.at(-1)!.body).toEqual({ text: "Let me check.", expectSceneId: "s2" });

    emit(m.es(), "event", ev(7, "facilitator.command", { command: "pause" } as never, T + 2_000));
    expect(box.disabled).toBe(true);
    expect(screen.getByText(MESSAGES.paused)).toBeTruthy();
    emit(m.es(), "event", ev(8, "facilitator.command", { command: "resume" } as never, T + 3_000));
    expect(box.disabled).toBe(false);
    emit(m.es(), "event", ev(9, "inject.fired", { injectId: "i1", sceneId: "s2", to: ["account_manager"], content: "Email from the CFO." }, T + 4_000));
    expect(screen.getByText("Email from the CFO.")).toBeTruthy();
    expect(m.container.querySelectorAll("[style]")).toHaveLength(0);
  });

  it("after the end the say box is gone or disabled and the end is announced; the stream is closed", () => {
    const m = mount();
    emit(m.es(), "joined", joinedFrame({ state: snapshot({ status: "running", lastSeq: 1 }), consent: { noticeVersion: "v1", notice: "n", given: true } }));
    emit(m.es(), "event", ev(2, "session.ended", { reason: "script_complete" }));
    expect(screen.getByText(MESSAGES.sessionEnded)).toBeTruthy();
    const box = screen.queryByLabelText("Say something") as HTMLInputElement | null;
    if (box) expect(box.disabled).toBe(true);
    emit(m.es(), "ended", {});
    expect(m.es().closed).toBe(true);
  });

  it("shows the reconnecting banner on a drop and removes it once the stream is back", () => {
    const m = mount();
    emit(m.es(), "joined", joinedFrame({ state: snapshot({ status: "running", lastSeq: 1 }), consent: { noticeVersion: "v1", notice: "n", given: true } }));
    expect(screen.queryByText(MESSAGES.reconnecting)).toBeNull();
    act(() => m.es().drop());
    expect(screen.getByText(MESSAGES.reconnecting)).toBeTruthy();
    expect(screen.getByText("Reconnecting")).toBeTruthy();
    emit(m.es(), "joined", joinedFrame({ state: snapshot({ status: "running", lastSeq: 1 }), consent: { noticeVersion: "v1", notice: "n", given: true } }));
    expect(screen.queryByText(MESSAGES.reconnecting)).toBeNull();
  });

  it("superseded shows the other-tab message; signed_out the new-code message", () => {
    const a = mount();
    emit(a.es(), "superseded", {});
    expect(screen.getByText(MESSAGES.superseded)).toBeTruthy();
    a.unmount();
    const b = mount();
    emit(b.es(), "signed_out", { message: "ignored: the page uses its own text" });
    expect(screen.getByText(MESSAGES.signedOut)).toBeTruthy();
    expect(screen.queryByText(/ignored/)).toBeNull();
  });

  it("a stream that could not be opened offers a retry, which opens a new one", () => {
    const m = mount();
    act(() => m.es().fail());
    expect(screen.getByText(MESSAGES.unavailable)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("a server error frame is shown as a notice", () => {
    const m = mount();
    emit(m.es(), "joined", joinedFrame());
    emit(m.es(), "error", { code: "log_failed", message: "x" });
    expect(screen.getByText(MESSAGES.serverError)).toBeTruthy();
  });
});
