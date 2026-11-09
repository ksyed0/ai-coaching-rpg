// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionScreen, type SessionScreenProps } from "../SessionScreen";
import { MESSAGES, VOICE_NOTICES } from "../../lib/messages";
import { ev, FakeClock, FakeEventSource, fakeFetch, joinedFrame, ok, snapshot } from "../../lib/__tests__/fakes";
import { FakeAudioContext, FakeRoom, FakeStream, manualFrames } from "../../lib/__tests__/voice-fakes";

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

// ---- US-0071 (A1b Task 15): the mic check, Join with voice and the teardown, through SessionScreen ----

type Harness = ReturnType<typeof mountLive>;
function mountLive(o: { roomFails?: boolean } = {}) {
  const log: string[] = [];
  let tokens = 0;
  const hooks = { onToken: () => {} };
  const f = fakeFetch((url, body) => {
    if (url === "/api/v1/voice/token") { tokens++; log.push("token"); hooks.onToken(); return { status: 200, body: ok({ token: `t.${tokens}.s`, url: "ws://127.0.0.1:7880", expiresAt: 1 }) }; }
    const b = (body ?? {}) as { choice?: string; mute?: boolean };
    if (b.mute !== undefined) log.push(`post mute ${b.mute}`);
    if (b.choice) log.push(`post choice ${b.choice}`);
    return { status: 200, body: ok({ state: b.choice ?? "voice", muted: b.mute ?? false }) };
  });
  const clock = new FakeClock(10_000_000);
  const frames = manualFrames();
  const streams: FakeStream[] = [];
  const loadRoom = vi.fn(async () => { const r = new FakeRoom(log); r.failConnect = o.roomFails ?? false; return r; });
  const getUserMedia = vi.fn(async () => { log.push("gum"); const s = new FakeStream(); streams.push(s); return s; });
  const deps: SessionScreenProps["deps"] = {
    EventSource: FakeEventSource, fetch: f.fetch, clock,
    voice: { secure: () => true, loadRoom, getUserMedia, audioContext: () => new FakeAudioContext(), raf: frames.raf, caf: frames.caf },
  };
  const r = render(<SessionScreen sessionId="sess-1" voiceTransport deps={deps} />);
  return { ...r, f, log, hooks, clock, loadRoom, getUserMedia, streams, deps, tokens: () => tokens, es: () => FakeEventSource.last(), room: () => FakeRoom.made.at(-1)! };
}
const voiceJoined = (m: { clock: FakeClock }, over: Record<string, unknown> = {}) => joinedFrame({ consent: V3, voice: { state: "voice", muted: false }, state: running(m.clock), ...over });
async function joinVoice(m: Harness) {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: MESSAGES.voiceJoin })); });
  expect(m.room().connected).toBe(true);
}

describe("SessionScreen: Join with voice and teardown", () => {
  beforeEach(() => { FakeRoom.reset(); FakeAudioContext.reset(); });

  it("on load nothing asks for the microphone and livekit-client is not loaded; the lobby offers the mic check once voice is the choice", async () => {
    const m = mountLive();
    emit(m.es(), "joined", joinedFrame({ consent: V3, voice: { state: "none", muted: false } }));
    expect(screen.queryByRole("button", { name: MESSAGES.micCheck })).toBeNull();
    expect(screen.queryByRole("button", { name: MESSAGES.voiceJoin })).toBeNull();
    emit(m.es(), "joined", joinedFrame({ consent: V3, voice: { state: "voice", muted: false } }));
    expect(screen.getByRole("button", { name: MESSAGES.micCheck })).toBeTruthy();
    expect(screen.getByRole("button", { name: MESSAGES.voiceJoin })).toBeTruthy();
    expect(m.getUserMedia).not.toHaveBeenCalled();
    expect(m.loadRoom).not.toHaveBeenCalled();
    await joinVoice(m);
    expect(m.loadRoom).toHaveBeenCalledTimes(1);
    // The scene has no mic check (one microphone capture at a time; the check is a lobby step).
    emit(m.es(), "joined", voiceJoined(m, { logIdentity: "log-2" }));
    expect(screen.queryByRole("button", { name: MESSAGES.micCheck })).toBeNull();
  });

  it("Join with voice stops the mic check's tracks first", async () => {
    const m = mountLive();
    emit(m.es(), "joined", joinedFrame({ consent: V3, voice: { state: "voice", muted: false } }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: MESSAGES.micCheck })); });
    expect(m.streams).toHaveLength(1);
    // Checked at the very start of the join (its token request), before anything re-renders: the join itself stops the check.
    const stopped: boolean[] = [];
    m.hooks.onToken = () => { stopped.push(m.streams[0]!.tracks.every((t) => t.stopped)); };
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: MESSAGES.voiceJoin })); });
    expect(stopped).toEqual([true]);
    expect(m.log.indexOf("gum")).toBeLessThan(m.log.indexOf("token"));
    expect(FakeAudioContext.made[0]!.closed).toBe(true);
    expect(screen.queryByRole("meter")).toBeNull();
  });

  it("every final event leaves the room", async () => {
    for (const kind of ["ended", "removed", "signed_out", "superseded", "ai_filled", "expired"]) {
      FakeEventSource.reset(); FakeRoom.reset();
      const m = mountLive();
      emit(m.es(), "joined", voiceJoined(m));
      await joinVoice(m);
      await act(async () => { m.es().emit(kind, {}); });
      expect([kind, m.room().connected]).toEqual([kind, false]);
      m.unmount();
    }
  });

  it("the session ending in the view leaves the room before the final event", async () => {
    const m = mountLive();
    emit(m.es(), "joined", voiceJoined(m));
    await joinVoice(m);
    await act(async () => { m.es().emit("event", ev(2, "session.ended", { reason: "script_complete" })); });
    expect(m.room().connected).toBe(false);
  });

  it("withdraw leaves the room (Leave is offered only before consent, when there is no voice connection)", async () => {
    const m = mountLive();
    emit(m.es(), "joined", joinedFrame({ consent: V3, voice: { state: "voice", muted: false } }));
    await joinVoice(m);
    expect(screen.queryByRole("button", { name: "Leave" })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Leave and withdraw consent" })); });
    expect(m.f.calls.some((c) => c.url === "/api/v1/consent")).toBe(true);
    expect(m.room().connected).toBe(false);
    expect(screen.getByText(MESSAGES.left)).toBeTruthy();
  });

  it("a seat that is no longer consented or no longer a voice seat leaves the room (no connection without its controls)", async () => {
    for (const over of [{ consent: { ...V3, given: false } }, { voice: { state: "text_only", muted: false } }, { voice: { state: "off", muted: false } }, { voice: undefined }]) {
      FakeEventSource.reset(); FakeRoom.reset();
      const m = mountLive();
      emit(m.es(), "joined", joinedFrame({ consent: V3, voice: { state: "voice", muted: false } }));
      await joinVoice(m);
      await act(async () => { m.es().emit("joined", joinedFrame({ consent: V3, voice: { state: "voice", muted: false }, ...over })); });
      expect([over, FakeRoom.made.some((r) => r.connected)]).toEqual([over, false]);
      m.unmount();
    }
  });

  it("pagehide leaves the room", async () => {
    const m = mountLive();
    emit(m.es(), "joined", voiceJoined(m));
    await joinVoice(m);
    await act(async () => { window.dispatchEvent(new Event("pagehide")); });
    expect(m.room().connected).toBe(false);
  });

  it("a dropped runtime stream leaves the room, and the fresh joined asks for a new token and reconnects once", async () => {
    const m = mountLive();
    emit(m.es(), "joined", voiceJoined(m));
    await joinVoice(m);
    const first = m.room();
    await act(async () => { m.es().drop(); });
    expect(first.connected).toBe(false);
    expect(m.tokens()).toBe(1);
    await act(async () => { m.es().emit("joined", voiceJoined(m)); });
    expect(m.tokens()).toBe(2);
    expect(m.room()).not.toBe(first);
    expect(m.room().calls.filter((c) => c.startsWith("connect")).at(-1)).toBe("connect ws://127.0.0.1:7880 t.2.s");
    expect(m.room().connected).toBe(true);
    expect(FakeRoom.made).toHaveLength(2);
  });

  it("a fresh joined re-posts the local mute (the runtime forgot it with the released holder)", async () => {
    const m = mountLive();
    emit(m.es(), "joined", voiceJoined(m));
    await joinVoice(m);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: MESSAGES.voiceMute })); });
    expect(m.log.filter((c) => c === "post mute true")).toHaveLength(1);
    await act(async () => { m.es().emit("joined", voiceJoined(m)); });
    expect(m.log.filter((c) => c === "post mute true")).toHaveLength(2);
    expect(m.room().published).toBe(false);
    expect(screen.getByRole("button", { name: MESSAGES.voiceMute }).getAttribute("aria-pressed")).toBe("true");
  });

  it("consenting is not a fresh joined: it does not reconnect", async () => {
    const m = mountLive();
    emit(m.es(), "joined", joinedFrame({ consent: { ...V3, given: false }, voice: { state: "voice", muted: false } }));
    fireEvent.click(screen.getByLabelText("I have read this notice and agree to take part."));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "I agree" })); });
    await joinVoice(m);
    expect(m.tokens()).toBe(1);
  });

  it("a new session id leaves the room and the next join fetches a new token", async () => {
    const m = mountLive();
    emit(m.es(), "joined", voiceJoined(m));
    await joinVoice(m);
    const first = m.room();
    await act(async () => { m.rerender(<SessionScreen sessionId="sess-2" voiceTransport deps={m.deps} />); });
    expect(first.connected).toBe(false);
    emit(m.es(), "joined", voiceJoined(m));
    await joinVoice(m);
    expect(m.tokens()).toBe(2);
  });

  it("choosing text only while connected leaves the room before posting the opt-out", async () => {
    const m = mountLive();
    emit(m.es(), "joined", voiceJoined(m));
    await joinVoice(m);
    fireEvent.click(screen.getByRole("radio", { name: MESSAGES.voiceText }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: MESSAGES.voiceSave })); });
    expect(m.log.slice(-2)).toEqual(["disconnect", "post choice text_only"]);
    expect(screen.queryByRole("button", { name: MESSAGES.voiceMute })).toBeNull();
  });

  it("a failed join keeps the text box usable", async () => {
    const m = mountLive({ roomFails: true });
    emit(m.es(), "joined", voiceJoined(m));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: MESSAGES.voiceJoin })); });
    expect(screen.getByText(MESSAGES.voiceCouldNotConnect)).toBeTruthy();
    expect((screen.getByLabelText("Say something") as HTMLInputElement).disabled).toBe(false);
  });
});
