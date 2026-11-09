// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionScreen, type SessionScreenProps } from "../SessionScreen";
import { MESSAGES, VOICE_NOTICES } from "../../lib/messages";
import { FakeClock, FakeEventSource, fakeFetch, joinedFrame, ok, snapshot } from "../../lib/__tests__/fakes";

// US-0071 (A1b Task 14): the voice choice and the private notices on the participant page. With no `voice` in joined (voice not
// enabled) the page is exactly the text-only page.

afterEach(cleanup);
beforeEach(() => FakeEventSource.reset());

const V3 = { noticeVersion: "v3", notice: "What you say is written down as text.", given: true };
const running = (clock: FakeClock) => snapshot({ status: "running", lastSeq: 1, currentScene: { id: "s1", enteredAt: clock.t, participants: [], pausedMs: 0 } });

function mount(o: { voiceTransport?: boolean; secure?: boolean; answer?: Parameters<typeof fakeFetch>[0] } = {}) {
  const f = fakeFetch(o.answer ?? ((_url, body) => ({ status: 200, body: ok({ state: (body as { choice?: string }).choice ?? "voice", muted: false }) })));
  const clock = new FakeClock(10_000_000);
  const props: SessionScreenProps = {
    sessionId: "sess-1", voiceTransport: o.voiceTransport ?? true,
    deps: { EventSource: FakeEventSource, fetch: f.fetch, clock, voice: { secure: () => o.secure ?? true } },
  };
  const r = render(<SessionScreen {...props} />);
  return { ...r, f, clock, es: () => FakeEventSource.last() };
}
const emit = (es: FakeEventSource, type: string, data: unknown) => act(() => es.emit(type, data));
const group = () => screen.queryByRole("group", { name: MESSAGES.voiceChoiceTitle });

describe("SessionScreen: voice choice and notices", () => {
  it("with voice not enabled (no joined.voice) the page shows no voice choice and no voice region, lobby or scene", () => {
    const m = mount();
    emit(m.es(), "joined", joinedFrame({ consent: V3 }));
    expect(group()).toBeNull();
    expect(m.container.textContent).not.toMatch(/Voice|voice/);
    expect(m.container.querySelectorAll("[role='status'][aria-live]")).toHaveLength(0);
    emit(m.es(), "joined", joinedFrame({ consent: V3, state: running(m.clock) }));
    expect(group()).toBeNull();
    expect(m.container.querySelectorAll("[role='status'][aria-live]")).toHaveLength(0);
  });

  it("not shown before consent or when the seat's voice is off; shown after consent in the lobby and in the scene", () => {
    const m = mount();
    emit(m.es(), "joined", joinedFrame({ consent: { ...V3, given: false }, voice: { state: "none", muted: false } }));
    expect(group()).toBeNull();
    emit(m.es(), "joined", joinedFrame({ consent: V3, voice: { state: "off", muted: false } }));
    expect(group()).toBeNull();
    emit(m.es(), "joined", joinedFrame({ consent: V3, voice: { state: "none", muted: false } }));
    expect(group()).not.toBeNull();
    emit(m.es(), "joined", joinedFrame({ consent: V3, voice: { state: "voice", muted: false }, state: running(m.clock), logIdentity: "log-2" }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Play the scene");
    expect(group()).not.toBeNull();
    expect(screen.getByText(MESSAGES.voiceStateOn, { exact: false })).toBeTruthy();
  });

  it("agreeing in the lobby then choosing voice posts the choice with the notice version and shows Voice: on", async () => {
    const m = mount();
    emit(m.es(), "joined", joinedFrame({ consent: { ...V3, given: false }, voice: { state: "none", muted: false } }));
    fireEvent.click(screen.getByLabelText("I have read this notice and agree to take part."));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "I agree" })); });
    fireEvent.click(screen.getByRole("radio", { name: MESSAGES.voiceWith }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: MESSAGES.voiceSave })); });
    expect(m.f.calls.map((c) => [c.url, c.body])).toEqual([["/api/v1/consent", { noticeVersion: "v3" }], ["/api/v1/voice", { choice: "voice", noticeVersion: "v3" }]]);
    expect(screen.getByText(MESSAGES.voiceStateOn, { exact: false })).toBeTruthy();
  });

  it("voiceTransport false disables the voice option with the not-available sentence", () => {
    const m = mount({ voiceTransport: false });
    emit(m.es(), "joined", joinedFrame({ consent: V3, voice: { state: "none", muted: false } }));
    expect((screen.getByRole("radio", { name: MESSAGES.voiceWith }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(MESSAGES.voiceNoTransport)).toBeTruthy();
  });

  it("an insecure page (the injected check) disables the voice option with the secure-connection sentence", () => {
    const m = mount({ secure: false });
    emit(m.es(), "joined", joinedFrame({ consent: V3, voice: { state: "none", muted: false } }));
    expect((screen.getByRole("radio", { name: MESSAGES.voiceWith }) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(MESSAGES.voiceInsecure)).toBeTruthy();
  });

  it("the private notices go to one polite region that stays the same node from the lobby to the scene", () => {
    const m = mount();
    emit(m.es(), "joined", joinedFrame({ consent: V3, voice: { state: "voice", muted: false } }));
    const region = m.container.querySelector("[aria-live='polite'][role='status']")!;
    expect(region.textContent).toBe("");
    emit(m.es(), "voice_notice", { code: "voice_unavailable" });
    expect(region.textContent).toBe(VOICE_NOTICES.voice_unavailable);
    emit(m.es(), "joined", joinedFrame({ consent: V3, voice: { state: "voice", muted: false }, state: running(m.clock), logIdentity: "log-2" }));
    emit(m.es(), "voice_notice", { code: "empty" });
    expect(m.container.querySelector("[aria-live='polite'][role='status']")).toBe(region);
    expect(region.textContent).toBe(VOICE_NOTICES.empty);
    emit(m.es(), "voice_notice", { code: "unknown_code" });
    expect(region.textContent).toBe(VOICE_NOTICES.empty);
  });
});
