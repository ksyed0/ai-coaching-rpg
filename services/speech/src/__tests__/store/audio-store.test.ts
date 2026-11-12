import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionLock } from "@acr/runtime/files";
import { AudioStore, nodeStoreFs, type StoreFs } from "../../store/audio-store.js";
import { DiskGuard } from "../../store/disk-guard.js";
import { readIndex } from "../../store/index-file.js";
import { wavBytes } from "../../store/wav.js";

/** US-0073 (voice A2a, Task 6): the write path. Decide, guard, exclusive WAV (0600), fsync file and folder, then the index line. */
const ID = "0123456789abcdef0123456789abcdef";
let root: string;
let audio: string;
let sessions: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "acr-store-"));
  audio = path.join(root, "audio");
  sessions = path.join(root, "sessions"); mkdirSync(sessions, { mode: 0o700 });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const roomy = () => new DiskGuard({ volumes: [audio, sessions], minFreeMb: 512, statfs: () => ({ bavail: 10n ** 12n, bsize: 4096n }) });
const full = () => new DiskGuard({ volumes: [audio, sessions], minFreeMb: 512, statfs: () => ({ bavail: 1, bsize: 4096 }) });
type Opts = ConstructorParameters<typeof AudioStore>[0];
function make(extra: Partial<Opts> = {}) {
  const onStopped = vi.fn();
  const lock = { lost: false };
  const store = new AudioStore({ audioDir: audio, logIdentity: ID, sessionId: "sess-1", sessionsDir: sessions, minFreeMb: 512, now: () => 1_700_000_000_000, lock, guard: roomy(), onStopped, ...extra });
  return { store, onStopped, lock };
}
const pcm = Int16Array.from([1, -1, 2, -2, 300]);
type Seg = Parameters<AudioStore["write"]>[0];
const seg = (extra: Partial<Seg> = {}): Seg => ({ roleId: "coach", participantId: "p1", segmentId: "seg-1", startMs: 100, endMs: 900, pcm, outcome: { kind: "accepted" }, ...extra });
const roleDir = () => path.join(audio, ID, "coach");
const wavPath = (s = "seg-1") => path.join(roleDir(), `${s}.wav`);
const indexPath = () => path.join(roleDir(), "index.jsonl");

/** The real fs with one call made to throw (the n-th call of that method, default the first). Records every call. */
function faulty(method: keyof StoreFs | null, nth = 1): { fs: StoreFs; calls: string[] } {
  const calls: string[] = [];
  const counts: Record<string, number> = {};
  const fs = Object.fromEntries(Object.entries(nodeStoreFs).map(([k, f]) => [k, (...a: unknown[]) => {
    calls.push(k);
    counts[k] = (counts[k] ?? 0) + 1;
    if (k === method && counts[k] === nth) throw Object.assign(new Error("injected"), { code: "EIO" });
    return (f as (...x: unknown[]) => unknown)(...a);
  }])) as unknown as StoreFs;
  return { fs, calls };
}

describe("AudioStore.write: kept segments", () => {
  it("test_an_accepted_segment_writes_a_private_wav_and_one_index_line", () => {
    const { store, onStopped } = make();
    expect(store.write(seg({ seq: 7, raw: "hello there", timings: { vadEndMs: 880, sttMs: 120 } }))).toBe("written");
    expect(lstatSync(wavPath()).mode & 0o777).toBe(0o600);
    for (const d of [audio, path.join(audio, ID), roleDir()]) expect(lstatSync(d).mode & 0o777).toBe(0o700);
    expect(readFileSync(wavPath())).toEqual(wavBytes(pcm));
    expect(readIndex(indexPath())).toEqual([{ v: 1, kind: "segment", segment: "seg-1", participantId: "p1", startMs: 100, endMs: 900, status: "transcribed", seq: 7, raw: "hello there", timings: { vadEndMs: 880, sttMs: 120 } }]);
    expect(lstatSync(indexPath()).mode & 0o777).toBe(0o600);
    expect(onStopped).not.toHaveBeenCalled();
    expect(store.stopped).toBe(false);
  });
  it("test_optional_fields_are_left_out_when_absent", () => {
    const { store } = make();
    store.write(seg());
    expect(readFileSync(indexPath(), "utf8")).toBe(`${JSON.stringify({ v: 1, kind: "segment", segment: "seg-1", participantId: "p1", startMs: 100, endMs: 900, status: "transcribed" })}\n`);
  });
  it.each(["empty", "stt_failed"] as const)("test_no_text_%s_is_kept", (status) => {
    const { store } = make();
    expect(store.write(seg({ outcome: { kind: "no_text", status } }))).toBe("written");
    expect(existsSync(wavPath())).toBe(true);
    expect(readIndex(indexPath()).map((e) => e.status)).toEqual([status]);
  });
  it.each(["paused", "not_in_scene"] as const)("test_a_timing_refusal_%s_is_kept_as_refused", (code) => {
    const { store } = make();
    expect(store.write(seg({ outcome: { kind: "refused", code }, raw: "words" }))).toBe("written");
    expect(existsSync(wavPath())).toBe(true);
    expect(readIndex(indexPath())).toMatchObject([{ status: `refused:${code}`, raw: "words" }]);
  });
  it("test_two_segments_share_the_role_index", () => {
    const { store } = make();
    store.write(seg({ seq: 1 }));
    store.write(seg({ segmentId: "seg-2", seq: 2 }));
    expect(readIndex(indexPath()).map((e) => [e.segment, e.seq])).toEqual([["seg-1", 1], ["seg-2", 2]]);
    expect(readdirSync(roleDir()).sort()).toEqual(["index.jsonl", "seg-1.wav", "seg-2.wav"]);
  });
  it("test_accepts_a_real_acquired_session_lock", () => {
    const lock = SessionLock.acquire(root, ID, { suffix: "store" });
    try {
      const { store } = make({ lock });
      expect(store.write(seg())).toBe("written");
    } finally { lock.release(); }
  });
});

describe("AudioStore.write: skipped segments touch nothing", () => {
  it.each([
    { kind: "refused", code: "not_recording" }, { kind: "refused", code: "not_holder" }, { kind: "refused", code: "voice_off" },
    { kind: "refused", code: "ai_role" }, { kind: "refused", code: "unknown_role" }, { kind: "refused", code: "failed" },
    { kind: "refused", code: "ended" }, { kind: "refused", code: "not_started" }, { kind: "timeout" },
  ] as const)("test_outcome_%j_is_skipped_with_no_disk_access", (outcome) => {
    const { fs, calls } = faulty(null);
    const { store, onStopped } = make({ fs });
    expect(store.write(seg({ outcome, raw: "secret words" }))).toBe("skipped");
    expect(calls).toEqual([]);
    expect(existsSync(audio)).toBe(false); // not even the folders
    expect(onStopped).not.toHaveBeenCalled();
    expect(store.stopped).toBe(false);
  });
  it("test_a_skip_does_not_consult_the_guard", () => {
    const check = vi.fn(() => ({ ok: true as const }));
    const { store } = make({ guard: { check } as unknown as DiskGuard });
    store.write(seg({ outcome: { kind: "timeout" } }));
    expect(check).not.toHaveBeenCalled();
  });
});

describe("AudioStore.write: faults", () => {
  it.each([
    ["openSync", 1], ["writeSync", 1], ["fsyncSync", 1], ["fsyncDir", 1], ["closeSync", 1],
  ] as const)("test_a_fault_in_%s_leaves_no_wav_no_index_line_and_stops", (method, nth) => {
    const { fs } = faulty(method, nth);
    const { store, onStopped } = make({ fs });
    expect(store.write(seg({ seq: 1 }))).toBe("stopped");
    expect(existsSync(wavPath())).toBe(false); // the partial file is removed
    expect(readIndex(indexPath())).toEqual([]); // never an index line without a WAV
    expect(store.stopped).toBe(true);
    expect(onStopped).toHaveBeenCalledTimes(1);
    expect(onStopped).toHaveBeenCalledWith("write_error");
    // Later writes write nothing and do not report again.
    expect(store.write(seg({ segmentId: "seg-2" }))).toBe("stopped");
    expect(existsSync(wavPath("seg-2"))).toBe(false);
    expect(onStopped).toHaveBeenCalledTimes(1);
  });
  it("test_a_fault_inside_appendIndex_before_any_line_keeps_the_wav_as_an_orphan_and_stops", () => {
    const { fs } = faulty("appendIndex");
    const { store, onStopped } = make({ fs });
    expect(store.write(seg())).toBe("stopped");
    expect(existsSync(wavPath())).toBe(true); // once the append was called the WAV stays (the sweep removes an orphan)
    expect(readIndex(indexPath())).toEqual([]);
    expect(onStopped).toHaveBeenCalledTimes(1);
    expect(onStopped).toHaveBeenCalledWith("write_error");
  });
  it("test_a_fault_after_the_index_line_was_written_keeps_the_wav_and_stops", () => {
    const onStopped = vi.fn();
    const fs: StoreFs = { ...nodeStoreFs, appendIndex: (file, entry) => { nodeStoreFs.appendIndex(file, entry); throw Object.assign(new Error("close"), { code: "EIO" }); } };
    const { store } = make({ fs, onStopped });
    expect(store.write(seg({ seq: 4 }))).toBe("stopped");
    expect(existsSync(wavPath())).toBe(true); // the line may exist, so its WAV is never removed
    expect(readIndex(indexPath()).map((e) => e.segment)).toEqual(["seg-1"]);
    for (const e of readIndex(indexPath())) expect(existsSync(path.join(roleDir(), `${e.segment}.wav`))).toBe(true); // no line without its WAV
    expect(store.stopped).toBe(true);
    expect(onStopped).toHaveBeenCalledTimes(1);
    expect(onStopped).toHaveBeenCalledWith("write_error");
  });
  it("test_a_failing_unlink_during_cleanup_still_stops_without_throwing", () => {
    const base = faulty("fsyncSync").fs;
    const fs: StoreFs = { ...base, unlinkSync: () => { throw new Error("nope"); } };
    const { store, onStopped } = make({ fs });
    expect(store.write(seg())).toBe("stopped");
    expect(onStopped).toHaveBeenCalledWith("write_error");
    expect(readIndex(indexPath())).toEqual([]);
  });
  it("test_an_existing_wav_is_never_overwritten_or_removed", () => {
    mkdirSync(roleDir(), { recursive: true, mode: 0o700 });
    writeFileSync(wavPath(), "ORIGINAL", { mode: 0o600 });
    const { store, onStopped } = make();
    expect(store.write(seg())).toBe("stopped");
    expect(readFileSync(wavPath(), "utf8")).toBe("ORIGINAL");
    expect(onStopped).toHaveBeenCalledWith("write_error");
    expect(readIndex(indexPath())).toEqual([]);
  });
  it("test_a_bad_role_or_segment_id_stops_with_write_error_and_writes_nothing", () => {
    const { store, onStopped } = make();
    expect(store.write(seg({ segmentId: "../escape" }))).toBe("stopped");
    expect(onStopped).toHaveBeenCalledWith("write_error");
    expect(existsSync(path.join(audio, ID, "escape.wav"))).toBe(false);
  });
  it("test_a_short_write_is_completed", () => {
    const fs: StoreFs = { ...nodeStoreFs, writeSync: (fd, buf, off, len) => nodeStoreFs.writeSync(fd, buf, off, Math.min(len, 7)) };
    const { store } = make({ fs });
    expect(store.write(seg())).toBe("written");
    expect(readFileSync(wavPath())).toEqual(wavBytes(pcm));
  });
  it("test_a_zero_byte_write_is_a_write_error", () => {
    const fs: StoreFs = { ...nodeStoreFs, writeSync: () => 0 };
    const { store, onStopped } = make({ fs });
    expect(store.write(seg())).toBe("stopped");
    expect(onStopped).toHaveBeenCalledWith("write_error");
    expect(existsSync(wavPath())).toBe(false);
  });
  it("test_a_throwing_onStopped_does_not_escape_write", () => {
    const { store } = make({ fs: faulty("openSync").fs, onStopped: () => { throw new Error("listener"); } });
    expect(store.write(seg())).toBe("stopped");
    expect(store.stopped).toBe(true);
  });
  it("test_the_wav_is_fsynced_and_the_role_folder_fsynced_before_the_index_line", () => {
    const { fs, calls } = faulty(null);
    const { store } = make({ fs });
    store.write(seg());
    calls.length = 0; // the first write also wrote the session marker; judge the plain path of the second
    store.write(seg({ segmentId: "seg-2" }));
    const order = calls.filter((c) => ["openSync", "fsyncSync", "closeSync", "fsyncDir", "appendIndex"].includes(c));
    expect(order).toEqual(["openSync", "fsyncSync", "closeSync", "fsyncDir", "appendIndex"]);
  });
});

describe("AudioStore: disk guard and lock", () => {
  it("test_a_failing_guard_stops_with_disk_low_and_writes_nothing", () => {
    const { store, onStopped } = make({ guard: full() });
    expect(store.write(seg())).toBe("stopped");
    expect(onStopped).toHaveBeenCalledWith("disk_low");
    expect(existsSync(audio)).toBe(false);
    expect(store.stopped).toBe(true);
    expect(store.write(seg({ outcome: { kind: "no_text", status: "empty" } }))).toBe("stopped");
    expect(onStopped).toHaveBeenCalledTimes(1);
  });
  it("test_the_guard_is_asked_for_the_wav_size", () => {
    const check = vi.fn(() => ({ ok: true as const }));
    const { store } = make({ guard: { check } as unknown as DiskGuard });
    store.write(seg());
    expect(check).toHaveBeenCalledWith(44 + pcm.length * 2);
  });
  it("test_the_default_guard_watches_both_volumes_with_minFreeMb", () => {
    const { store, onStopped } = make({ guard: undefined, minFreeMb: Number.MAX_SAFE_INTEGER });
    expect(store.write(seg())).toBe("stopped");
    expect(onStopped).toHaveBeenCalledWith("disk_low");
    const ok = make({ guard: undefined, minFreeMb: 1 });
    expect(ok.store.write(seg())).toBe("written");
  });
  it("test_lockLost_stops_with_write_error_once", () => {
    const { store, onStopped } = make();
    store.lockLost();
    store.lockLost();
    expect(store.stopped).toBe(true);
    expect(onStopped).toHaveBeenCalledTimes(1);
    expect(onStopped).toHaveBeenCalledWith("write_error");
    expect(store.write(seg())).toBe("stopped");
    expect(existsSync(audio)).toBe(false);
  });
  it("test_a_lock_already_lost_at_write_time_stops_with_write_error", () => {
    const { store, onStopped, lock } = make();
    lock.lost = true;
    expect(store.write(seg())).toBe("stopped");
    expect(onStopped).toHaveBeenCalledWith("write_error");
    expect(existsSync(audio)).toBe(false);
  });
  it("test_a_skipped_segment_after_a_stop_still_reports_stopped", () => {
    const { store } = make();
    store.lockLost();
    expect(store.write(seg({ outcome: { kind: "timeout" } }))).toBe("stopped");
  });
});

describe("AudioStore.markEnded", () => {
  const marker = () => path.join(audio, ID, "ended.json");
  it("test_writes_the_marker_privately", () => {
    const { store } = make();
    store.markEnded();
    expect(JSON.parse(readFileSync(marker(), "utf8"))).toEqual({ v: 1, endedAtMs: 1_700_000_000_000 });
    expect(lstatSync(marker()).mode & 0o777).toBe(0o600);
    for (const d of [audio, path.join(audio, ID)]) expect(lstatSync(d).mode & 0o777).toBe(0o700);
    expect(readdirSync(path.join(audio, ID))).toEqual(["ended.json"]); // no temp file left
  });
  it("test_is_idempotent", () => {
    let t = 5;
    const { store } = make({ now: () => t });
    store.markEnded();
    t = 99;
    store.markEnded();
    expect(JSON.parse(readFileSync(marker(), "utf8"))).toEqual({ v: 1, endedAtMs: 5 });
  });
  it("test_works_after_a_stop_and_beside_segments", () => {
    const { store } = make();
    store.write(seg());
    store.lockLost();
    store.markEnded();
    expect(existsSync(marker())).toBe(true);
    expect(existsSync(wavPath())).toBe(true);
  });
  it.each(["openSync", "writeSync", "fsyncSync", "renameSync", "fsyncDir"] as const)("test_a_fault_in_%s_does_not_throw_or_stop_and_leaves_no_temp_file", (method) => {
    const { fs } = faulty(method);
    const { store, onStopped } = make({ fs });
    expect(() => store.markEnded()).not.toThrow();
    expect(store.stopped).toBe(false);
    expect(onStopped).not.toHaveBeenCalled();
    let left: string[] = [];
    try { left = readdirSync(path.join(audio, ID)); } catch { /* no session folder: nothing left */ }
    expect(left.filter((n) => n !== "ended.json")).toEqual([]);
    store.markEnded(); // a failed attempt may be retried
    expect(existsSync(marker())).toBe(true);
  });
  it("test_a_bad_identity_does_not_throw_and_touches_nothing", () => {
    const { store } = make({ logIdentity: "NOT-HEX" });
    expect(() => store.markEnded()).not.toThrow();
    expect(existsSync(audio)).toBe(false);
  });
});

describe("AudioStore: session marker (US-0074)", () => {
  const markerPath = () => path.join(audio, ID, "session.json");
  it("test_marker_written_before_the_first_wav", () => {
    const { store } = make();
    const order: string[] = [];
    const spy = { ...nodeStoreFs, renameSync: (a: string, b: string) => { order.push(`rename:${path.basename(b)}`); nodeStoreFs.renameSync(a, b); }, openSync: (f: string, fl: number, m: number) => { if (f.endsWith(".wav")) order.push("wav"); return nodeStoreFs.openSync(f, fl, m); } };
    const s2 = make({ fs: spy }).store;
    expect(s2.write(seg())).toBe("written");
    expect(order).toEqual(["rename:session.json", "wav"]);
    expect(JSON.parse(readFileSync(markerPath(), "utf8"))).toEqual({ v: 1, sessionId: "sess-1" });
    expect(lstatSync(markerPath()).mode & 0o777).toBe(0o600);
    expect(readdirSync(path.join(audio, ID)).sort()).toEqual(["coach", "session.json"]);
    void store;
  });
  it("a second write does not rewrite the marker", () => {
    const { fs, calls } = faulty(null);
    const { store } = make({ fs });
    store.write(seg());
    const renames = calls.filter((c) => c === "renameSync").length;
    store.write(seg({ segmentId: "seg-2" }));
    expect(calls.filter((c) => c === "renameSync").length).toBe(renames);
    expect(renames).toBe(1);
  });
  it("test_no_marker_when_nothing_is_written", () => {
    const { store, onStopped } = make();
    expect(store.write(seg({ outcome: { kind: "refused", code: "ended" } }))).toBe("skipped");
    expect(existsSync(path.join(audio, ID))).toBe(false);
    const g = make({ guard: full() });
    expect(g.store.write(seg())).toBe("stopped");
    expect(g.onStopped).toHaveBeenCalledWith("disk_low");
    expect(existsSync(path.join(audio, ID))).toBe(false);
    expect(onStopped).not.toHaveBeenCalled();
  });
  it.each([["openSync", 1], ["fsyncSync", 1], ["renameSync", 1], ["fsyncDir", 1]] as const)("test_marker_failure_stops_the_store_with_write_error (%s)", (method, nth) => {
    const { fs } = faulty(method, nth);
    const { store, onStopped } = make({ fs });
    expect(store.write(seg())).toBe("stopped");
    expect(onStopped).toHaveBeenCalledTimes(1);
    expect(onStopped).toHaveBeenCalledWith("write_error");
    expect(existsSync(wavPath())).toBe(false);
    expect(existsSync(roleDir())).toBe(false);
    expect(readdirSync(path.join(audio, ID)).filter((n) => n.endsWith(".tmp"))).toEqual([]); // no temp file left behind
    expect(store.write(seg({ segmentId: "seg-2" }))).toBe("stopped");
    expect(onStopped).toHaveBeenCalledTimes(1);
  });
  it("test_marker_never_follows_a_link", () => {
    const outside = path.join(root, "outside.txt");
    writeFileSync(outside, "untouched");
    mkdirSync(path.join(audio, ID), { recursive: true, mode: 0o700 });
    symlinkSync(outside, markerPath());
    const { store } = make();
    expect(store.write(seg())).toBe("written");
    expect(readFileSync(outside, "utf8")).toBe("untouched");
    expect(lstatSync(markerPath()).isSymbolicLink()).toBe(false);
    expect(JSON.parse(readFileSync(markerPath(), "utf8"))).toEqual({ v: 1, sessionId: "sess-1" });
  });
});
