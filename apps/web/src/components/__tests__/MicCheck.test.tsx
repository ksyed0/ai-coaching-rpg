// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MicCheck, type MicCheckDeps } from "../MicCheck";
import { MESSAGES } from "../../lib/messages";
import { FakeAudioContext, FakeStream, manualFrames, mediaError } from "../../lib/__tests__/voice-fakes";

// US-0071 (A1b Task 15): the lobby's microphone check. The microphone is asked for only by the click; the AudioContext is created and
// resumed inside that click (iOS needs the gesture); the meter's words are plain text, never a live region.

afterEach(cleanup);
beforeEach(() => FakeAudioContext.reset());

function mount(o: { gum?: () => Promise<FakeStream> } = {}) {
  const log: string[] = [];
  const frames = manualFrames();
  const streams: FakeStream[] = [];
  const getUserMedia = vi.fn(async (c: MediaStreamConstraints) => {
    log.push(`gum ${JSON.stringify(c)}`);
    if (o.gum) return o.gum();
    const s = new FakeStream();
    streams.push(s);
    return s;
  });
  const register = vi.fn();
  const deps: MicCheckDeps = { getUserMedia, audioContext: () => new FakeAudioContext(log), raf: frames.raf, caf: frames.caf };
  const r = render(<MicCheck deps={deps} register={register} />);
  return { ...r, log, frames, streams, getUserMedia, register, ctx: () => FakeAudioContext.made.at(-1)! };
}
const start = async () => { await act(async () => { fireEvent.click(screen.getByRole("button", { name: MESSAGES.micCheck })); }); };

describe("MicCheck", () => {
  it("no getUserMedia call on render", () => {
    const m = mount();
    expect(m.getUserMedia).not.toHaveBeenCalled();
    expect(FakeAudioContext.made).toHaveLength(0);
    expect(screen.queryByRole("meter")).toBeNull();
  });

  it("getUserMedia is called only after the click, for audio only", async () => {
    const m = mount();
    await start();
    expect(m.getUserMedia).toHaveBeenCalledTimes(1);
    expect(m.getUserMedia).toHaveBeenCalledWith({ audio: true });
  });

  it("the AudioContext is resumed inside the click handler, before the microphone is asked for", () => {
    const m = mount();
    fireEvent.click(screen.getByRole("button", { name: MESSAGES.micCheck })); // synchronous: no await before the check below
    expect(m.ctx().resumed).toBe(1);
    expect(m.log[0]).toBe("resume");
    expect(m.log[1]).toBe('gum {"audio":true}');
  });

  it("the meter has a name; the meter and the words follow the level", async () => {
    for (const [db, words] of [[-12, MESSAGES.micHearing], [-50, MESSAGES.micTooQuiet], [-70, MESSAGES.micNoSound]] as const) {
      const m = mount();
      await start();
      const meter = screen.getByRole("meter", { name: MESSAGES.micLevelLabel }) as HTMLMeterElement;
      expect(screen.getByText(MESSAGES.micNoSound)).toBeTruthy();
      m.ctx().level(db);
      act(() => { for (const t of [0, 100, 200, 300]) m.frames.frame(t); });
      expect(Math.round(meter.value)).toBe(db);
      expect(screen.getByText(words)).toBeTruthy();
      m.unmount();
    }
  });

  it("the level words are not in a live region", async () => {
    const m = mount();
    await start();
    m.ctx().level(-12);
    act(() => { for (const t of [0, 100, 200, 300]) m.frames.frame(t); });
    const words = screen.getByText(MESSAGES.micHearing);
    expect(words.closest("[aria-live], [role='status'], [role='alert'], [role='log']")).toBeNull();
    expect(screen.getByRole("meter").closest("[aria-live]")).toBeNull();
    expect(screen.getByText(MESSAGES.micHeadset)).toBeTruthy();
  });

  it("a denied permission shows the denied sentence and stays text only (no stream, the context closed)", async () => {
    const m = mount({ gum: () => Promise.reject(mediaError("NotAllowedError")) });
    await start();
    expect(screen.getByRole("alert").textContent).toBe(MESSAGES.micDenied);
    expect(screen.queryByRole("meter")).toBeNull();
    expect(m.ctx().closed).toBe(true);
    expect(m.register).not.toHaveBeenCalledWith(expect.any(Function));
    expect(screen.getByRole("button", { name: MESSAGES.micCheck })).toBeTruthy();
  });

  it("another failure shows the could-not-open sentence", async () => {
    mount({ gum: () => Promise.reject(mediaError("NotFoundError")) });
    await start();
    expect(screen.getByRole("alert").textContent).toBe(MESSAGES.micFailed);
  });

  it("stop releases every track, closes the context and stops the frames", async () => {
    const m = mount();
    await start();
    expect(m.register).toHaveBeenLastCalledWith(expect.any(Function));
    fireEvent.click(screen.getByRole("button", { name: MESSAGES.micStopCheck }));
    expect(m.streams[0]!.tracks.every((t) => t.stopped)).toBe(true);
    expect(m.ctx().closed).toBe(true);
    expect(m.frames.pending).toBe(0);
    expect(m.register).toHaveBeenLastCalledWith(null);
    expect(screen.queryByRole("meter")).toBeNull();
  });

  it("the registered stop (what Join with voice calls) releases the tracks too; unmounting releases them", async () => {
    const m = mount();
    await start();
    const stop = m.register.mock.lastCall![0] as () => void;
    act(() => stop());
    expect(m.streams[0]!.tracks.every((t) => t.stopped)).toBe(true);
    m.unmount();
    const n = mount();
    await start();
    n.unmount();
    expect(n.streams[0]!.tracks.every((t) => t.stopped)).toBe(true);
  });

  it("a stream that arrives after the check was stopped is released at once", async () => {
    let give: (s: FakeStream) => void = () => {};
    const late = new FakeStream();
    const m = mount({ gum: () => new Promise((r) => { give = r; }) });
    fireEvent.click(screen.getByRole("button", { name: MESSAGES.micCheck }));
    m.unmount();
    await act(async () => { give(late); });
    expect(late.tracks.every((t) => t.stopped)).toBe(true);
  });
});
