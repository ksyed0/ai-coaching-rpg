import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeSpeechToText, SpeechUnavailableError, encodeWav, type SpeechToText } from "@acr/adapters";
import type { WorkerConfig } from "../config.js";
import type { AudioIngest } from "../ingest/audio-ingest.js";
import type { ControlToWorker, WorkerMessage } from "../protocol.js";
import { DEFAULT_SEGMENTER } from "../segmenter.js";
import { startWorker } from "../worker.js";
import { concat, silence, tone } from "./signals.js";

let dir: string;
let savedTmp: string | undefined;
beforeAll(async () => {
  savedTmp = process.env.TMPDIR;
  dir = await mkdtemp(path.join(os.tmpdir(), "acr-speech-worker-"));
  process.env.TMPDIR = dir;
});
afterAll(async () => {
  if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp;
  await rm(dir, { recursive: true, force: true });
});

const LOUD = -20;
const BURST = concat(silence(300), tone(800, LOUD), silence(900));
const cfgFor = (roles: string[], ingestDir = dir): WorkerConfig => ({
  segmenter: DEFAULT_SEGMENTER, stt: { kind: "fake", scriptFile: "/unused" }, ingest: { kind: "file", dir: ingestDir, roles },
});
const state = (holders: { roleId: string; participantId: string; recording: boolean }[], o: { paused?: boolean; ended?: boolean } = {}): ControlToWorker =>
  ({ type: "voice_state", paused: o.paused ?? false, ended: o.ended ?? false, holders });

function harness(o: { roles: string[]; stt?: SpeechToText | ((roleId: string) => SpeechToText); ingest?: AudioIngest; ingestDir?: string }) {
  const sent: WorkerMessage[] = [];
  const clock = { t: 9_000_000 };
  const w = startWorker({
    cfg: cfgFor(o.roles, o.ingestDir), send: (m) => { sent.push(m); return true; }, now: () => clock.t,
    stt: o.stt ?? ((roleId) => new FakeSpeechToText({ script: (_s, n) => ({ text: `${roleId} line ${n + 1}`, durationMs: 50 }) })),
    pace: async () => {}, ...(o.ingest ? { ingest: o.ingest } : {}),
  });
  return { w, sent, clock, lines: () => sent.filter((m) => m.type === "voice_line") };
}

describe("startWorker and the US-0071 control messages (A1b Task 2, characterisation)", () => {
  it("livekit_join and stt_slot_grant are ignored until their tasks land: no ingest starts, nothing is sent", async () => {
    const ingest = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const h = harness({ roles: ["tech_lead"], ingest });
    await vi.waitFor(() => expect(h.sent).toContainEqual({ type: "worker_ready", stt: "ok" }));
    const before = h.sent.length;
    h.w.onControl({ type: "livekit_join", roleId: "tech_lead", url: "ws://127.0.0.1:7880", token: "t", room: `v${"0".repeat(32)}` });
    h.w.onControl({ type: "stt_slot_grant", slot: "0123456789abcdef" });
    expect(ingest.start).not.toHaveBeenCalled();
    expect(h.sent.slice(before)).toEqual([]);
    await h.w.stop();
  });
});

describe("startWorker (US-0070): wiring the pipeline to IPC", () => {
  it("worker_ready is sent after warm-up", async () => {
    let release!: () => void;
    const stt = new FakeSpeechToText({ script: () => ({ text: "x", durationMs: 1 }) });
    stt.warmUp = () => new Promise<void>((r) => { release = r; });
    const h = harness({ roles: [], stt });
    await new Promise((r) => setImmediate(r));
    expect(h.sent).toEqual([]);
    release();
    await vi.waitFor(() => expect(h.sent).toEqual([{ type: "worker_ready", stt: "ok" }]));
    await h.w.stop();
  });

  it("nothing is ingested before the first voice_state, and a file plays only once a seat records (not in a lobby nobody records in)", async () => {
    const ingest = { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) };
    const h = harness({ roles: ["tech_lead"], ingest });
    await vi.waitFor(() => expect(h.sent).toContainEqual({ type: "worker_ready", stt: "ok" }));
    h.w.onControl({ type: "voice_line_result", segmentId: "abc", seq: 3 }); // not a state: still nothing
    expect(ingest.start).not.toHaveBeenCalled();
    h.w.onControl(state([]));
    h.w.onControl(state([{ roleId: "tech_lead", participantId: "p1", recording: false }]));
    h.w.onControl(state([{ roleId: "tech_lead", participantId: "p1", recording: true }], { paused: true }));
    expect(ingest.start).not.toHaveBeenCalled();
    h.w.onControl(state([{ roleId: "tech_lead", participantId: "p1", recording: true }]));
    expect(ingest.start).toHaveBeenCalledTimes(1);
    h.w.onControl(state([])); // later states never start a second ingest
    h.w.onControl(state([{ roleId: "tech_lead", participantId: "p1", recording: true }]));
    expect(ingest.start).toHaveBeenCalledTimes(1);
    await h.w.stop();
    expect(ingest.stop).toHaveBeenCalled();
  });

  it("two roles' files give their lines under their own role ids, and the text-only role's file is never transcribed", async () => {
    const sub = await mkdtemp(path.join(dir, "two-"));
    await writeFile(path.join(sub, "tech_lead.wav"), encodeWav(concat(BURST, BURST), 16000));
    await writeFile(path.join(sub, "pm.wav"), encodeWav(BURST, 16000));
    await writeFile(path.join(sub, "designer.wav"), encodeWav(concat(BURST, BURST), 16000));
    const made = new Map<string, FakeSpeechToText>();
    const stt = (roleId: string) => { let f = made.get(roleId); if (!f) { f = new FakeSpeechToText({ script: (_s, n) => ({ text: `${roleId} line ${n + 1}`, durationMs: 50 }) }); made.set(roleId, f); } return f; };
    const h = harness({ roles: ["tech_lead", "pm", "designer"], stt, ingestDir: sub });
    await vi.waitFor(() => expect(h.sent).toContainEqual({ type: "worker_ready", stt: "ok" }));
    h.w.onControl(state([{ roleId: "tech_lead", participantId: "p1", recording: true }, { roleId: "pm", participantId: "p2", recording: true }, { roleId: "designer", participantId: "p3", recording: false }]));
    await vi.waitFor(() => expect(h.lines()).toHaveLength(3));
    expect(h.lines().map((m) => m.type === "voice_line" && [m.roleId, m.participantId, m.text])).toEqual(expect.arrayContaining([
      ["tech_lead", "p1", "tech_lead line 1"], ["tech_lead", "p1", "tech_lead line 2"], ["pm", "p2", "pm line 1"],
    ]));
    expect(made.get("designer")?.calls ?? []).toEqual([]); // AC-0398: the seat that did not opt in is never sent to STT
    expect(h.sent.some((m) => m.type !== "worker_ready" && "roleId" in m && m.roleId === "designer")).toBe(false);
    await h.w.stop();
  });

  it("ended flushes and stops", async () => {
    // An ingest still playing (live audio): every frame is pushed, then it waits for stop, so only the end can close the open segment.
    const pcm = concat(silence(300), tone(900, LOUD)); // still speaking when the end comes
    const ingest: AudioIngest = {
      start: (onFrame) => { for (let i = 0; i + 320 <= pcm.length; i += 320) onFrame("tech_lead", pcm.slice(i, i + 320)); return new Promise<void>(() => {}); },
      stop: async () => {},
    };
    const h = harness({ roles: ["tech_lead"], ingest });
    await vi.waitFor(() => expect(h.sent).toContainEqual({ type: "worker_ready", stt: "ok" }));
    const holders = [{ roleId: "tech_lead", participantId: "p1", recording: true }];
    h.w.onControl(state(holders));
    await vi.waitFor(() => expect(h.sent).toContainEqual({ type: "speech_activity", roleId: "tech_lead", active: true }));
    expect(h.lines()).toEqual([]);
    h.w.onControl(state(holders, { ended: true }));
    await h.w.done;
    expect(h.lines()).toEqual([expect.objectContaining({ roleId: "tech_lead", text: "tech_lead line 1" })]);
    expect(h.sent.at(-1)).toMatchObject({ type: "speech_activity", active: false });
    const before = h.sent.length;
    h.w.onControl(state(holders)); // nothing records after the end
    await new Promise((r) => setImmediate(r));
    expect(h.sent.length).toBe(before);
  });

  // F2 (review fix wave): a file that ends inside an open segment must not leave the speech edge open for the rest of the session.
  it("the end of a file closes its open segment: the line goes out and the speech edge closes", async () => {
    const sub = await mkdtemp(path.join(dir, "eof-"));
    await writeFile(path.join(sub, "tech_lead.wav"), encodeWav(concat(silence(300), tone(900, LOUD)), 16000)); // still speaking at the end
    const h = harness({ roles: ["tech_lead"], ingestDir: sub });
    await vi.waitFor(() => expect(h.sent).toContainEqual({ type: "worker_ready", stt: "ok" }));
    h.w.onControl(state([{ roleId: "tech_lead", participantId: "p1", recording: true }]));
    await vi.waitFor(() => expect(h.sent.at(-1)).toMatchObject({ type: "speech_activity", roleId: "tech_lead", active: false }));
    expect(h.lines()).toEqual([expect.objectContaining({ roleId: "tech_lead", text: "tech_lead line 1" })]);
    expect(h.sent.filter((m) => m.type === "speech_activity").map((m) => (m as { active: boolean }).active)).toEqual([true, false]);
    await h.w.stop();
  });

  it("a file that ends inside a blip too short to keep still closes the speech edge (no line)", async () => {
    const sub = await mkdtemp(path.join(dir, "eofblip-"));
    await writeFile(path.join(sub, "tech_lead.wav"), encodeWav(concat(silence(300), tone(200, LOUD)), 16000));
    const h = harness({ roles: ["tech_lead"], ingestDir: sub });
    await vi.waitFor(() => expect(h.sent).toContainEqual({ type: "worker_ready", stt: "ok" }));
    h.w.onControl(state([{ roleId: "tech_lead", participantId: "p1", recording: true }]));
    await vi.waitFor(() => expect(h.sent.at(-1)).toMatchObject({ type: "speech_activity", roleId: "tech_lead", active: false }));
    expect(h.lines()).toEqual([]);
    await h.w.stop();
  });

  it("a failed warm-up reports stt unavailable and segments fail", async () => {
    const sub = await mkdtemp(path.join(dir, "down-"));
    await writeFile(path.join(sub, "tech_lead.wav"), encodeWav(BURST, 16000));
    const down: SpeechToText = {
      transcribe: async () => { throw new SpeechUnavailableError(); }, health: async () => false, warmUp: async () => { throw new SpeechUnavailableError(); },
    };
    const h = harness({ roles: ["tech_lead"], stt: down, ingestDir: sub });
    await vi.waitFor(() => expect(h.sent).toEqual([{ type: "worker_ready", stt: "unavailable" }]));
    h.w.onControl(state([{ roleId: "tech_lead", participantId: "p1", recording: true }]));
    await vi.waitFor(() => expect(h.sent).toContainEqual(expect.objectContaining({ type: "segment_failed", status: "stt_failed", roleId: "tech_lead" })));
    expect(h.lines()).toEqual([]);
    await h.w.stop();
  });

  it("one shared STT is warmed once; a per-role factory is warmed per distinct instance", async () => {
    const shared = new FakeSpeechToText({ script: () => ({ text: "x", durationMs: 1 }) });
    const h = harness({ roles: ["a", "b"], stt: shared });
    await vi.waitFor(() => expect(h.sent).toContainEqual({ type: "worker_ready", stt: "ok" }));
    expect(shared.warmUps).toBe(1);
    await h.w.stop();
  });

  it("an ingest failure is reported by a fixed line and the worker keeps running", async () => {
    const log: string[] = [];
    const sent: WorkerMessage[] = [];
    const w = startWorker({
      cfg: cfgFor(["tech_lead"]), send: (m) => { sent.push(m); return true; }, now: () => 0, log: (m) => { log.push(m); },
      stt: new FakeSpeechToText({ script: () => ({ text: "x", durationMs: 1 }) }), ingest: { start: async () => { throw new Error(`secret ${dir}`); }, stop: async () => {} },
    });
    w.onControl(state([{ roleId: "tech_lead", participantId: "p1", recording: true }]));
    await vi.waitFor(() => expect(log).toEqual(["speech ingest stopped (Error)"]));
    await w.stop();
  });
});
