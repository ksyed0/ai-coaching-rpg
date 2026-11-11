import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSpeechToText, encodeWav } from "@acr/adapters";
import type { WorkerConfig } from "../../../../speech/src/config.js";
import type { VoiceRefusal, WorkerMessage } from "../../../../speech/src/protocol.js";
import { DEFAULT_SEGMENTER } from "../../../../speech/src/segmenter.js";
import { AudioStore } from "../../../../speech/src/store/audio-store.js";
import { DiskGuard, type StatfsFn } from "../../../../speech/src/store/disk-guard.js";
import { openStore } from "../../../../speech/src/store/store-setup.js";
import { LINE_RESULT_WAIT_MS, startWorker } from "../../../../speech/src/worker.js";
import { concat, silence, tone } from "../../../../speech/src/__tests__/signals.js";
import { AuditLog } from "../../voice/audit-log.js";
import { makeAcquireLock, sweepAudio } from "../../voice/sweep.js";

/**
 * US-0073 (voice A2a, Task 10): the audio store end to end, in one process but with no fake of the store, the sweep or the audit log.
 * The REAL `startWorker` plays a WAV through the REAL file ingest and segmenter into the fake STT; the REAL `openStore` takes the REAL
 * store lock and builds the REAL `AudioStore` (and `DiskGuard`) on a private temp dir; this test plays control and the runtime by sending
 * the same `voice_state` and `voice_line_result` messages they send. Then the REAL `sweepAudio`, with the REAL `AuditLog` and
 * `makeAcquireLock`, runs over the resulting folder on an injected clock. (The forked, real-runtime variant is audio-store.e2e.real.test.ts.)
 */
const DAY_MS = 86_400_000;
const T0 = 1_800_000_000_000;
const ID = "0123456789abcdef0123456789abcdef";
const ID2 = "fedcba9876543210fedcba9876543210";
const ROLE = "coach";
const BURST = concat(silence(300), tone(800, -20), silence(900));
type Holder = { roleId: string; participantId: string; recording: boolean };
const P1: Holder = { roleId: ROLE, participantId: "p1", recording: true };
const state = (holders: Holder[], o: { paused?: boolean; ended?: boolean } = {}) =>
  ({ type: "voice_state" as const, paused: o.paused ?? false, ended: o.ended ?? false, holders });

let root = "";
const releases: (() => void)[] = [];
const workers: { stop(): Promise<void> }[] = [];
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "acr-audio-e2e-")); });
afterEach(async () => {
  for (const w of workers.splice(0)) await w.stop().catch(() => undefined);
  for (const r of releases.splice(0)) r();
  rmSync(root, { recursive: true, force: true });
});

const audioDir = () => path.join(root, "audio");
const sessionDir = (id = ID) => path.join(audioDir(), id);
const roleDir = (id = ID) => path.join(sessionDir(id), ROLE);
const mode = (p: string) => statSync(p).mode & 0o777;
const indexLines = (id = ID): Record<string, unknown>[] =>
  readFileSync(path.join(roleDir(id), "index.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
const auditLines = (id = ID): Record<string, unknown>[] => {
  const f = path.join(audioDir(), `${id}.audio-audit.jsonl`);
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
};

/** One worker session for `id`: `bursts` turns of speech in the coach's file, the real store behind its lock, a controllable clock. */
async function session(o: { id?: string; bursts?: number; at?: number; statfs?: StatfsFn } = {}) {
  const id = o.id ?? ID;
  const clock = { t: o.at ?? T0 };
  const ingestDir = path.join(root, `ingest-${id}`);
  const sessionsDir = path.join(root, "sessions");
  mkdirSync(ingestDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(ingestDir, `${ROLE}.wav`), encodeWav(concat(...Array.from({ length: o.bursts ?? 1 }, () => BURST)), 16_000));
  const sent: WorkerMessage[] = [];
  const send = (m: WorkerMessage): boolean => { sent.push(m); return true; };
  const storeCfg = { audioDir: audioDir(), minFreeMb: 512, logIdentity: id, sessionsDir };
  const statfs = o.statfs;
  const opened = await openStore({
    cfg: storeCfg, now: () => clock.t, send, sleep: async () => {},
    ...(statfs ? { makeStore: (opts: ConstructorParameters<typeof AudioStore>[0]) => new AudioStore({ ...opts, guard: new DiskGuard({ volumes: [opts.audioDir, opts.sessionsDir], minFreeMb: opts.minFreeMb, statfs }) }) } : {}),
  });
  let released = false;
  const release = () => { released = true; opened.release(); };
  releases.push(release);
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const setTimer = (fn: () => void, ms: number) => { const t = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; };
  const cfg: WorkerConfig = { segmenter: DEFAULT_SEGMENTER, stt: { kind: "fake", scriptFile: "/unused" }, ingest: { kind: "file", dir: ingestDir, roles: [ROLE] }, store: storeCfg };
  const w = startWorker({
    cfg, send, now: () => clock.t, setTimer, stt: new FakeSpeechToText({ script: (_s, n) => ({ text: `line ${n + 1}`, durationMs: 50 }) }), store: opened.store,
  });
  workers.push(w);
  void w.done.then(release, release); // as main.ts: the lock goes only after the last write and markEnded
  const lines = () => sent.filter((m): m is Extract<WorkerMessage, { type: "voice_line" }> => m.type === "voice_line");
  return {
    w, sent, clock, lines, timers,
    released: () => released,
    /** Starts recording and waits until every burst has become a voice line. */
    async speak(holders: Holder[] = [P1]) {
      w.onControl(state(holders));
      await vi.waitFor(() => { if (lines().length < (o.bursts ?? 1)) throw new Error("waiting for the voice lines"); }, { timeout: 20_000, interval: 5 });
      return lines();
    },
    answer: (segmentId: string, a: { seq: number } | { refused: VoiceRefusal }) => w.onControl({ type: "voice_line_result", segmentId, ...a }),
    fireWait: () => { for (const t of timers.filter((x) => x.ms === LINE_RESULT_WAIT_MS && !x.cancelled)) { t.cancelled = true; t.fn(); } },
    async end(holders: Holder[] = [P1]) { w.onControl(state(holders, { ended: true })); await w.done; },
  };
}

const sweep = (now: number, retentionDays = 30) => {
  const logs: string[] = [];
  const audit = new AuditLog({ audioDir: audioDir(), now: () => now, log: (m) => logs.push(m) });
  return sweepAudio({ audioDir: audioDir(), retentionDays, now: () => now, audit, acquireLock: makeAcquireLock((m) => logs.push(m)), log: (m) => logs.push(m) })
    .then((r) => ({ ...r, logs }));
};

/** Scenario 1, shared by the retention tests: one accepted line, then the end. Returns the segment id. */
async function acceptedThenEnded(o: { id?: string; at?: number } = {}): Promise<string> {
  const s = await session(o);
  const [line] = await s.speak();
  s.answer(line!.segmentId, { seq: 4 });
  await s.end();
  return line!.segmentId;
}

describe("audio store end to end, in-process real worker + store + sweep (US-0073, Task 10)", () => {
  it("scenario 1: an accepted line leaves a private 16 kHz mono 16-bit WAV, one transcribed index line with its seq, and ended.json", async () => {
    const s = await session();
    const [line] = await s.speak();
    expect(existsSync(sessionDir())).toBe(false); // held in memory until the runtime answers
    s.answer(line!.segmentId, { seq: 4 });
    const wav = path.join(roleDir(), `${line!.segmentId}.wav`);
    expect(existsSync(wav)).toBe(true);
    expect(mode(wav)).toBe(0o600);
    expect(mode(audioDir())).toBe(0o700);
    expect(mode(sessionDir())).toBe(0o700);
    expect(mode(roleDir())).toBe(0o700);
    expect(mode(path.join(roleDir(), "index.jsonl"))).toBe(0o600);
    const b = readFileSync(wav);
    expect(b.toString("ascii", 0, 4)).toBe("RIFF");
    expect(b.readUInt32LE(4)).toBe(b.length - 8);
    expect(b.toString("ascii", 8, 12)).toBe("WAVE");
    expect(b.toString("ascii", 12, 16)).toBe("fmt ");
    expect(b.readUInt32LE(16)).toBe(16);
    expect(b.readUInt16LE(20)).toBe(1); // PCM
    expect(b.readUInt16LE(22)).toBe(1); // mono
    expect(b.readUInt32LE(24)).toBe(16_000);
    expect(b.readUInt32LE(28)).toBe(32_000);
    expect(b.readUInt16LE(32)).toBe(2);
    expect(b.readUInt16LE(34)).toBe(16);
    expect(b.toString("ascii", 36, 40)).toBe("data");
    expect(b.readUInt32LE(40)).toBe(b.length - 44);
    expect(b.length - 44).toBeGreaterThan(16_000); // at least half a second of speech
    expect(indexLines()).toEqual([expect.objectContaining({ v: 1, kind: "segment", segment: line!.segmentId, participantId: "p1", status: "transcribed", seq: 4, raw: "line 1" })]);
    expect(existsSync(path.join(sessionDir(), "ended.json"))).toBe(false);
    s.clock.t = T0 + 5_000;
    await s.end();
    const ended = path.join(sessionDir(), "ended.json");
    expect(JSON.parse(readFileSync(ended, "utf8"))).toEqual({ v: 1, endedAtMs: T0 + 5_000 });
    expect(mode(ended)).toBe(0o600);
    expect(s.released()).toBe(true);
    expect(existsSync(path.join(audioDir(), `${ID}.store.lock`))).toBe(false);
    expect(s.sent.filter((m) => m.type === "store_stopped")).toEqual([]);
  });

  describe("scenario 2: the consent race (an answer that arrives after the role stopped) writes nothing", () => {
    const cases: [string, Holder[], { paused?: boolean }][] = [
      ["an opt-out", [{ ...P1, recording: false }], {}],
      ["a reissue to another participant", [{ ...P1, participantId: "p9" }], {}],
      ["a pause", [P1], { paused: true }],
    ];
    for (const [what, holders, o] of cases) {
      it(`scenario 2: a seq after ${what} leaves no file and no role folder`, async () => {
        const s = await session();
        const [line] = await s.speak();
        s.w.onControl(state(holders, o));
        s.answer(line!.segmentId, { seq: 1 });
        s.answer(line!.segmentId, { refused: "paused" }); // not even a kept-class refusal brings it back
        expect(existsSync(roleDir())).toBe(false);
        expect(existsSync(sessionDir())).toBe(false);
        await s.end(holders);
        expect(readdirSync(sessionDir())).toEqual(["ended.json"]); // only the marker; no role folder ever appeared
      });
    }
  });

  it("scenario 3: refused not_recording, failed, ended, not_started and no answer at all write nothing; paused and not_in_scene are kept as refused:<code>", async () => {
    const dropped: VoiceRefusal[] = ["not_recording", "failed", "ended", "not_started"];
    const s = await session({ bursts: dropped.length + 3 });
    const ls = await s.speak();
    dropped.forEach((code, i) => s.answer(ls[i]!.segmentId, { refused: code }));
    const silent = ls[dropped.length]!; // never answered
    s.clock.t = T0 + LINE_RESULT_WAIT_MS + 1;
    // Only the unanswered segments still wait: fire their backstop timers. The two kept-class ones are answered after, so arm them again.
    const [pausedSeg, notInScene] = [ls[dropped.length + 1]!, ls[dropped.length + 2]!];
    const live = s.timers.filter((t) => t.ms === LINE_RESULT_WAIT_MS && !t.cancelled);
    expect(live).toHaveLength(3);
    live[0]!.cancelled = true; live[0]!.fn(); // the oldest waiting: `silent`
    s.answer(silent.segmentId, { seq: 9 }); // too late
    expect(existsSync(sessionDir())).toBe(false);
    s.answer(pausedSeg.segmentId, { refused: "paused" });
    s.answer(notInScene.segmentId, { refused: "not_in_scene" });
    expect(readdirSync(roleDir()).sort()).toEqual([`${notInScene.segmentId}.wav`, `${pausedSeg.segmentId}.wav`, "index.jsonl"].sort());
    expect(indexLines().map((e) => [e.segment, e.status, e.seq])).toEqual([
      [pausedSeg.segmentId, "refused:paused", undefined],
      [notInScene.segmentId, "refused:not_in_scene", undefined],
    ]);
    await s.end();
  });

  it("scenario 3b: a segment left unanswered past the worker's wait writes nothing (the only segment, no other folder)", async () => {
    const s = await session();
    const [line] = await s.speak();
    s.clock.t = T0 + LINE_RESULT_WAIT_MS + 1;
    s.fireWait();
    s.answer(line!.segmentId, { seq: 1 });
    expect(existsSync(sessionDir())).toBe(false);
    await s.end();
    expect(readdirSync(sessionDir())).toEqual(["ended.json"]);
  });

  it("scenario 4: low disk (the real DiskGuard on a tiny statfs) sends store_stopped disk_low once, writes no audio, and the voice lines still go", async () => {
    const tiny: StatfsFn = () => ({ bavail: 10, bsize: 4096 });
    const s = await session({ bursts: 2, statfs: tiny });
    const ls = await s.speak();
    expect(ls.map((l) => l.text)).toEqual(["line 1", "line 2"]);
    s.answer(ls[0]!.segmentId, { seq: 1 });
    s.answer(ls[1]!.segmentId, { seq: 2 });
    expect(s.sent.filter((m) => m.type === "store_stopped")).toEqual([{ type: "store_stopped", reason: "disk_low" }]);
    expect(existsSync(sessionDir())).toBe(false);
    await s.end();
    expect(existsSync(roleDir())).toBe(false);
  });

  for (const days of [1, 30]) {
    it(`scenario 5: retention ${days} d: the real sweep removes the expired folder, audits exactly once, keeps the audit file and a younger session`, async () => {
      const seg = await acceptedThenEnded();
      await acceptedThenEnded({ id: ID2, at: T0 + DAY_MS / 2 }); // ends half a day later: younger than the cap at the sweep time
      expect(existsSync(path.join(roleDir(), `${seg}.wav`))).toBe(true);
      const before = await sweep(T0 + days * DAY_MS - 1, days);
      expect(before).toMatchObject({ deleted: 0, skipped: 0 });
      expect(existsSync(sessionDir())).toBe(true);
      const at = T0 + days * DAY_MS;
      const r = await sweep(at, days);
      expect(r).toMatchObject({ deleted: 1, skipped: 0, logs: [] });
      expect(existsSync(sessionDir())).toBe(false);
      expect(readdirSync(audioDir()).filter((n) => n.includes(".deleting-"))).toEqual([]);
      expect(auditLines()).toEqual([{ v: 1, ts: at, type: "audio.deleted", scope: { kind: "session" }, reason: "expired", by: "system", segments: 1 }]);
      expect(mode(path.join(audioDir(), `${ID}.audio-audit.jsonl`))).toBe(0o600);
      expect(existsSync(path.join(audioDir(), `${ID}.store.lock`))).toBe(false);
      expect(existsSync(path.join(audioDir(), `${ID}.audio-audit.lock`))).toBe(false);
      // The younger session is untouched and was never audited.
      expect(readdirSync(roleDir(ID2)).length).toBe(2);
      expect(auditLines(ID2)).toEqual([]);
      // A second run changes nothing: still one audit line.
      const again = await sweep(at + 1, days);
      expect(again).toMatchObject({ deleted: 0, skipped: 0 });
      expect(auditLines()).toHaveLength(1);
      expect(existsSync(sessionDir(ID2))).toBe(true);
    });
  }

  it("scenario 5b: the sweep counts every WAV of the session in its one audit line", async () => {
    const s = await session({ bursts: 3 });
    const ls = await s.speak();
    s.answer(ls[0]!.segmentId, { seq: 1 });
    s.answer(ls[1]!.segmentId, { refused: "paused" });
    s.answer(ls[2]!.segmentId, { refused: "failed" }); // dropped: not counted
    await s.end();
    await sweep(T0 + 30 * DAY_MS);
    expect(auditLines()).toEqual([expect.objectContaining({ type: "audio.deleted", segments: 2 })]);
  });

  it("scenario 6: while the worker holds the store lock the sweep skips the session and deletes nothing; after it releases, the next sweep deletes it", async () => {
    const s = await session();
    const [line] = await s.speak();
    s.answer(line!.segmentId, { seq: 1 });
    const lock = path.join(audioDir(), `${ID}.store.lock`);
    expect(existsSync(lock)).toBe(true);
    const far = T0 + 365 * DAY_MS; // long expired by any clock
    const blocked = await sweep(far);
    expect(blocked).toMatchObject({ deleted: 0, skipped: 1, orphans: 0 });
    expect(existsSync(path.join(roleDir(), `${line!.segmentId}.wav`))).toBe(true);
    expect(auditLines()).toEqual([]);
    expect(existsSync(lock)).toBe(true); // the sweep never removes a lock it did not take
    await s.end();
    expect(s.released()).toBe(true);
    const r = await sweep(far);
    expect(r).toMatchObject({ deleted: 1, skipped: 0 });
    expect(existsSync(sessionDir())).toBe(false);
    expect(auditLines()).toEqual([expect.objectContaining({ type: "audio.deleted", segments: 1 })]);
  });

  it("scenario 7: an orphan WAV (no index line) in a kept folder is removed by the sweep; the indexed WAV and the index stay", async () => {
    const seg = await acceptedThenEnded();
    const orphan = path.join(roleDir(), "0badc0de0badc0de.wav");
    writeFileSync(orphan, Buffer.alloc(64), { mode: 0o600 });
    const index = readFileSync(path.join(roleDir(), "index.jsonl"), "utf8");
    const r = await sweep(T0 + DAY_MS);
    expect(r).toMatchObject({ deleted: 0, skipped: 0, orphans: 1 });
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(path.join(roleDir(), `${seg}.wav`))).toBe(true);
    expect(readFileSync(path.join(roleDir(), "index.jsonl"), "utf8")).toBe(index);
    expect(auditLines()).toEqual([]);
  });
});
