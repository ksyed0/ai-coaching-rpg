import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { FakeSpeechToText } from "@acr/adapters";
import type { WorkerConfig } from "../config.js";
import type { AudioIngest } from "../ingest/audio-ingest.js";
import { MAX_PENDING_LINES, VOICE_LINE_TIMEOUT_MS, type ControlToWorker, type VoiceRefusal, type WorkerMessage } from "../protocol.js";
import { DEFAULT_SEGMENTER } from "../segmenter.js";
import { AudioStore, type StoreSegment, type WriteResult } from "../store/audio-store.js";
import { DiskGuard } from "../store/disk-guard.js";
import { readIndex } from "../store/index-file.js";
import { LINE_RESULT_WAIT_MS, startWorker } from "../worker.js";
import { concat, frames, silence, tone } from "./signals.js";

/**
 * US-0073 (voice A2a, Task 7b): the worker holds a text segment's audio until the runtime answers, and writes it through the store only
 * for an answer the consent rule keeps. Review Focus 1: an opt-out, reissue or pause while a segment waits means no file, ever.
 */
const BURST = concat(silence(300), tone(800, -20), silence(900));
const cfg: WorkerConfig = { segmenter: DEFAULT_SEGMENTER, stt: { kind: "fake", scriptFile: "/unused" }, ingest: { kind: "file", dir: "/unused", roles: ["coach", "pm"] } };
type Holder = { roleId: string; participantId: string; recording: boolean };
const state = (holders: Holder[], o: { paused?: boolean; ended?: boolean } = {}): ControlToWorker =>
  ({ type: "voice_state", paused: o.paused ?? false, ended: o.ended ?? false, holders });
const BOTH: Holder[] = [{ roleId: "coach", participantId: "p1", recording: true }, { roleId: "pm", participantId: "p2", recording: true }];
const settle = async () => { for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r)); };

type Store = { write: Mock<(seg: StoreSegment) => WriteResult>; markEnded: Mock<() => void>; stopped: boolean };
const fakeStore = (): Store => ({ write: vi.fn((_seg: StoreSegment): WriteResult => "written"), markEnded: vi.fn(), stopped: false });

/** `reply(n)`: the n-th transcription's result (text, "" for empty, or an Error for stt_failed). */
function harness(o: { store?: Store | AudioStore; reply?: (n: number) => string | Error } = {}) {
  const sent: WorkerMessage[] = [];
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const setTimer = (fn: () => void, ms: number) => { const t = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; };
  let sink: ((roleId: string, g: string | undefined, f: Int16Array) => void) | null = null;
  const ingest: AudioIngest = { start: (fn) => { sink = fn; return new Promise<void>(() => {}); }, stop: async () => {} };
  const reply = o.reply ?? ((n: number) => `line ${n + 1}`);
  const w = startWorker({
    cfg, send: (m) => { sent.push(m); return true; }, now: () => 9_000_000, ingest, setTimer,
    stt: new FakeSpeechToText({ script: (_s, n) => { const r = reply(n); return r instanceof Error ? r : { text: r, durationMs: 50 }; } }),
    ...(o.store ? { store: o.store } : {}),
  });
  const speak = async (roleId = "coach") => { for (const f of frames(BURST)) sink?.(roleId, undefined, f); await settle(); };
  const lines = () => sent.filter((m): m is Extract<WorkerMessage, { type: "voice_line" }> => m.type === "voice_line");
  const answer = (segmentId: string, a: { seq: number } | { refused: VoiceRefusal }) => w.onControl({ type: "voice_line_result", segmentId, ...a });
  const fire = (ms: number) => { for (const t of timers.filter((x) => x.ms === ms && !x.cancelled)) { t.cancelled = true; t.fn(); } };
  const live = (ms: number) => timers.filter((t) => t.ms === ms && !t.cancelled).length;
  return { w, sent, speak, lines, answer, fire, live, timers };
}
const outcomes = (s: Store) => s.write.mock.calls.map((c) => c[0].outcome);

describe("worker pending segments (US-0073, A2a Task 7b)", () => {
  it("the backstop wait is control's timeout plus 2 s, and the cap is shared with control", () => {
    expect(LINE_RESULT_WAIT_MS).toBe(VOICE_LINE_TIMEOUT_MS + 2_000);
    expect(MAX_PENDING_LINES).toBe(256);
  });

  it("an accepted line is written with its seq, raw text and audio, once, and only after the answer", async () => {
    const store = fakeStore();
    const h = harness({ store });
    h.w.onControl(state(BOTH));
    await h.speak();
    const [line] = h.lines();
    expect(line).toBeDefined();
    expect(store.write).not.toHaveBeenCalled();
    expect(h.live(LINE_RESULT_WAIT_MS)).toBe(1);
    h.answer(line!.segmentId, { seq: 7 });
    expect(store.write).toHaveBeenCalledTimes(1);
    const seg = store.write.mock.calls[0]![0];
    expect(seg).toMatchObject({ roleId: "coach", participantId: "p1", segmentId: line!.segmentId, startMs: line!.startMs, endMs: line!.endMs, outcome: { kind: "accepted" }, seq: 7, raw: line!.text });
    expect(seg.pcm).toBeInstanceOf(Int16Array);
    expect(seg.pcm.length).toBeGreaterThan(0);
    expect(h.live(LINE_RESULT_WAIT_MS)).toBe(0); // the timer was cleared
    h.answer(line!.segmentId, { seq: 7 }); // a duplicate answer finds nothing
    expect(store.write).toHaveBeenCalledTimes(1);
    await h.w.stop();
  });

  it("each refusal is passed to the store as that refusal (decide keeps or skips), never as accepted", async () => {
    const store = fakeStore();
    const h = harness({ store });
    h.w.onControl(state(BOTH));
    const codes: VoiceRefusal[] = ["not_recording", "failed", "ended", "not_started", "paused", "not_in_scene"];
    for (const _ of codes) await h.speak();
    const ls = h.lines();
    expect(ls).toHaveLength(codes.length);
    codes.forEach((code, i) => h.answer(ls[i]!.segmentId, { refused: code }));
    expect(outcomes(store)).toEqual(codes.map((code) => ({ kind: "refused", code })));
    for (const c of store.write.mock.calls) expect(c[0].seq).toBeUndefined();
    await h.w.stop();
  });

  it("no answer within the wait writes nothing, and a late seq after that is ignored", async () => {
    const store = fakeStore();
    const h = harness({ store });
    h.w.onControl(state(BOTH));
    await h.speak();
    const [line] = h.lines();
    h.fire(LINE_RESULT_WAIT_MS);
    expect(store.write).not.toHaveBeenCalled();
    h.answer(line!.segmentId, { seq: 3 });
    expect(store.write).not.toHaveBeenCalled();
    await h.w.stop();
  });

  it("an answer for a segment nobody holds (unknown id) is ignored", async () => {
    const store = fakeStore();
    const h = harness({ store });
    h.w.onControl(state(BOTH));
    h.answer("0123456789abcdef", { seq: 1 });
    expect(store.write).not.toHaveBeenCalled();
    await h.w.stop();
  });

  it("Review Focus 1: an opt-out while the segment waits drops it, so a later seq writes nothing; another role's segment still waits", async () => {
    const store = fakeStore();
    const h = harness({ store });
    h.w.onControl(state(BOTH));
    await h.speak("coach");
    await h.speak("pm");
    const [coach, pm] = h.lines();
    h.w.onControl(state([{ roleId: "coach", participantId: "p1", recording: false }, BOTH[1]!])); // coach opts out
    expect(h.live(LINE_RESULT_WAIT_MS)).toBe(1); // coach's timer cleared at once, pm's still runs
    h.answer(coach!.segmentId, { seq: 1 });
    expect(store.write).not.toHaveBeenCalled();
    h.answer(pm!.segmentId, { seq: 2 });
    expect(store.write).toHaveBeenCalledTimes(1);
    expect(store.write.mock.calls[0]![0]).toMatchObject({ roleId: "pm", seq: 2 });
    await h.w.stop();
  });

  it("Review Focus 1: a reissue (the seat now held by another participant) while the segment waits writes nothing", async () => {
    const store = fakeStore();
    const h = harness({ store });
    h.w.onControl(state(BOTH));
    await h.speak();
    const [line] = h.lines();
    h.w.onControl(state([{ roleId: "coach", participantId: "p9", recording: true }, BOTH[1]!]));
    h.answer(line!.segmentId, { seq: 1 });
    expect(store.write).not.toHaveBeenCalled();
    await h.w.stop();
  });

  it("a pause while the segment waits drops it, so even a later refused:paused writes nothing", async () => {
    const store = fakeStore();
    const h = harness({ store });
    h.w.onControl(state(BOTH));
    await h.speak();
    const [line] = h.lines();
    h.w.onControl(state(BOTH, { paused: true }));
    expect(h.live(LINE_RESULT_WAIT_MS)).toBe(0);
    h.answer(line!.segmentId, { refused: "paused" });
    h.answer(line!.segmentId, { seq: 1 });
    expect(store.write).not.toHaveBeenCalled();
    await h.w.stop();
  });

  it(`beyond MAX_PENDING_LINES the oldest waiting segment is dropped unwritten (and its timer cleared)`, async () => {
    const store = fakeStore();
    const h = harness({ store });
    h.w.onControl(state(BOTH));
    for (let i = 0; i <= MAX_PENDING_LINES; i++) await h.speak();
    const ls = h.lines();
    expect(ls).toHaveLength(MAX_PENDING_LINES + 1);
    expect(h.live(LINE_RESULT_WAIT_MS)).toBe(MAX_PENDING_LINES);
    h.answer(ls[0]!.segmentId, { seq: 1 }); // the oldest: dropped
    expect(store.write).not.toHaveBeenCalled();
    h.answer(ls[1]!.segmentId, { seq: 2 });
    h.answer(ls[MAX_PENDING_LINES]!.segmentId, { seq: 3 });
    expect(store.write.mock.calls.map((c) => c[0].seq)).toEqual([2, 3]);
    await h.w.stop();
  }, 60_000);

  it("empty and stt_failed are written at once (no line, no wait)", async () => {
    const store = fakeStore();
    const h = harness({ store, reply: (n) => (n === 0 ? "" : new Error("boom")) });
    h.w.onControl(state(BOTH));
    await h.speak();
    await h.speak();
    expect(h.lines()).toEqual([]);
    expect(outcomes(store)).toEqual([{ kind: "no_text", status: "empty" }, { kind: "no_text", status: "stt_failed" }]);
    expect(store.write.mock.calls[0]![0].raw).toBeUndefined();
    expect(h.live(LINE_RESULT_WAIT_MS)).toBe(0);
    await h.w.stop();
  });

  it("the ended state drops every waiting segment unwritten, then calls markEnded once", async () => {
    const store = fakeStore();
    const h = harness({ store });
    h.w.onControl(state(BOTH));
    await h.speak();
    const [line] = h.lines();
    h.w.onControl(state(BOTH, { ended: true }));
    await h.w.done;
    expect(store.markEnded).toHaveBeenCalledTimes(1);
    expect(h.live(LINE_RESULT_WAIT_MS)).toBe(0);
    h.answer(line!.segmentId, { seq: 1 });
    expect(store.write).not.toHaveBeenCalled();
    h.w.onControl(state(BOTH, { ended: true })); // a repeated end changes nothing
    expect(store.markEnded).toHaveBeenCalledTimes(1);
  });

  it("stop drops every waiting segment unwritten", async () => {
    const store = fakeStore();
    const h = harness({ store });
    h.w.onControl(state(BOTH));
    await h.speak();
    const [line] = h.lines();
    await h.w.stop();
    expect(h.live(LINE_RESULT_WAIT_MS)).toBe(0);
    h.answer(line!.segmentId, { seq: 1 });
    expect(store.write).not.toHaveBeenCalled();
  });

  it("a stopped store is never written, and the voice line is still sent", async () => {
    const store = fakeStore();
    store.stopped = true;
    const h = harness({ store, reply: (n) => (n === 1 ? "" : `line ${n + 1}`) });
    h.w.onControl(state(BOTH));
    await h.speak();
    await h.speak(); // empty
    const [line] = h.lines();
    expect(line).toMatchObject({ type: "voice_line", text: "line 1" });
    h.answer(line!.segmentId, { seq: 1 });
    expect(store.write).not.toHaveBeenCalled();
    await h.w.stop();
  });

  it("a store that stops while a segment waits is not written when the answer comes", async () => {
    const store = fakeStore();
    const h = harness({ store });
    h.w.onControl(state(BOTH));
    await h.speak();
    const [line] = h.lines();
    store.stopped = true;
    h.answer(line!.segmentId, { seq: 1 });
    expect(store.write).not.toHaveBeenCalled();
    await h.w.stop();
  });

  it("without a store nothing waits: no backstop timer, and answers are ignored", async () => {
    const h = harness();
    h.w.onControl(state(BOTH));
    await h.speak();
    const [line] = h.lines();
    expect(line).toBeDefined();
    expect(h.live(LINE_RESULT_WAIT_MS)).toBe(0);
    h.answer(line!.segmentId, { seq: 1 });
    await h.w.stop();
  });
});

describe("worker pending segments with the real AudioStore (US-0073, A2a Task 7b integration)", () => {
  const ID = "0123456789abcdef0123456789abcdef";
  let root: string;
  beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "acr-worker-audio-")); mkdirSync(path.join(root, "sessions"), { mode: 0o700 }); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("refused not_recording, failed, ended, not_started and a timeout leave no file; paused leaves refused:paused; accepted is transcribed", async () => {
    const audio = path.join(root, "audio");
    const onStopped = vi.fn();
    const store = new AudioStore({
      audioDir: audio, logIdentity: ID, sessionsDir: path.join(root, "sessions"), minFreeMb: 512, now: () => 1, lock: { lost: false }, onStopped,
      guard: new DiskGuard({ volumes: [audio, path.join(root, "sessions")], minFreeMb: 512, statfs: () => ({ bavail: 10n ** 12n, bsize: 4096n }) }),
    });
    const h = harness({ store });
    h.w.onControl(state(BOTH));
    const dropped: VoiceRefusal[] = ["not_recording", "failed", "ended", "not_started"];
    for (let i = 0; i < dropped.length + 1; i++) await h.speak(); // the last one times out
    const ls = h.lines();
    dropped.forEach((code, i) => h.answer(ls[i]!.segmentId, { refused: code }));
    h.fire(LINE_RESULT_WAIT_MS);
    const roleDir = path.join(audio, ID, "coach");
    expect(existsSync(roleDir)).toBe(false); // nothing was written, not even the folders
    await h.speak();
    await h.speak();
    const [paused, accepted] = h.lines().slice(dropped.length + 1);
    h.answer(paused!.segmentId, { refused: "paused" });
    h.answer(accepted!.segmentId, { seq: 5 });
    expect(readdirSync(roleDir).sort()).toEqual([`${accepted!.segmentId}.wav`, `${paused!.segmentId}.wav`, "index.jsonl"].sort());
    expect(readIndex(path.join(roleDir, "index.jsonl")).map((e) => ({ segment: e.segment, status: e.status, seq: e.seq }))).toEqual([
      { segment: paused!.segmentId, status: "refused:paused", seq: undefined },
      { segment: accepted!.segmentId, status: "transcribed", seq: 5 },
    ]);
    expect(onStopped).not.toHaveBeenCalled();
    h.w.onControl(state(BOTH, { ended: true }));
    await h.w.done;
    expect(existsSync(path.join(audio, ID, "ended.json"))).toBe(true);
  });
});
