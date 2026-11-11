import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionLock } from "@acr/runtime/files";
import { AuditLog, type AuditEvent } from "../../voice/audit-log.js";
import { SWEEP_REMOVE_FAILED, makeAcquireLock, sweepAudio } from "../../voice/sweep.js";

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
    expect(await run({ now, retentionDays: days })).toEqual({ deleted: 2, skipped: 0 });
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
      expect(await run({ now })).toEqual({ deleted: 1, skipped: 0 });
      expect(existsSync(path.join(audioDir, A))).toBe(false);
      expect(existsSync(path.join(audioDir, B))).toBe(true);
    });

    it("no marker: the largest index endMs over all roles plus 24 h (boundary inclusive)", async () => {
      const last = T0 + 10 * DAY;
      const index = { r1: [seg(T0, T0 + 1000), seg(last - 5000, last)], r2: [seg(T0, last - 2000), "{torn"] };
      mkSession(A, { index, wavs: { r1: 2, r2: 1 }, mtime: T0 });
      const expiry = last + DAY + 30 * DAY;
      expect(await run({ now: expiry - 1 })).toEqual({ deleted: 0, skipped: 0 });
      expect(existsSync(path.join(audioDir, A))).toBe(true);
      expect(await run({ now: expiry })).toEqual({ deleted: 1, skipped: 0 });
      expect(existsSync(path.join(audioDir, A))).toBe(false);
      expect(calls.map((c) => c.e)).toEqual([{ type: "audio.deleted", scope: { kind: "session" }, reason: "expired", by: "system", segments: 3 }]);
    });

    it("an unreadable marker falls back to the index; non-segment and non-numeric lines are ignored", async () => {
      const last = T0 + 10 * DAY;
      mkSession(A, {
        ended: "{not json", wavs: { r: 1 }, mtime: T0,
        index: { r: [seg(T0, last), { v: 1, kind: "transcript", endMs: last + 50 * DAY }, { kind: "segment", endMs: "9999999999999" }, "null", "[]"] },
      });
      mkSession(B, { ended: JSON.stringify({ v: 1, endedAtMs: "soon" }), index: { r: [seg(T0, last)] }, mtime: T0 });
      expect(await run({ now: last + 31 * DAY - 1 })).toEqual({ deleted: 0, skipped: 0 });
      expect(await run({ now: last + 31 * DAY })).toEqual({ deleted: 2, skipped: 0 });
    });

    it("no marker and no segment line: the newest file time (boundary inclusive)", async () => {
      const newest = T0 + 5 * DAY;
      mkSession(A, { index: { r: [{ v: 1, kind: "other" }] }, wavs: { r: 2 }, mtime: T0 });
      utimesSync(path.join(audioDir, A, "r", "seg1.wav"), newest / 1000, newest / 1000);
      expect(await run({ now: newest + 30 * DAY - 1 })).toEqual({ deleted: 0, skipped: 0 });
      expect(await run({ now: newest + 30 * DAY })).toEqual({ deleted: 1, skipped: 0 });
      expect(calls[0]?.e).toMatchObject({ segments: 2 });
    });

    it("a time later than now counts as now: nothing is deleted", async () => {
      const now = T0 + 100 * DAY;
      mkSession(A, { ended: now + 400 * DAY, wavs: { r: 1 } });
      mkSession(B, { index: { r: [seg(now, now + 900 * DAY)] }, wavs: { r: 1 } });
      mkSession(C, { wavs: { r: 1 }, mtime: now + 400 * DAY });
      expect(await run({ now, retentionDays: 1 })).toEqual({ deleted: 0, skipped: 0 });
      expect(calls).toEqual([]);
      for (const s of [A, B, C]) expect(existsSync(path.join(audioDir, s))).toBe(true);
    });
  });

  describe("the store lock", () => {
    it("a refused lock skips the folder: nothing deleted, nothing audited", async () => {
      mkSession(A, { ended: T0, wavs: { r: 2 } });
      expect(await run({ now: T0 + 60 * DAY, acquireLock: () => null })).toEqual({ deleted: 0, skipped: 1 });
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
        expect(await run({ now: T0 + 60 * DAY })).toEqual({ deleted: 0, skipped: 2 });
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
      expect(await run({ now: T0 + 60 * DAY, acquireLock })).toEqual({ deleted: 1, skipped: 0 });
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
      expect(await run({ now: T0 + 60 * DAY })).toEqual({ deleted: 0, skipped: 1 });
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
      expect(await run({ now: T0 + 60 * DAY, audit })).toEqual({ deleted: 1, skipped: 0 });
      expect(seenAside).toBe(true);
      expect(calls[0]?.onDisk).not.toContain(A);
      expect(calls[0]?.onDisk).toContain(`${A}.store.lock`); // the lock is held across the rename and the audit
      expect(readdirSync(audioDir).sort()).toEqual([`${A}.audio-audit.jsonl`]);
    });

    it("exactly one audit line across a removal that fails: the next run finishes it silently", async () => {
      mkSession(A, { ended: T0, wavs: { r: 2 } });
      chmodSync(path.join(audioDir, A, "r"), 0o500); // its files cannot be unlinked
      const audit = new AuditLog({ audioDir, now: () => 7, log: (m) => logs.push(m) });
      expect(await run({ now: T0 + 60 * DAY, audit })).toEqual({ deleted: 1, skipped: 0 });
      expect(logs).toEqual([SWEEP_REMOVE_FAILED]);
      const aside = deleting(A);
      expect(aside).toHaveLength(1);
      expect(existsSync(path.join(audioDir, A))).toBe(false);
      expect(storeLocks()).toEqual([]); // released although the removal failed
      chmodSync(path.join(audioDir, aside[0]!, "r"), 0o700);
      logs = [];
      expect(await run({ now: T0 + 61 * DAY, audit })).toEqual({ deleted: 0, skipped: 0 });
      expect(deleting(A)).toEqual([]);
      expect(logs).toEqual([]);
      const lines = readFileSync(path.join(audioDir, `${A}.audio-audit.jsonl`), "utf8").split("\n").filter(Boolean);
      expect(lines.map((l) => JSON.parse(l) as unknown)).toEqual([{ v: 1, ts: 7, type: "audio.deleted", scope: { kind: "session" }, reason: "expired", by: "system", segments: 2 }]);
    });

    it("a leftover .deleting-* folder (a crash after the audit) is removed without an audit line or a lock", async () => {
      const left = path.join(audioDir, `${A}.deleting-0a1b2c3d`);
      mkdirSync(path.join(left, "r"), { recursive: true, mode: 0o700 });
      writeFileSync(path.join(left, "r", "seg0.wav"), "RIFF");
      expect(await run({ now: T0, acquireLock: () => { throw new Error("no lock is needed"); } })).toEqual({ deleted: 0, skipped: 0 });
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
      expect(await run({ now: T0 + 60 * DAY })).toEqual({ deleted: 1, skipped: 0 });
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
    expect(await run({ now: T0 + 60 * DAY })).toEqual({ deleted: 0, skipped: 0 });
    expect(readdirSync(audioDir).sort()).toEqual(before);
    expect(readdirSync(outside).sort()).toEqual(["ended.json", "x.wav"]);
    expect(readdirSync(path.join(inside, "r"))).toEqual(["seg0.wav"]);
    expect(calls).toEqual([]);
  });

  it("does nothing when the audio directory is missing or is a link", async () => {
    rmSync(audioDir, { recursive: true });
    expect(await run({ now: T0 })).toEqual({ deleted: 0, skipped: 0 });
    const real = path.join(root, "real");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, audioDir);
    mkdirSync(path.join(real, A));
    writeFileSync(path.join(real, A, "ended.json"), JSON.stringify({ v: 1, endedAtMs: T0 }));
    expect(await run({ now: T0 + 60 * DAY })).toEqual({ deleted: 0, skipped: 0 });
    expect(existsSync(path.join(real, A, "ended.json"))).toBe(true);
    expect(calls).toEqual([]);
  });

  it("refuses a nonsensical retention or clock instead of deleting", async () => {
    mkSession(A, { ended: T0, wavs: { r: 1 } });
    for (const retentionDays of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(await run({ now: T0 + 60 * DAY, retentionDays })).toEqual({ deleted: 0, skipped: 0 });
    }
    expect(await run({ now: Number.NaN })).toEqual({ deleted: 0, skipped: 0 });
    expect(existsSync(path.join(audioDir, A, "r", "seg0.wav"))).toBe(true);
  });

  it("runs with VOICE_ENABLED=0 and never reads the flag", async () => {
    vi.stubEnv("VOICE_ENABLED", "0");
    mkSession(A, { ended: T0, wavs: { r: 1 } });
    expect(await run({ now: T0 + 60 * DAY })).toEqual({ deleted: 1, skipped: 0 });
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
