import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionLock } from "@acr/runtime/files";
import { AuditLog, type AuditEvent } from "../../voice/audit-log.js";
import { SWEEP_DIR_UNSAFE, SWEEP_REMOVE_FAILED, makeAcquireLock, sweepTestHooks, startAudioSweep, segmentIdOf, startSweepSchedule, stopWithin, sweepAudio } from "../../voice/sweep.js";

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1); // a whole second, so file times set through utimes are exact
const id = (n: number): string => n.toString(16).padStart(32, "0");
const A = id(0xa), B = id(0xb), C = id(0xc);

let root: string, audioDir: string, logs: string[];
type Call = { id: string; e: AuditEvent; onDisk: string[] };
let calls: Call[];
const fakeAudit = { append: async (logIdentity: string, e: AuditEvent): Promise<void> => { calls.push({ id: logIdentity, e, onDisk: readdirSync(audioDir).sort() }); } };

type Session = { ended?: number | string; index?: Record<string, Array<Record<string, unknown> | string>>; wavs?: Record<string, number>; mtime?: number };
/** A session folder as the speech worker leaves it: `<id>/<role>/<n>.wav`, `<id>/<role>/index.jsonl`, `<id>/ended.json`. */
function mkSession(sid: string, s: Session): string {
  const dir = path.join(audioDir, sid);
  mkdirSync(dir, { mode: 0o700 });
  const roles = new Set([...Object.keys(s.index ?? {}), ...Object.keys(s.wavs ?? {})]);
  for (const role of roles) {
    mkdirSync(path.join(dir, role), { mode: 0o700 });
    for (let i = 0; i < (s.wavs?.[role] ?? 0); i++) writeFileSync(path.join(dir, role, `seg${i}.wav`), "RIFF....", { mode: 0o600 });
    const lines = s.index?.[role];
    if (lines) writeFileSync(path.join(dir, role, "index.jsonl"), lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n", { mode: 0o600 });
  }
  if (s.ended !== undefined) writeFileSync(path.join(dir, "ended.json"), typeof s.ended === "string" ? s.ended : JSON.stringify({ v: 1, endedAtMs: s.ended }), { mode: 0o600 });
  if (s.mtime !== undefined) {
    const t = s.mtime / 1000;
    for (const role of roles) {
      for (const f of readdirSync(path.join(dir, role))) utimesSync(path.join(dir, role, f), t, t);
      utimesSync(path.join(dir, role), t, t);
    }
    if (s.ended !== undefined) utimesSync(path.join(dir, "ended.json"), t, t);
  }
  return dir;
}
const seg = (startMs: number, endMs: number) => ({ v: 1, kind: "segment", seq: 1, segment: "seg0", startMs, endMs });

const run = (o: { now: number; retentionDays?: number; acquireLock?: (dir: string, sid: string) => { release(): void } | null; audit?: { append: AuditLog["append"] } }) =>
  sweepAudio({
    audioDir, retentionDays: o.retentionDays ?? 30, now: () => o.now, audit: o.audit ?? fakeAudit,
    acquireLock: o.acquireLock ?? makeAcquireLock(), log: (m) => logs.push(m),
  });
const storeLocks = () => readdirSync(audioDir).filter((n) => n.endsWith(".store.lock"));
const deleting = (sid: string) => readdirSync(audioDir).filter((n) => n.startsWith(`${sid}.deleting-`));

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "acr-sweep-"));
  audioDir = path.join(root, "audio");
  mkdirSync(audioDir, { mode: 0o700 });
  logs = []; calls = [];
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

describe("sweepAudio (US-0073, A2a Task 9a)", () => {
  it.each([30, 1])("deletes at exactly %i days and after, keeps one ms before (boundary inclusive)", async (days) => {
    const now = T0 + 100 * DAY;
    mkSession(A, { ended: now - days * DAY + 1, wavs: { tech_lead: 2 } }); // 1 ms short
    mkSession(B, { ended: now - days * DAY, wavs: { tech_lead: 3, pm: 1 } }); // exactly
    mkSession(C, { ended: now - days * DAY - 1, wavs: {} }); // 1 ms over
    expect(await run({ now, retentionDays: days })).toEqual({ deleted: 2, skipped: 0, orphans: 2 }); // A is kept; its 2 unindexed WAVs are orphans
    expect(existsSync(path.join(audioDir, A))).toBe(true);
    expect(existsSync(path.join(audioDir, B))).toBe(false);
    expect(existsSync(path.join(audioDir, C))).toBe(false);
    expect(readdirSync(audioDir).filter((n) => n.includes(".deleting-"))).toEqual([]);
    expect(calls.map((c) => [c.id, c.e])).toEqual(expect.arrayContaining([
      [B, { type: "audio.deleted", scope: { kind: "session" }, reason: "expired", by: "system", segments: 4 }],
      [C, { type: "audio.deleted", scope: { kind: "session" }, reason: "expired", by: "system", segments: 0 }],
    ]));
    expect(calls).toHaveLength(2);
    expect(storeLocks()).toEqual([]); // every lock released, the kept session's too
    expect(logs).toEqual([]);
  });

  describe("the expiry clock", () => {
    it("ended.json wins over the index and file times", async () => {
      const now = T0 + 100 * DAY;
      mkSession(A, { ended: now - 30 * DAY, index: { r: [seg(now - DAY, now - DAY)] }, wavs: { r: 1 } }); // marker old, index recent
      mkSession(B, { ended: now - 30 * DAY + 1, index: { r: [seg(T0, T0)] }, wavs: { r: 1 }, mtime: T0 }); // marker recent, rest old
      expect(await run({ now })).toEqual({ deleted: 1, skipped: 0, orphans: 0 });
      expect(existsSync(path.join(audioDir, A))).toBe(false);
      expect(existsSync(path.join(audioDir, B))).toBe(true);
    });

    it("no marker: the largest index endMs over all roles plus 24 h (boundary inclusive)", async () => {
      const last = T0 + 10 * DAY;
      const index = { r1: [seg(T0, T0 + 1000), seg(last - 5000, last)], r2: [seg(T0, last - 2000), "{torn"] };
      mkSession(A, { index, wavs: { r1: 2, r2: 1 }, mtime: T0 }); // seg0 is indexed in both roles; r1's seg1 is an orphan
      const expiry = last + DAY + 30 * DAY;
      expect(await run({ now: expiry - 1 })).toEqual({ deleted: 0, skipped: 0, orphans: 1 });
      expect(existsSync(path.join(audioDir, A))).toBe(true);
      expect(await run({ now: expiry })).toEqual({ deleted: 1, skipped: 0, orphans: 0 });
      expect(existsSync(path.join(audioDir, A))).toBe(false);
      expect(calls.map((c) => c.e)).toEqual([{ type: "audio.deleted", scope: { kind: "session" }, reason: "expired", by: "system", segments: 2 }]);
    });

    it("an unreadable marker falls back to the index; non-segment and non-numeric lines are ignored", async () => {
      const last = T0 + 10 * DAY;
      mkSession(A, {
        ended: "{not json", wavs: { r: 1 }, mtime: T0,
        index: { r: [seg(T0, last), { v: 1, kind: "transcript", endMs: last + 50 * DAY }, { kind: "segment", endMs: "9999999999999" }, "null", "[]"] },
      });
      mkSession(B, { ended: JSON.stringify({ v: 1, endedAtMs: "soon" }), index: { r: [seg(T0, last)] }, mtime: T0 });
      expect(await run({ now: last + 31 * DAY - 1 })).toEqual({ deleted: 0, skipped: 0, orphans: 0 });
      expect(await run({ now: last + 31 * DAY })).toEqual({ deleted: 2, skipped: 0, orphans: 0 });
    });

    it("no marker and no segment line: the newest file time (boundary inclusive)", async () => {
      const newest = T0 + 5 * DAY;
      mkSession(A, { index: { r: [{ v: 1, kind: "other" }] }, wavs: { r: 0 }, mtime: T0 });
      writeFileSync(path.join(audioDir, A, "r", "x.bin"), "x");
      writeFileSync(path.join(audioDir, A, "r", "y.bin"), "y"); // not WAVs: the clock reads any file, the orphan pass only WAVs
      utimesSync(path.join(audioDir, A, "r", "x.bin"), T0 / 1000, T0 / 1000);
      utimesSync(path.join(audioDir, A, "r", "y.bin"), newest / 1000, newest / 1000);
      expect(await run({ now: newest + 30 * DAY - 1 })).toEqual({ deleted: 0, skipped: 0, orphans: 0 });
      expect(await run({ now: newest + 30 * DAY })).toEqual({ deleted: 1, skipped: 0, orphans: 0 });
      expect(calls[0]?.e).toMatchObject({ segments: 0 });
    });

    it("a time later than now counts as now: nothing is deleted", async () => {
      const now = T0 + 100 * DAY;
      mkSession(A, { ended: now + 400 * DAY, wavs: { r: 1 } });
      mkSession(B, { index: { r: [seg(now, now + 900 * DAY)] }, wavs: { r: 1 } });
      mkSession(C, { wavs: { r: 1 }, mtime: now + 400 * DAY });
      expect(await run({ now, retentionDays: 1 })).toEqual({ deleted: 0, skipped: 0, orphans: 2 }); // A and C hold one unindexed WAV each
      expect(calls).toEqual([]);
      for (const s of [A, B, C]) expect(existsSync(path.join(audioDir, s))).toBe(true);
    });
  });

  describe("the store lock", () => {
    it("a refused lock skips the folder: nothing deleted, nothing audited", async () => {
      mkSession(A, { ended: T0, wavs: { r: 2 } });
      expect(await run({ now: T0 + 60 * DAY, acquireLock: () => null })).toEqual({ deleted: 0, skipped: 1, orphans: 0 });
      expect(readdirSync(path.join(audioDir, A, "r")).sort()).toEqual(["seg0.wav", "seg1.wav"]);
      expect(calls).toEqual([]);
    });

    it("a live worker's lock (held in this process, or by another live process on this host) skips it", async () => {
      mkSession(A, { ended: T0, wavs: { r: 1 } });
      mkSession(B, { ended: T0, wavs: { r: 1 } });
      const held = SessionLock.acquire(audioDir, A, { suffix: "store" });
      // an orphan worker that outlived a control restart: its pid is alive and its heartbeat fresh
      writeFileSync(path.join(audioDir, `${B}.store.lock`), JSON.stringify({ pid: process.ppid, host: os.hostname(), startedAt: new Date().toISOString() }), { mode: 0o600 });
      try {
        expect(makeAcquireLock()(audioDir, A)).toBeNull();
        expect(await run({ now: T0 + 60 * DAY })).toEqual({ deleted: 0, skipped: 2, orphans: 0 });
        expect(existsSync(path.join(audioDir, A, "r", "seg0.wav"))).toBe(true);
        expect(existsSync(path.join(audioDir, B, "r", "seg0.wav"))).toBe(true);
        expect(held.verify()).toBe(true);
        expect(existsSync(path.join(audioDir, `${B}.store.lock`))).toBe(true);
        expect(calls).toEqual([]);
      } finally { held.release(); }
    });

    it("a worker that takes the lock right after the sweep's release keeps its lock file (never unlinked by path)", async () => {
      mkSession(A, { ended: T0, wavs: { r: 1 } });
      const real = makeAcquireLock();
      let second: SessionLock | null = null;
      const acquireLock = (dir: string, sid: string) => {
        const l = real(dir, sid);
        if (!l) return null;
        return { release: () => { l.release(); second = SessionLock.acquire(dir, sid, { suffix: "store" }); } };
      };
      expect(await run({ now: T0 + 60 * DAY, acquireLock })).toEqual({ deleted: 1, skipped: 0, orphans: 0 });
      expect(second).not.toBeNull();
      try {
        expect(existsSync(path.join(audioDir, `${A}.store.lock`))).toBe(true);
        expect(second!.verify()).toBe(true);
      } finally { second!.release(); }
    });

    it("a lock that throws for another reason is skipped too", async () => {
      mkSession(A, { ended: T0, wavs: { r: 1 } });
      symlinkSync(path.join(root, "nowhere"), path.join(audioDir, `${A}.store.lock`)); // SessionLockError "not_a_file"
      expect(makeAcquireLock()(audioDir, A)).toBeNull();
      expect(await run({ now: T0 + 60 * DAY })).toEqual({ deleted: 0, skipped: 1, orphans: 0 });
      expect(existsSync(path.join(audioDir, A, "r", "seg0.wav"))).toBe(true);
    });
  });

  describe("rename, audit, remove", () => {
    it("audits only after the rename, while the renamed folder still exists, and keeps the audit file", async () => {
      mkSession(A, { ended: T0, wavs: { r: 2 } });
      writeFileSync(path.join(audioDir, `${A}.audio-audit.jsonl`), "{}\n", { mode: 0o600 });
      let seenAside = false;
      const audit = { append: async (sid: string, e: AuditEvent) => {
        await fakeAudit.append(sid, e);
        const aside = deleting(A);
        expect(aside).toHaveLength(1);
        expect(aside[0]).toMatch(new RegExp(`^${A}\\.deleting-[0-9a-f]{8,}$`));
        expect(existsSync(path.join(audioDir, aside[0]!, "r", "seg0.wav"))).toBe(true); // removal comes after the audit
        seenAside = true;
      } };
      expect(await run({ now: T0 + 60 * DAY, audit })).toEqual({ deleted: 1, skipped: 0, orphans: 0 });
      expect(seenAside).toBe(true);
      expect(calls[0]?.onDisk).not.toContain(A);
      expect(calls[0]?.onDisk).toContain(`${A}.store.lock`); // the lock is held across the rename and the audit
      expect(readdirSync(audioDir).sort()).toEqual([`${A}.audio-audit.jsonl`]);
    });

    it("exactly one audit line across a removal that fails: the next run finishes it silently", async () => {
      mkSession(A, { ended: T0, wavs: { r: 2 } });
      chmodSync(path.join(audioDir, A, "r"), 0o500); // its files cannot be unlinked
      const audit = new AuditLog({ audioDir, now: () => 7, log: (m) => logs.push(m) });
      expect(await run({ now: T0 + 60 * DAY, audit })).toEqual({ deleted: 1, skipped: 0, orphans: 0 });
      expect(logs).toEqual([SWEEP_REMOVE_FAILED]);
      const aside = deleting(A);
      expect(aside).toHaveLength(1);
      expect(existsSync(path.join(audioDir, A))).toBe(false);
      expect(storeLocks()).toEqual([]); // released although the removal failed
      chmodSync(path.join(audioDir, aside[0]!, "r"), 0o700);
      logs = [];
      expect(await run({ now: T0 + 61 * DAY, audit })).toEqual({ deleted: 0, skipped: 0, orphans: 0 });
      expect(deleting(A)).toEqual([]);
      expect(logs).toEqual([]);
      const lines = readFileSync(path.join(audioDir, `${A}.audio-audit.jsonl`), "utf8").split("\n").filter(Boolean);
      expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual([{ v: 1, ts: 7, type: "audio.deleted", scope: { kind: "session" }, reason: "expired", by: "system", segments: 2 }]);
    });

    it("a leftover .deleting-* folder (a crash after the audit) is removed without an audit line or a lock", async () => {
      const left = path.join(audioDir, `${A}.deleting-0a1b2c3d`);
      mkdirSync(path.join(left, "r"), { recursive: true, mode: 0o700 });
      writeFileSync(path.join(left, "r", "seg0.wav"), "RIFF");
      expect(await run({ now: T0, acquireLock: () => { throw new Error("no lock is needed"); } })).toEqual({ deleted: 0, skipped: 0, orphans: 0 });
      expect(existsSync(left)).toBe(false);
      expect(calls).toEqual([]);
    });

    it("a symlink inside a deleted folder is unlinked, never followed", async () => {
      const outside = path.join(root, "outside");
      mkdirSync(outside);
      writeFileSync(path.join(outside, "keep.wav"), "precious");
      mkSession(A, { ended: T0, wavs: { r: 1 } });
      symlinkSync(outside, path.join(audioDir, A, "r", "dirlink"));
      symlinkSync(path.join(outside, "keep.wav"), path.join(audioDir, A, "filelink.wav"));
      expect(await run({ now: T0 + 60 * DAY })).toEqual({ deleted: 1, skipped: 0, orphans: 0 });
      expect(calls[0]?.e).toMatchObject({ segments: 1 }); // a link is not a segment
      expect(readFileSync(path.join(outside, "keep.wav"), "utf8")).toBe("precious");
      expect(readdirSync(audioDir)).toEqual([]);
    });
  });

  it("leaves non-hex names, plain files, symlinks and other leftovers strictly alone", async () => {
    const old = { ended: T0, wavs: { r: 1 } };
    const outside = path.join(root, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "ended.json"), JSON.stringify({ v: 1, endedAtMs: T0 }));
    writeFileSync(path.join(outside, "x.wav"), "x");
    const inside = mkSession("not-a-session", old);
    mkSession(A.toUpperCase(), old); // upper-case hex
    mkSession(A.slice(1), old); // 31 hex
    mkSession(`${A}x`, old);
    writeFileSync(path.join(audioDir, B), "a plain file named like an identity");
    symlinkSync(inside, path.join(audioDir, C)); // a link to an expired folder inside
    symlinkSync(outside, path.join(audioDir, id(0xd))); // a link to a folder outside
    symlinkSync(outside, path.join(audioDir, `${id(0xe)}.deleting-0a1b2c3d`));
    mkSession(`${id(0xf)}.deleting-UPPER`, old);
    const before = readdirSync(audioDir).sort();
    expect(await run({ now: T0 + 60 * DAY })).toEqual({ deleted: 0, skipped: 0, orphans: 0 });
    expect(readdirSync(audioDir).sort()).toEqual(before);
    expect(readdirSync(outside).sort()).toEqual(["ended.json", "x.wav"]);
    expect(readdirSync(path.join(inside, "r"))).toEqual(["seg0.wav"]);
    expect(calls).toEqual([]);
  });

  it("does nothing when the audio directory is missing or is a link", async () => {
    rmSync(audioDir, { recursive: true });
    expect(await run({ now: T0 })).toEqual({ deleted: 0, skipped: 0, orphans: 0 });
    const real = path.join(root, "real");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, audioDir);
    mkdirSync(path.join(real, A));
    writeFileSync(path.join(real, A, "ended.json"), JSON.stringify({ v: 1, endedAtMs: T0 }));
    expect(await run({ now: T0 + 60 * DAY })).toEqual({ deleted: 0, skipped: 0, orphans: 0 });
    expect(existsSync(path.join(real, A, "ended.json"))).toBe(true);
    expect(calls).toEqual([]);
  });

  it("refuses a nonsensical retention or clock instead of deleting", async () => {
    mkSession(A, { ended: T0, wavs: { r: 1 } });
    for (const retentionDays of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await run({ now: T0 + 60 * DAY, retentionDays })).toEqual({ deleted: 0, skipped: 0, orphans: 0 });
    }
    expect(await run({ now: Number.NaN })).toEqual({ deleted: 0, skipped: 0, orphans: 0 });
    expect(existsSync(path.join(audioDir, A, "r", "seg0.wav"))).toBe(true);
  });

  it("runs with VOICE_ENABLED=0 and never reads the flag", async () => {
    vi.stubEnv("VOICE_ENABLED", "0");
    mkSession(A, { ended: T0, wavs: { r: 1 } });
    expect(await run({ now: T0 + 60 * DAY })).toEqual({ deleted: 1, skipped: 0, orphans: 0 });
    const src = readFileSync(new URL("../../voice/sweep.ts", import.meta.url), "utf8");
    expect(src).not.toContain("process.env"); // it reads no environment flag at all
  });

  it("never logs a path or an identity", async () => {
    mkSession(A, { ended: T0, wavs: { r: 1 } });
    chmodSync(path.join(audioDir, A, "r"), 0o500);
    await run({ now: T0 + 60 * DAY });
    const aside = deleting(A);
    chmodSync(path.join(audioDir, aside[0]!, "r"), 0o700);
    expect(logs.length).toBeGreaterThan(0);
    for (const m of logs) { expect(m).not.toContain(A); expect(m).not.toContain(root); expect(m).not.toContain("/"); }
  });
});

describe("orphan WAV cleanup in a kept folder (US-0073, A2a Task 9b)", () => {
  const KEPT = T0 + DAY; // one day after the marker: kept at 30 days
  const keptSession = (index: Session["index"], wavs: Session["wavs"]): string => mkSession(A, { ended: T0, index, wavs });
  const wavsIn = (role: string): string[] => readdirSync(path.join(audioDir, A, role)).filter((n) => n.endsWith(".wav")).sort();

  it("removes a WAV with no index line, keeps an indexed one, counts it", async () => {
    keptSession({ r: [{ v: 1, kind: "segment", seq: 1, segment: "seg0", startMs: 1, endMs: 2 }] }, { r: 2 }); // seg0 indexed, seg1 not
    expect(await run({ now: KEPT })).toEqual({ deleted: 0, skipped: 0, orphans: 1 });
    expect(wavsIn("r")).toEqual(["seg0.wav"]);
    expect(readFileSync(path.join(audioDir, A, "r", "index.jsonl"), "utf8")).toContain("seg0"); // the index is never touched
    expect(storeLocks()).toEqual([]);
    expect(logs).toEqual([]);
  });

  it("a missing index.jsonl makes every WAV in that role an orphan", async () => {
    keptSession({}, { r: 3 });
    expect(await run({ now: KEPT })).toEqual({ deleted: 0, skipped: 0, orphans: 3 });
    expect(wavsIn("r")).toEqual([]);
  });

  it("ignores garbled and non-segment index lines (they never keep a WAV, never break the pass)", async () => {
    keptSession({ r: ["{torn", "not json", JSON.stringify({ v: 1, kind: "segment", segment: "seg0" }), JSON.stringify({ v: 1, kind: "deleted", segment: "seg1" }), "[1,2]", "null", JSON.stringify({ v: 1, kind: "segment", segment: 5 }), '{"v":1,"kind":"segm'] }, { r: 3 });
    expect(await run({ now: KEPT })).toEqual({ deleted: 0, skipped: 0, orphans: 2 });
    expect(wavsIn("r")).toEqual(["seg0.wav"]);
  });

  it("a segment indexed in ANOTHER role's index is still an orphan here", async () => {
    keptSession({ r1: [{ v: 1, kind: "segment", segment: "seg0" }], r2: [{ v: 1, kind: "segment", segment: "seg1" }] }, { r1: 1, r2: 2 }); // r2 holds seg0.wav and seg1.wav, but only r1's index names seg0
    expect(await run({ now: KEPT })).toEqual({ deleted: 0, skipped: 0, orphans: 1 });
    expect(wavsIn("r1")).toEqual(["seg0.wav"]);
    expect(wavsIn("r2")).toEqual(["seg1.wav"]);
  });

  it("only regular files named like a segment: a link, a folder and other names are left alone and never followed", async () => {
    const outside = path.join(root, "outside");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "keep.wav"), "precious");
    keptSession({ r: [] }, { r: 0 });
    const role = path.join(audioDir, A, "r");
    symlinkSync(path.join(outside, "keep.wav"), path.join(role, "evil.wav"));
    symlinkSync(outside, path.join(role, "dir.wav"));
    mkdirSync(path.join(role, "folder.wav"));
    writeFileSync(path.join(role, "UPPER.wav"), "x");
    writeFileSync(path.join(role, "note.txt"), "x");
    writeFileSync(path.join(role, `${"a".repeat(65)}.wav`), "x");
    writeFileSync(path.join(role, "real.wav"), "x");
    expect(await run({ now: KEPT })).toEqual({ deleted: 0, skipped: 0, orphans: 1 });
    expect(readdirSync(role).sort()).toEqual(["UPPER.wav", `${"a".repeat(65)}.wav`, "dir.wav", "evil.wav", "folder.wav", "index.jsonl", "note.txt"].sort());
    expect(readFileSync(path.join(outside, "keep.wav"), "utf8")).toBe("precious");
    expect(readdirSync(outside)).toEqual(["keep.wav"]);
  });

  it("an index that is a link or unreadable is not trusted: nothing is removed on a guess", async () => {
    mkSession(A, { ended: T0, wavs: { r: 1 } });
    const target = path.join(root, "idx.jsonl");
    writeFileSync(target, "");
    symlinkSync(target, path.join(audioDir, A, "r", "index.jsonl"));
    expect(await run({ now: KEPT })).toEqual({ deleted: 0, skipped: 0, orphans: 0 });
    expect(wavsIn("r")).toEqual(["seg0.wav"]);
  });

  it.skipIf(process.getuid?.() === 0)("an index that cannot be opened (chmod 000) removes NOTHING", async () => {
    keptSession({ r: [{ v: 1, kind: "segment", segment: "seg0" }] }, { r: 2 });
    const idx = path.join(audioDir, A, "r", "index.jsonl");
    chmodSync(idx, 0o000);
    try {
      expect(await run({ now: KEPT })).toEqual({ deleted: 0, skipped: 0, orphans: 0 });
      expect(wavsIn("r")).toEqual(["seg0.wav", "seg1.wav"]);
    } finally { chmodSync(idx, 0o600); }
  });

  it("an index over 64 MiB (sparse) removes NOTHING", async () => {
    keptSession({ r: [{ v: 1, kind: "segment", segment: "seg0" }] }, { r: 2 });
    truncateSync(path.join(audioDir, A, "r", "index.jsonl"), 64 * 1024 * 1024 + 1);
    expect(await run({ now: KEPT })).toEqual({ deleted: 0, skipped: 0, orphans: 0 });
    expect(wavsIn("r")).toEqual(["seg0.wav", "seg1.wav"]);
  });

  it("removal happens while the store lock is held; the lock path is never unlinked by the sweep", async () => {
    keptSession({}, { r: 1 });
    const seen: boolean[] = [];
    const real = makeAcquireLock();
    let held = false;
    const acquireLock = (dir: string, sid: string) => {
      const l = real(dir, sid);
      if (l === null) return null;
      held = true;
      return { release: () => { seen.push(existsSync(path.join(audioDir, A, "r", "seg0.wav"))); held = false; l.release(); } };
    };
    expect(await run({ now: KEPT, acquireLock })).toEqual({ deleted: 0, skipped: 0, orphans: 1 });
    expect(seen).toEqual([false]); // the WAV was already gone when the lock was released
    expect(held).toBe(false);
  });

  it("a held store lock (a live worker) prevents orphan removal", async () => {
    keptSession({}, { r: 2 });
    const lock = SessionLock.acquire(audioDir, A, { suffix: "store" });
    try {
      expect(await run({ now: KEPT })).toEqual({ deleted: 0, skipped: 1, orphans: 0 });
      expect(wavsIn("r")).toEqual(["seg0.wav", "seg1.wav"]);
    } finally { lock.release(); }
  });

  it("an expired folder is deleted whole, with no orphan count", async () => {
    keptSession({}, { r: 2 });
    expect(await run({ now: T0 + 60 * DAY })).toEqual({ deleted: 1, skipped: 0, orphans: 0 });
  });

  it("a failed removal logs the fixed sentence, leaves the file, and the next run completes it", async () => {
    keptSession({}, { r: 1 });
    const role = path.join(audioDir, A, "r");
    chmodSync(role, 0o500); // cannot unlink inside
    try {
      expect(await run({ now: KEPT })).toEqual({ deleted: 0, skipped: 0, orphans: 0 });
      expect(logs).toEqual([SWEEP_REMOVE_FAILED]);
      expect(wavsIn("r")).toEqual(["seg0.wav"]);
    } finally { chmodSync(role, 0o700); }
    logs.length = 0;
    expect(await run({ now: KEPT })).toEqual({ deleted: 0, skipped: 0, orphans: 1 });
    expect(wavsIn("r")).toEqual([]);
    expect(logs).toEqual([]);
  });
});

describe("an unsafe audio directory and swapped folders (US-0073, final review I1)", () => {
  const isRoot = process.getuid?.() === 0;
  let outside: string;
  beforeEach(() => {
    outside = path.join(root, "outside");
    mkdirSync(outside, { mode: 0o700 });
    writeFileSync(path.join(outside, "precious.txt"), "keep");
    writeFileSync(path.join(outside, "seg9.wav"), "keep");
  });
  afterEach(() => { sweepTestHooks.beforeOpenDir = undefined; sweepTestHooks.afterOpenDir = undefined; });
  const outsideIntact = () => {
    expect(readdirSync(outside).sort()).toEqual(["precious.txt", "seg9.wav"]);
    expect(readFileSync(path.join(outside, "precious.txt"), "utf8")).toBe("keep");
  };
  /** Moves the real folder at `p` away (out of the audio dir) and plants a link to `outside` under its name. */
  const swap = (p: string) => { renameSync(p, path.join(root, `moved-${path.basename(p)}`)); symlinkSync(outside, p); };

  it.skipIf(isRoot).each([0o770, 0o777, 0o720, 0o702])("a root with mode %o (group or other writable) is not swept at all", async (mode) => {
    mkSession(A, { ended: T0, wavs: { r: 2 } });
    const left = path.join(audioDir, `${B}.deleting-0a1b2c3d`);
    mkdirSync(left, { mode: 0o700 });
    writeFileSync(path.join(left, "x.wav"), "x");
    chmodSync(audioDir, mode);
    const before = readdirSync(audioDir).sort();
    expect(await run({ now: T0 + 60 * DAY })).toEqual({ deleted: 0, skipped: 0, orphans: 0 });
    expect(logs).toEqual([SWEEP_DIR_UNSAFE]);
    expect(readdirSync(audioDir).sort()).toEqual(before);
    expect(readdirSync(path.join(audioDir, A, "r")).sort()).toEqual(["seg0.wav", "seg1.wav"]);
    expect(existsSync(path.join(left, "x.wav"))).toBe(true);
    expect(calls).toEqual([]);
    chmodSync(audioDir, 0o700);
  });

  it.skipIf(isRoot)("a group-readable but not writable root (0750) is swept as before", async () => {
    mkSession(A, { ended: T0, wavs: { r: 1 } });
    chmodSync(audioDir, 0o750);
    expect(await run({ now: T0 + 60 * DAY })).toEqual({ deleted: 1, skipped: 0, orphans: 0 });
    expect(logs).toEqual([]);
  });

  it.each(["beforeOpenDir", "afterOpenDir"] as const)("a leftover folder swapped for a link (%s) is not followed", async (hook) => {
    const left = path.join(audioDir, `${A}.deleting-0a1b2c3d`);
    mkdirSync(left, { mode: 0o700 });
    writeFileSync(path.join(left, "x.wav"), "x");
    const seen: string[] = [];
    sweepTestHooks[hook] = (p) => { seen.push(p); if (p === left) swap(left); };
    await run({ now: T0 });
    expect(seen).toContain(left);
    outsideIntact();
    expect(logs).toEqual([SWEEP_REMOVE_FAILED]);
    expect(readFileSync(path.join(root, `moved-${path.basename(left)}`, "x.wav"), "utf8")).toBe("x");
  });

  it.each(["beforeOpenDir", "afterOpenDir"] as const)("a role folder swapped for a link while an expired session is removed (%s) is not followed", async (hook) => {
    mkSession(A, { ended: T0, wavs: { r: 1 } });
    let swapped = false;
    sweepTestHooks[hook] = (p) => { if (!swapped && p.includes(".deleting-") && path.basename(p) === "r") { swapped = true; swap(p); } };
    expect(await run({ now: T0 + 60 * DAY })).toEqual({ deleted: 1, skipped: 0, orphans: 0 });
    expect(swapped).toBe(true);
    outsideIntact();
    expect(logs).toEqual([SWEEP_REMOVE_FAILED]);
    expect(calls).toHaveLength(1);
  });

  it.each(["beforeOpenDir", "afterOpenDir"] as const)("a role folder swapped for a link during the orphan pass (%s) is not followed", async (hook) => {
    mkSession(A, { ended: T0, index: { r: [{ v: 1, kind: "segment", segment: "seg0" }] }, wavs: { r: 1 } });
    const role = path.join(audioDir, A, "r");
    let swapped = false;
    sweepTestHooks[hook] = (p) => { if (!swapped && p === role) { swapped = true; swap(p); } };
    expect(await run({ now: T0 + DAY })).toEqual({ deleted: 0, skipped: 0, orphans: 0 });
    expect(swapped).toBe(true);
    outsideIntact(); // seg9.wav outside is not indexed: following the link would have unlinked it as an orphan
  });
});

describe("segmentIdOf", () => {
  it.each(["../x.wav", "A.wav", "a.b.wav", ".wav", `${"a".repeat(65)}.wav`, "a/b.wav", "a.WAV", "a.wav.txt", "x", "a b.wav"])("%s is not a segment WAV name", (n) => {
    expect(segmentIdOf(n)).toBeNull();
  });
  it.each([["seg0.wav", "seg0"], ["a_b-1.wav", "a_b-1"], [`${"a".repeat(64)}.wav`, "a".repeat(64)]])("%s is a segment WAV name", (n, want) => {
    expect(segmentIdOf(n)).toBe(want);
  });
});

describe("startSweepSchedule (US-0073, A2a Task 9b)", () => {
  type Timer = { fn: () => void; ms: number; cancelled: boolean };
  let timers: Timer[];
  const setTimer = (fn: () => void, ms: number): (() => void) => { const t = { fn, ms, cancelled: false }; timers.push(t); return () => { t.cancelled = true; }; };
  const pending = (): Timer[] => timers.filter((t) => !t.cancelled);
  const fire = (): void => { const t = pending()[0]!; t.cancelled = true; t.fn(); };
  const flush = async (): Promise<void> => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
  beforeEach(() => { timers = []; });

  it("runs at start without being awaited, then every hour after each run completes", async () => {
    const run = vi.fn(async () => undefined);
    const s = startSweepSchedule({ run, setTimer });
    expect(run).toHaveBeenCalledTimes(1); // synchronously, at start
    expect(pending()).toHaveLength(0); // nothing scheduled until the run completes
    await flush();
    expect(pending().map((t) => t.ms)).toEqual([3_600_000]);
    fire(); await flush();
    expect(run).toHaveBeenCalledTimes(2);
    expect(pending().map((t) => t.ms)).toEqual([3_600_000]);
    s.stop();
  });

  it("honours intervalMs", async () => {
    startSweepSchedule({ run: async () => undefined, setTimer, intervalMs: 5_000 });
    await flush();
    expect(pending().map((t) => t.ms)).toEqual([5_000]);
  });

  it("never overlaps: a timer that fires while a run is pending is skipped, not queued", async () => {
    let finish!: () => void;
    const run = vi.fn(() => new Promise<void>((r) => { finish = r; }));
    startSweepSchedule({ run, setTimer });
    expect(pending()).toHaveLength(0); // the next one is scheduled only after completion
    // a stray tick (as if a timer fired during the run) must do nothing
    const stray = timers.length; // none yet
    expect(stray).toBe(0);
    finish(); await flush();
    expect(pending()).toHaveLength(1);
    fire(); // second run starts and stays pending
    expect(run).toHaveBeenCalledTimes(2);
    expect(pending()).toHaveLength(0);
    finish(); await flush();
    expect(run).toHaveBeenCalledTimes(2);
    expect(pending()).toHaveLength(1);
  });

  it("a tick function invoked during a pending run is skipped", async () => {
    let finish!: () => void;
    const run = vi.fn(() => new Promise<void>((r) => { finish = r; }));
    let captured: (() => void) | null = null;
    startSweepSchedule({ run, setTimer: (fn, ms) => { captured = fn; return setTimer(fn, ms); } });
    finish(); await flush();
    const tick = captured!;
    fire(); // run 2 pending
    tick(); tick(); // the old timer callback fires again while running
    expect(run).toHaveBeenCalledTimes(2);
    finish(); await flush();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("swallows rejections (and a synchronous throw) and keeps scheduling", async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new Error("secret /path/token"))
      .mockImplementationOnce(() => { throw new Error("sync"); })
      .mockResolvedValue(undefined);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      startSweepSchedule({ run, setTimer });
      await flush();
      expect(pending()).toHaveLength(1);
      fire(); await flush();
      expect(pending()).toHaveLength(1);
      fire(); await flush();
      expect(run).toHaveBeenCalledTimes(3);
      expect(pending()).toHaveLength(1);
      await new Promise((r) => setImmediate(r));
      expect(unhandled).not.toHaveBeenCalled();
    } finally { process.off("unhandledRejection", unhandled); }
  });

  it("stop() cancels the pending timer, is idempotent, and prevents any further run", async () => {
    const run = vi.fn(async () => undefined);
    const s = startSweepSchedule({ run, setTimer });
    await flush();
    const t = pending()[0]!;
    s.stop(); s.stop();
    expect(t.cancelled).toBe(true);
    t.fn(); await flush(); // even a callback that still fires does nothing
    expect(run).toHaveBeenCalledTimes(1);
    expect(pending()).toHaveLength(0);
  });

  it("a run that finishes after stop() schedules nothing", async () => {
    let finish!: () => void;
    const s = startSweepSchedule({ run: () => new Promise<void>((r) => { finish = r; }), setTimer });
    s.stop();
    finish(); await flush();
    expect(timers).toHaveLength(0);
  });

  it("stop() during a run resolves only after that run finishes, cancels the timer, and nothing is rescheduled", async () => {
    let finish!: () => void;
    const s = startSweepSchedule({ run: () => new Promise<void>((r) => { finish = r; }), setTimer });
    let stopped = false;
    const p = s.stop().then(() => { stopped = true; });
    await flush();
    expect(stopped).toBe(false); // the run is still going
    finish(); await p;
    expect(stopped).toBe(true);
    await flush();
    expect(timers).toHaveLength(0);
    await expect(s.stop()).resolves.toBeUndefined(); // idempotent, nothing in flight
  });

  it("stop() with nothing in flight resolves at once and cancels the pending timer", async () => {
    const s = startSweepSchedule({ run: async () => undefined, setTimer });
    await flush();
    await s.stop();
    expect(pending()).toHaveLength(0);
  });

  it("stopWithin proceeds after the bound when the run hangs, and at once when the run ends first", async () => {
    vi.useFakeTimers();
    try {
      const fakeSet = (fn: () => void, ms: number): (() => void) => { const h = setTimeout(fn, ms); return () => clearTimeout(h); };
      const hung = startSweepSchedule({ run: () => new Promise<void>(() => {}), setTimer: fakeSet });
      let done = false;
      void stopWithin(hung, fakeSet, 5_000).then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
      let finish!: () => void;
      const quick = startSweepSchedule({ run: () => new Promise<void>((r) => { finish = r; }), setTimer: fakeSet });
      let done2 = false;
      void stopWithin(quick, fakeSet, 5_000).then(() => { done2 = true; });
      finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(done2).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("works under real fake timers too (hourly)", async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn(async () => undefined);
      const s = startSweepSchedule({ run, setTimer: (fn, ms) => { const h = setTimeout(fn, ms); return () => clearTimeout(h); } });
      expect(run).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(3_600_000 - 1);
      expect(run).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(run).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(run).toHaveBeenCalledTimes(3);
      s.stop();
      await vi.advanceTimersByTimeAsync(10 * 3_600_000);
      expect(run).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });
});

describe("startAudioSweep (US-0073, A2a Task 9b)", () => {
  it("with VOICE_ENABLED=0 it still sweeps at start: orphan removed, indexed WAV kept, expired session deleted", async () => {
    vi.stubEnv("VOICE_ENABLED", "0");
    mkSession(A, { ended: T0, index: { r: [{ v: 1, kind: "segment", segment: "seg0" }] }, wavs: { r: 2 } });
    mkSession(B, { ended: T0 - 40 * DAY, wavs: { r: 1 } });
    const timers: Array<[() => void, number]> = [];
    let done!: () => void;
    const finished = new Promise<void>((r) => { done = r; });
    const s = startAudioSweep(
      { audioDir, audioMaxRetentionDays: 30 },
      { audit: fakeAudit, log: (m) => logs.push(m), now: () => T0 + DAY, setTimer: (fn, ms) => { timers.push([fn, ms]); done(); return () => {}; } },
    );
    await finished; // a timer is scheduled only after the run completed
    s.stop();
    expect(readdirSync(path.join(audioDir, A, "r")).sort()).toEqual(["index.jsonl", "seg0.wav"]);
    expect(existsSync(path.join(audioDir, B))).toBe(false);
    expect(timers.map((t) => t[1])).toEqual([3_600_000]);
    expect(calls.map((c) => c.id)).toEqual([B]);
  });

  it("passes the configured retention (days) through", async () => {
    mkSession(A, { ended: T0, wavs: { r: 1 } });
    let done!: () => void;
    const finished = new Promise<void>((r) => { done = r; });
    const s = startAudioSweep({ audioDir, audioMaxRetentionDays: 1 }, { audit: fakeAudit, log: () => {}, now: () => T0 + DAY, setTimer: () => { done(); return () => {}; } });
    await finished; s.stop();
    expect(existsSync(path.join(audioDir, A))).toBe(false);
  });
});
