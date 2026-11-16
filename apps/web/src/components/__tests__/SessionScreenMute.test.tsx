// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionScreen, type SessionScreenProps } from "../SessionScreen";
import { MESSAGES } from "../../lib/messages";
import { ev, FakeClock, FakeEventSource, fakeFetch, joinedFrame, ok, snapshot } from "../../lib/__tests__/fakes";
import { FakeAudioContext, FakeRoom, FakeStream, manualFrames } from "../../lib/__tests__/voice-fakes";

// A3A Task 7: the participant page's facilitator-mute notices. The personal notice and the role-label status line, the disabled unmute
// button, and "announce only what arrives live": a fresh join (or a replay) never announces.

afterEach(cleanup);
beforeEach(() => { FakeEventSource.reset(); FakeRoom.reset(); });

const V3 = { noticeVersion: "v3", notice: "What you say is written down as text.", given: true };
const SELF_MUTED = "The facilitator has muted your microphone";
const AGAIN = "You can speak again";
const running = (clock: FakeClock, over: Record<string, unknown> = {}) => snapshot({ status: "running", lastSeq: 5, currentScene: { id: "s1", enteredAt: clock.t, participants: [], pausedMs: 0 }, ...over } as never);

const answer = (url: string, body: unknown) => url === "/api/v1/voice/token"
  ? { status: 200, body: ok({ token: "t.1.s", url: "ws://127.0.0.1:7880", expiresAt: 1 }) }
  : { status: 200, body: ok({ state: "voice", muted: (body as { mute?: boolean } | undefined)?.mute ?? false }) };
const voiceDeps = () => {
  const frames = manualFrames();
  return { secure: () => true, loadRoom: async () => new FakeRoom([]), getUserMedia: async () => new FakeStream(), audioContext: () => new FakeAudioContext(), raf: frames.raf, caf: frames.caf };
};

function mount() {
  const f = fakeFetch(answer);
  const clock = new FakeClock(10_000_000);
  const props: SessionScreenProps = { sessionId: "sess-1", voiceTransport: true, deps: { EventSource: FakeEventSource, fetch: f.fetch, clock, voice: voiceDeps() } };
  const r = render(<SessionScreen {...props} />);
  return { ...r, f, clock, es: () => FakeEventSource.last() };
}
type M = ReturnType<typeof mount>;
const emit = (es: FakeEventSource, type: string, data: unknown) => act(() => es.emit(type, data));
const join = (m: M, voice: Record<string, unknown> = { state: "voice", muted: false }, over: Record<string, unknown> = {}) =>
  emit(m.es(), "joined", joinedFrame({ consent: V3, voice, state: running(m.clock), ...over }));
const mute = (seq: number, roleId: string, muted: boolean) => ev(seq, "facilitator.command", { command: "mute_seat", roleId, muted } as never);
/** The text inside every polite live region on the page. */
const live = () => [...document.querySelectorAll("[aria-live='polite']")].map((n) => n.textContent ?? "").filter((t) => t !== "").join("|");
const unmuteButton = () => screen.getByRole("button", { name: MESSAGES.voiceMute }) as HTMLButtonElement;

describe("SessionScreen: the facilitator has muted this seat", () => {
  it("a live mute shows the notice in an aria-live region and disables the unmute button", async () => {
    const m = mount();
    join(m);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: MESSAGES.voiceJoin })); });
    expect(unmuteButton().getAttribute("aria-disabled")).toBeNull();
    emit(m.es(), "voice", { state: "voice", muted: true, mutedBy: "facilitator" });
    expect(live()).toContain(SELF_MUTED);
    expect(unmuteButton().getAttribute("aria-disabled")).toBe("true");
  });

  it("an unmute shows 'You can speak again' once, and the button is back to normal", async () => {
    const m = mount();
    join(m);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: MESSAGES.voiceJoin })); });
    emit(m.es(), "voice", { state: "voice", muted: true, mutedBy: "facilitator" });
    emit(m.es(), "voice", { state: "voice", muted: false });
    expect(live()).toContain(AGAIN);
    expect(screen.getAllByText(AGAIN)).toHaveLength(1);
    expect(screen.queryByText(SELF_MUTED)).toBeNull();
    expect(unmuteButton().getAttribute("aria-disabled")).toBeNull();
    // A repeated frame of the same state (every voice frame is a full snapshot) is not a change.
    const before = screen.getByText(AGAIN);
    emit(m.es(), "voice", { state: "voice", muted: false });
    expect(screen.getAllByText(AGAIN)).toHaveLength(1);
    expect(screen.getByText(AGAIN)).toBe(before);
  });

  it("a fresh join with the seat already muted shows the state, disables the button, and announces nothing", async () => {
    const m = mount();
    join(m, { state: "voice", muted: true, mutedBy: "facilitator" });
    expect(screen.getByText(SELF_MUTED)).toBeTruthy();
    expect(live()).toBe("");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: MESSAGES.voiceJoin })); });
    expect(unmuteButton().getAttribute("aria-disabled")).toBe("true");
  });

  it("the same frame arriving again after the join is not announced", () => {
    const m = mount();
    join(m, { state: "voice", muted: true, mutedBy: "facilitator" });
    emit(m.es(), "voice", { state: "voice", muted: true, mutedBy: "facilitator" });
    expect(live()).toBe("");
    expect(screen.getAllByText(SELF_MUTED)).toHaveLength(1);
  });

  it("a rejoin while still muted announces nothing", () => {
    const m = mount();
    join(m);
    emit(m.es(), "voice", { state: "voice", muted: true, mutedBy: "facilitator" });
    expect(live()).toContain(SELF_MUTED);
    join(m, { state: "voice", muted: true, mutedBy: "facilitator" });
    expect(live()).toBe("");
    expect(screen.getAllByText(SELF_MUTED)).toHaveLength(1);
  });

  it("a mute held before the seat chose voice is announced when the opt-in answer arrives", () => {
    const m = mount();
    join(m, { state: "none", muted: true, mutedBy: "facilitator" });
    expect(live()).toBe("");
    emit(m.es(), "voice", { state: "voice", muted: true, mutedBy: "facilitator" });
    expect(live()).toContain(SELF_MUTED);
  });

  it("a focused Mute button keeps its focus when the mute lands, and a press sends nothing", async () => {
    const m = mount();
    join(m);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: MESSAGES.voiceJoin })); });
    unmuteButton().focus();
    emit(m.es(), "voice", { state: "voice", muted: true, mutedBy: "facilitator" });
    expect(document.activeElement).toBe(unmuteButton());
    const calls = m.f.calls.length;
    await act(async () => { fireEvent.click(unmuteButton()); });
    expect(m.f.calls.length).toBe(calls);
  });

  it("a text-only seat that is facilitator-muted shows no personal notice (it has no microphone to speak of)", () => {
    const m = mount();
    join(m, { state: "text_only", muted: true, mutedBy: "facilitator" });
    emit(m.es(), "voice", { state: "text_only", muted: false });
    expect(screen.queryByText(SELF_MUTED)).toBeNull();
    expect(screen.queryByText(AGAIN)).toBeNull();
  });

  it("the HTTP answer to a voice send never overwrites a facilitator mute that the stream delivered after it", async () => {
    const f = fakeFetch((url, body) => (url === "/api/v1/voice/token" ? answer(url, body) : { status: 200, body: ok({ state: "voice", muted: false }) }));
    const clock = new FakeClock(10_000_000);
    render(<SessionScreen sessionId="sess-1" voiceTransport deps={{ EventSource: FakeEventSource, fetch: f.fetch, clock, voice: voiceDeps() }} />);
    const es = FakeEventSource.last();
    emit(es, "joined", joinedFrame({ consent: V3, voice: { state: "voice", muted: false }, state: running(clock) }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: MESSAGES.voiceJoin })); });
    // The participant's own mute is in flight (held); the facilitator's push lands; then the older answer (not muted, no mutedBy) arrives.
    f.hold();
    await act(async () => { fireEvent.click(unmuteButton()); });
    emit(es, "voice", { state: "voice", muted: true, mutedBy: "facilitator" });
    await act(async () => { f.release(); });
    expect(screen.getByText(SELF_MUTED)).toBeTruthy();
    expect(unmuteButton().getAttribute("aria-disabled")).toBe("true");
  });
});

describe("SessionScreen: everyone sees a mute by role label", () => {
  it("a live mute and unmute of another seat show the role-label line in a polite region, never a name", () => {
    const m = mount();
    join(m, { state: "voice", muted: false }, { roleId: "account_manager" });
    emit(m.es(), "roster", { audience: "peers", entries: [{ roleId: "project_lead", name: "Sam Hidden", ready: true }, { roleId: "account_manager", ready: true }] });
    emit(m.es(), "event", mute(6, "project_lead", true));
    expect(live()).toContain("The Project lead microphone has been muted by the facilitator");
    emit(m.es(), "event", mute(7, "project_lead", false));
    expect(live()).toContain("The Project lead microphone is on again");
    expect(live()).not.toContain("muted by the facilitator");
    expect(live()).not.toMatch(/Sam|Hidden/);
  });

  it("the line shows even when this seat has not chosen voice", () => {
    const m = mount();
    join(m, { state: "none", muted: false });
    emit(m.es(), "event", mute(6, "project_lead", true));
    expect(live()).toContain("The Project lead microphone has been muted by the facilitator");
  });

  it("this seat's own mute event shows only the personal notice, not the role-label line", () => {
    const m = mount();
    join(m);
    emit(m.es(), "event", mute(6, "account_manager", true));
    emit(m.es(), "voice", { state: "voice", muted: true, mutedBy: "facilitator" });
    expect(document.body.textContent).not.toContain("The Account manager microphone");
    expect(live()).toContain(SELF_MUTED);
  });

  it("a mute already in the join snapshot is not announced, and a replayed mute event after a rejoin is not announced", () => {
    const m = mount();
    join(m, { state: "voice", muted: false }, { state: running(m.clock, { facilitatorMutedSeats: ["project_lead"] }) });
    expect(live()).toBe("");
    // Rejoin (complete replay): the snapshot is the head; the replayed mute and unmute follow with seqs at or below it.
    join(m, { state: "voice", muted: false }, { state: running(m.clock, { lastSeq: 8, facilitatorMutedSeats: [] }), replay: { afterSeq: 5, toSeq: 8, events: 2, complete: true } });
    emit(m.es(), "event", mute(6, "project_lead", true));
    emit(m.es(), "event", mute(7, "project_lead", false));
    expect(live()).toBe("");
    // A live one after the head is announced.
    emit(m.es(), "event", mute(9, "project_lead", true));
    expect(live()).toContain("The Project lead microphone has been muted by the facilitator");
  });

  it("a mute of a seat that is already muted (an idempotent repeat) is not announced twice", () => {
    const m = mount();
    join(m);
    emit(m.es(), "event", mute(6, "project_lead", true));
    const n = live();
    emit(m.es(), "event", mute(7, "project_lead", true));
    expect(live()).toBe(n);
  });

  it("the roster marks a facilitator-muted seat in words", () => {
    const m = mount();
    join(m);
    emit(m.es(), "roster", { audience: "peers", entries: [{ roleId: "project_lead", ready: true, facilitatorMuted: true }, { roleId: "account_manager", ready: true, facilitatorMuted: false }] });
    expect(screen.getAllByText(MESSAGES.rosterMutedByFacilitator)).toHaveLength(1);
  });

  it("with no voice at all, the page renders no mute copy", () => {
    const m = mount();
    emit(m.es(), "joined", joinedFrame({ state: running(m.clock) }));
    expect(live()).toBe("");
  });
});
