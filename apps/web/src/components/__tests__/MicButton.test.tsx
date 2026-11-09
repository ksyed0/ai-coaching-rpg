// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MicButton, micWords, type MicButtonProps } from "../MicButton";
import { MESSAGES } from "../../lib/messages";
import { VoiceClient, type TokenAnswer } from "../../lib/voice-client";
import type { ActionResult } from "../../lib/api";
import { FakeRoom } from "../../lib/__tests__/voice-fakes";

// US-0071 (A1b Task 15): "Join with voice", then a Mute button with a FIXED label and aria-pressed, the microphone state in honest words
// with an aria-hidden icon, and "Stop using voice". The real VoiceClient runs behind the fake BrowserRoom seam.

afterEach(cleanup);
beforeEach(() => FakeRoom.reset());

function mount(o: { token?: () => TokenAnswer; failConnect?: boolean; props?: Partial<MicButtonProps> } = {}) {
  const log: string[] = [];
  const client = new VoiceClient({
    room: async () => { const r = new FakeRoom(log); r.failConnect = o.failConnect ?? false; return r; },
    fetchToken: async () => (o.token ? o.token() : { ok: true, token: "t", url: "ws://127.0.0.1:7880" }),
    postMute: async (muted) => { log.push(`post mute ${muted}`); return { ok: true }; },
  });
  const onOptOut = vi.fn(async (): Promise<ActionResult> => { log.push("opt out"); return { ok: true }; });
  const props: MicButtonProps = { client, started: true, paused: false, inScene: true, unavailable: false, serverMuted: false, onJoin: () => client.join(), onOptOut, ...o.props };
  const r = render(<MicButton {...props} />);
  return { ...r, client, log, onOptOut, props, room: () => FakeRoom.made.at(-1)! };
}
const join = () => screen.getByRole("button", { name: MESSAGES.voiceJoin });
const mute = () => screen.getByRole("button", { name: MESSAGES.voiceMute });
const press = async (b: HTMLElement) => { await act(async () => { b.focus(); fireEvent.click(b); }); };

describe("MicButton", () => {
  it("before joining: Join with voice and the words Voice not connected", () => {
    mount();
    expect(join().tagName).toBe("BUTTON");
    expect(screen.getByText(MESSAGES.micNotConnected)).toBeTruthy();
    expect(screen.queryByRole("button", { name: MESSAGES.voiceMute })).toBeNull();
  });

  it("focus moves to the Mute button after a successful join", async () => {
    mount();
    await press(join());
    expect(screen.queryByRole("button", { name: MESSAGES.voiceJoin })).toBeNull();
    expect(document.activeElement).toBe(mute());
  });

  it("focus stays on Join with voice when joining fails; the sentence is shown", async () => {
    mount({ failConnect: true });
    const j = join();
    await press(j);
    expect(join()).toBe(j);
    expect(document.activeElement).toBe(j);
    expect(screen.getByRole("alert").textContent).toBe(MESSAGES.voiceCouldNotConnect);
  });

  it("the label stays Mute microphone and aria-pressed follows mute; muting really stops publishing", async () => {
    const m = mount();
    await press(join());
    const b = mute();
    expect(b.getAttribute("aria-pressed")).toBe("false");
    expect(m.room().published).toBe(true);
    await press(b);
    expect(mute()).toBe(b);
    expect(b.textContent).toBe(MESSAGES.voiceMute);
    expect(b.getAttribute("aria-pressed")).toBe("true");
    expect(m.room().published).toBe(false);
    expect(m.log.slice(-2)).toEqual(["disable", "post mute true"]);
    expect(screen.getByText(MESSAGES.micMuted)).toBeTruthy();
    await press(b);
    expect(b.getAttribute("aria-pressed")).toBe("false");
    expect(b.textContent).toBe(MESSAGES.voiceMute);
    expect(m.room().published).toBe(true);
  });

  it("a seat the runtime holds muted shows Microphone muted and aria-pressed true while connected", async () => {
    mount({ props: { serverMuted: true } });
    await press(join());
    expect(mute().getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText(MESSAGES.micMuted)).toBeTruthy();
  });

  it("the state words follow started, paused, the scene and availability", () => {
    const live = { state: "live" as const, muted: false, started: true, paused: false, inScene: true, unavailable: false };
    expect(micWords(live)).toBe(MESSAGES.micRecording);
    expect(micWords({ ...live, started: false })).toBe(MESSAGES.micNotStarted);
    expect(micWords({ ...live, paused: true })).toBe(MESSAGES.micPausedWords);
    expect(micWords({ ...live, inScene: false })).toBe(MESSAGES.micBetweenScenes);
    expect(micWords({ ...live, unavailable: true })).toBe(MESSAGES.micUnavailableWords);
    expect(micWords({ ...live, muted: true })).toBe(MESSAGES.micMuted);
    expect(micWords({ ...live, state: "muted" })).toBe(MESSAGES.micMuted);
    for (const state of ["idle", "connecting", "failed", "suspended"] as const) expect(micWords({ ...live, state })).toBe(MESSAGES.micNotConnected);
    // "recording" only when everything the runtime needs to record holds
    const all = [true, false];
    for (const started of all) for (const paused of all) for (const inScene of all) for (const unavailable of all) for (const muted of all) {
      const w = micWords({ state: "live", started, paused, inScene, unavailable, muted });
      expect(w === MESSAGES.micRecording).toBe(started && !paused && inScene && !unavailable && !muted);
    }
  });

  it("voice_available after voice_unavailable restores the recording words", async () => {
    const m = mount({ props: { unavailable: true } });
    await press(join());
    expect(screen.getByText(MESSAGES.micUnavailableWords)).toBeTruthy();
    m.rerender(<MicButton {...m.props} unavailable={false} />);
    expect(screen.getByText(MESSAGES.micRecording)).toBeTruthy();
  });

  it("state shown in words with an aria-hidden icon", async () => {
    mount({ props: { started: false } });
    await press(join());
    const p = screen.getByText(MESSAGES.micNotStarted, { exact: false });
    expect(p.querySelector("[aria-hidden='true']")).not.toBeNull();
    expect(p.textContent!.endsWith(MESSAGES.micNotStarted)).toBe(true);
  });

  it("keyboard operable: native buttons with type button, no tabindex, nothing disabled that holds the focus", async () => {
    const { container } = mount();
    expect((join() as HTMLButtonElement).type).toBe("button");
    await press(join());
    for (const b of container.querySelectorAll("button")) expect(b.type).toBe("button");
    expect(container.querySelectorAll("[tabindex]")).toHaveLength(0);
    expect(screen.getByRole("button", { name: MESSAGES.voiceStop })).toBeTruthy();
  });

  it("Stop using voice leaves the room before posting the opt-out", async () => {
    const m = mount();
    await press(join());
    await press(screen.getByRole("button", { name: MESSAGES.voiceStop }));
    expect(m.log.slice(-2)).toEqual(["disconnect", "opt out"]);
    expect(m.client.state).toBe("idle");
  });

  it("once voice is off for the session Join is not offered again", async () => {
    mount({ token: () => ({ ok: false, code: "voice_off", message: MESSAGES.voiceOffSession }) });
    await press(join());
    expect(screen.queryByRole("button", { name: MESSAGES.voiceJoin })).toBeNull();
    expect(screen.getByText(MESSAGES.voiceOffSession)).toBeTruthy();
  });

  it("a second click while joining sends one join", async () => {
    const m = mount();
    await act(async () => { fireEvent.click(join()); fireEvent.click(join()); });
    expect(FakeRoom.made).toHaveLength(1);
    expect(m.client.state).toBe("live");
  });
});
