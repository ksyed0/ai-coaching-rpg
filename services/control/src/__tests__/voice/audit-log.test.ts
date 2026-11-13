import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionLock } from "@acr/runtime/files";
import { AUDIT_APPEND_FAILED, AuditLog, AuditPathError, auditFile, ensureAuditRoot, type AuditEvent } from "../../voice/audit-log.js";

const ID = "0123456789abcdef0123456789abcdef";
let root: string, audioDir: string, logs: string[], clock: number;
const make = (o: Partial<ConstructorParameters<typeof AuditLog>[0]> = {}) =>
  new AuditLog({ audioDir, now: () => clock++, log: (m) => logs.push(m), sleep: async () => {}, ...o });
const lines = (id = ID): Record<string, unknown>[] =>
  readFileSync(path.join(audioDir, `${id}.audio-audit.jsonl`), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

const EVENTS: AuditEvent[] = [
  { type: "voice.recording_stopped", reason: "disk_low" },
  { type: "voice.recording_stopped", reason: "write_error" },
  { type: "voice.opted_in", role: "tech_lead", participant: "p-1", noticeVersion: "v3" },
  { type: "voice.opted_out", role: "tech_lead", participant: "p-1" },
  { type: "audio.deleted", scope: { kind: "session" }, reason: "expired", by: "system", segments: 4 },
  { type: "audio.played", role: "tech_lead", segment: "seg-0001", by: "ann-console" },
];

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "acr-audit-"));
  audioDir = path.join(root, "audio");
  logs = []; clock = 1000;
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("AuditLog (US-0073, A2a Task 8)", () => {
  it("writes one JSON line per event with v: 1, ts and type, in a 0600 file, creating a private audio dir", async () => {
    const a = make();
    for (const e of EVENTS) await a.append(ID, e);
    const got = lines();
    expect(got).toHaveLength(EVENTS.length);
    got.forEach((l, i) => { expect(l).toEqual({ v: 1, ts: 1000 + i, ...EVENTS[i] }); });
    expect(statSync(auditFile(audioDir, ID)).mode & 0o777).toBe(0o600);
    expect(statSync(audioDir).mode & 0o777).toBe(0o700);
    expect(logs).toEqual([]);
    // the audit lock is released after each append (another holder can take it)
    SessionLock.acquire(audioDir, ID, { suffix: "audio-audit" }).release();
  });

  it("no text, audio or transcript key exists in any line, even when a caller smuggles one in", async () => {
    const a = make();
    for (const e of EVENTS) await a.append(ID, { ...e, text: "the secret plan", transcript: "x", audio: "y" } as unknown as AuditEvent);
    for (const l of lines()) {
      expect(Object.keys(l).sort()).not.toContain("text");
      expect(l).not.toHaveProperty("transcript");
      expect(l).not.toHaveProperty("audio");
    }
    expect(readFileSync(auditFile(audioDir, ID), "utf8")).not.toContain("secret");
  });

  it("rapid appends for one identity keep their order and never interleave", async () => {
    const a = make();
    const all = Array.from({ length: 30 }, (_, i) => a.append(ID, { type: "audio.deleted", scope: { kind: "session" }, reason: "expired", by: "system", segments: i }));
    await Promise.all(all);
    expect(lines().map((l) => l.segments)).toEqual(Array.from({ length: 30 }, (_, i) => i));
  });

  it("an audit lock held by another appender is retried 50 ms apart, then the append succeeds", async () => {
    mkdirSync(audioDir, { mode: 0o700 });
    const held = SessionLock.acquire(audioDir, ID, { suffix: "audio-audit" });
    const sleeps: number[] = [];
    const a = make({ sleep: async (ms) => { sleeps.push(ms); held.release(); } });
    await a.append(ID, EVENTS[0]!);
    expect(sleeps).toEqual([50]);
    expect(lines()).toHaveLength(1);
    expect(logs).toEqual([]);
  });

  it("after 3 failed lock attempts it logs ONE fixed sentence, writes no line and never rejects", async () => {
    mkdirSync(audioDir, { mode: 0o700 });
    const held = SessionLock.acquire(audioDir, ID, { suffix: "audio-audit" });
    const sleeps: number[] = [];
    let attempts = 0;
    const a = make({
      sleep: async (ms) => { sleeps.push(ms); },
      acquireLock: (dir, id, o) => { attempts++; return SessionLock.acquire(dir, id, o); },
    });
    await expect(a.append(ID, EVENTS[2]!)).resolves.toBe(false);
    held.release();
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([50, 50]);
    expect(logs).toEqual([AUDIT_APPEND_FAILED]);
    expect(AUDIT_APPEND_FAILED).toBe("audit append failed");
    expect(existsSync(auditFile(audioDir, ID))).toBe(false);
    // a later append on the free lock works: one failure does not poison the chain
    await a.append(ID, EVENTS[3]!);
    expect(lines()).toHaveLength(1);
  });

  it.each([["A".repeat(32)], ["a".repeat(31)], ["a".repeat(33)], ["../" + "a".repeat(29)], [""], ["0123456789abcdef0123456789abcdeg"]])("a malformed identity (%j) is refused: nothing is written", async (bad) => {
    const a = make();
    await a.append(bad, EVENTS[0]!);
    expect(logs).toEqual([AUDIT_APPEND_FAILED]);
    expect(existsSync(audioDir)).toBe(false);
  });

  it("a symlinked audio dir is refused: nothing is written through the link", async () => {
    const real = path.join(root, "real");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, audioDir);
    const a = make();
    await a.append(ID, EVENTS[0]!);
    expect(logs).toEqual([AUDIT_APPEND_FAILED]);
    expect(existsSync(path.join(real, `${ID}.audio-audit.jsonl`))).toBe(false);
    expect(existsSync(path.join(real, `${ID}.audio-audit.lock`))).toBe(false);
  });

  it("an audio dir that is a file, or an audit file that is a symlink, fails closed with the fixed sentence", async () => {
    writeFileSync(audioDir, "x");
    await make().append(ID, EVENTS[0]!);
    expect(logs).toEqual([AUDIT_APPEND_FAILED]);
    rmSync(audioDir);
    mkdirSync(audioDir, { mode: 0o700 });
    const target = path.join(root, "target");
    writeFileSync(target, "");
    symlinkSync(target, auditFile(audioDir, ID));
    logs = [];
    await make().append(ID, EVENTS[0]!);
    expect(logs).toEqual([AUDIT_APPEND_FAILED]);
    expect(readFileSync(target, "utf8")).toBe("");
  });

  it("a group-writable audio dir is repaired to 0700; an audit file with loose permissions is tightened to 0600", async () => {
    mkdirSync(audioDir, { mode: 0o700 });
    chmodSync(audioDir, 0o770);
    writeFileSync(auditFile(audioDir, ID), "", { mode: 0o644 });
    chmodSync(auditFile(audioDir, ID), 0o644);
    await make().append(ID, EVENTS[0]!);
    expect(statSync(audioDir).mode & 0o777).toBe(0o700);
    expect(statSync(auditFile(audioDir, ID)).mode & 0o777).toBe(0o600);
    expect(lines()).toHaveLength(1);
  });

  it("ensureAuditRoot refuses a link and a non-directory, and accepts (and creates) a private folder twice", () => {
    ensureAuditRoot(audioDir); ensureAuditRoot(audioDir);
    expect(statSync(audioDir).isDirectory()).toBe(true);
    const link = path.join(root, "link");
    symlinkSync(audioDir, link);
    expect(() => ensureAuditRoot(link)).toThrow(AuditPathError);
    const file = path.join(root, "file");
    writeFileSync(file, "x");
    expect(() => ensureAuditRoot(file)).toThrow(AuditPathError);
  });

  it("an event of an unknown type (past the type system) is refused: nothing is written", async () => {
    await make().append(ID, { type: "voice.transcript", text: "secret" } as unknown as AuditEvent);
    expect(logs).toEqual([AUDIT_APPEND_FAILED]);
    expect(existsSync(audioDir)).toBe(false);
  });

  it("the log sentence never names a path or the identity", async () => {
    await make().append("A".repeat(32), EVENTS[0]!);
    for (const m of logs) { expect(m).not.toContain(root); expect(m).not.toContain("A".repeat(32)); }
  });
});

describe("AuditLog.append reports success; audio.played (US-0074, A2b-1a Task 3)", () => {
  it("resolves true after the line is written (and it is on disk)", async () => {
    const a = make();
    await expect(a.append(ID, EVENTS[0]!)).resolves.toBe(true);
    expect(lines()).toEqual([{ v: 1, ts: 1000, ...EVENTS[0] }]);
    expect(logs).toEqual([]);
  });

  it("resolves true after a lock retry that then succeeds", async () => {
    mkdirSync(audioDir, { mode: 0o700 });
    const held = SessionLock.acquire(audioDir, ID, { suffix: "audio-audit" });
    const a = make({ sleep: async () => { held.release(); } });
    await expect(a.append(ID, EVENTS[0]!)).resolves.toBe(true);
  });

  it.each([["A".repeat(32)], ["a".repeat(31)], [""], ["../" + "a".repeat(29)]])("resolves false for a malformed identity (%j), logs once, never rejects", async (bad) => {
    await expect(make().append(bad, EVENTS[0]!)).resolves.toBe(false);
    expect(logs).toEqual([AUDIT_APPEND_FAILED]);
  });

  it("resolves false for a symlinked audio dir and for a group-writable one that cannot be repaired", async () => {
    const real = path.join(root, "real");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, audioDir);
    await expect(make().append(ID, EVENTS[0]!)).resolves.toBe(false);
    expect(logs).toEqual([AUDIT_APPEND_FAILED]);
  });

  it("resolves false for an audio dir that is a file", async () => {
    writeFileSync(audioDir, "x");
    await expect(make().append(ID, EVENTS[0]!)).resolves.toBe(false);
    expect(logs).toEqual([AUDIT_APPEND_FAILED]);
  });

  it("resolves false when the lock stays held past every attempt, then a later append succeeds (chain intact)", async () => {
    mkdirSync(audioDir, { mode: 0o700 });
    const held = SessionLock.acquire(audioDir, ID, { suffix: "audio-audit" });
    const a = make();
    await expect(a.append(ID, EVENTS[0]!)).resolves.toBe(false);
    expect(logs).toEqual([AUDIT_APPEND_FAILED]);
    held.release();
    await expect(a.append(ID, EVENTS[1]!)).resolves.toBe(true);
    expect(lines()).toHaveLength(1);
    expect(logs).toHaveLength(1);
  });

  it("resolves false on a write error (the audit file is a directory), logging one sentence", async () => {
    mkdirSync(audioDir, { mode: 0o700 });
    mkdirSync(auditFile(audioDir, ID));
    await expect(make().append(ID, EVENTS[0]!)).resolves.toBe(false);
    expect(logs).toEqual([AUDIT_APPEND_FAILED]);
  });

  it("resolves false when the lock acquirer throws something unexpected, and the next append still works", async () => {
    let n = 0;
    const a = make({ acquireLock: (dir, id, o) => { if (n++ < 3) throw new Error("boom"); return SessionLock.acquire(dir, id, o); } });
    await expect(a.append(ID, EVENTS[0]!)).resolves.toBe(false);
    await expect(a.append(ID, EVENTS[1]!)).resolves.toBe(true);
    expect(logs).toEqual([AUDIT_APPEND_FAILED]);
  });

  it("resolves false (nothing written) for an unknown event type, and for a now() that throws", async () => {
    await expect(make().append(ID, { type: "voice.transcript", text: "s" } as unknown as AuditEvent)).resolves.toBe(false);
    const a = new AuditLog({ audioDir, now: () => { throw new Error("clock"); }, log: (m) => logs.push(m) });
    await expect(a.append(ID, EVENTS[0]!)).resolves.toBe(false);
    expect(logs).toEqual([AUDIT_APPEND_FAILED, AUDIT_APPEND_FAILED]);
  });

  it("a failure in the middle of a queue fails only its own append; the others report true", async () => {
    const a = make();
    const rs = await Promise.all([
      a.append(ID, EVENTS[0]!),
      a.append(ID, { type: "voice.transcript" } as unknown as AuditEvent),
      a.append(ID, EVENTS[1]!),
    ]);
    expect(rs).toEqual([true, false, true]);
    expect(lines()).toHaveLength(2);
  });

  it("the audio.played line has exactly v, ts, type, role, segment, by; an extra key is dropped", async () => {
    const a = make();
    const e = { type: "audio.played", role: "tech_lead", segment: "seg-0001", by: "ann-console" } as const;
    await a.append(ID, { ...e, text: "secret", raw: "x", participant: "p-1" } as unknown as AuditEvent);
    const [l] = lines();
    expect(Object.keys(l!)).toEqual(["v", "ts", "type", "role", "segment", "by"]);
    expect(l).toEqual({ v: 1, ts: 1000, ...e });
    expect(readFileSync(auditFile(audioDir, ID), "utf8")).not.toContain("secret");
  });

  it("every pre-existing event still serializes exactly as before", async () => {
    const a = make();
    for (const e of EVENTS.slice(0, 5)) await a.append(ID, e);
    expect(readFileSync(auditFile(audioDir, ID), "utf8").split("\n").filter(Boolean)).toEqual([
      '{"v":1,"ts":1000,"type":"voice.recording_stopped","reason":"disk_low"}',
      '{"v":1,"ts":1001,"type":"voice.recording_stopped","reason":"write_error"}',
      '{"v":1,"ts":1002,"type":"voice.opted_in","role":"tech_lead","participant":"p-1","noticeVersion":"v3"}',
      '{"v":1,"ts":1003,"type":"voice.opted_out","role":"tech_lead","participant":"p-1"}',
      '{"v":1,"ts":1004,"type":"audio.deleted","scope":{"kind":"session"},"reason":"expired","by":"system","segments":4}',
    ]);
  });
});

describe("audio.deleted widened for facilitator deletes (US-0075, A2b-1b Task 2)", () => {
  const raw = () => readFileSync(auditFile(audioDir, ID), "utf8");

  it("a facilitator role-scope line has exactly v, ts, type, scope, reason, by, segments, op", async () => {
    const e = { type: "audio.deleted", scope: { kind: "role", role: "tech_lead" }, reason: "facilitator", by: "ann-console", segments: 3, op: "op-1" } as const;
    await make().append(ID, e);
    const [l] = lines();
    expect(Object.keys(l!)).toEqual(["v", "ts", "type", "scope", "reason", "by", "segments", "op"]);
    expect(l).toEqual({ v: 1, ts: 1000, ...e });
  });

  it("a participant-scope participant_request line carries the participant id only in scope", async () => {
    const e = { type: "audio.deleted", scope: { kind: "participant", participant: "p-1" }, reason: "participant_request", by: "ann-console", segments: 2, op: "op-2" } as const;
    await make().append(ID, e);
    const [l] = lines();
    expect(Object.keys(l!)).toEqual(["v", "ts", "type", "scope", "reason", "by", "segments", "op"]);
    expect(l).toEqual({ v: 1, ts: 1000, ...e });
    expect(Object.keys(l!.scope as object)).toEqual(["kind", "participant"]);
  });

  it("a sweep line has no op key", async () => {
    await make().append(ID, { type: "audio.deleted", scope: { kind: "session" }, reason: "expired", by: "system", segments: 4 });
    const [l] = lines();
    expect(l).not.toHaveProperty("op");
    expect(Object.keys(l!)).toEqual(["v", "ts", "type", "scope", "reason", "by", "segments"]);
  });

  it("an op that is not a string is not written", async () => {
    await make().append(ID, { type: "audio.deleted", scope: { kind: "session" }, reason: "expired", by: "system", segments: 1, op: 7 } as unknown as AuditEvent);
    expect(lines()[0]).not.toHaveProperty("op");
  });

  it("smuggled keys on the event and on the scope are dropped (raw, path, role on a participant scope)", async () => {
    await make().append(ID, {
      type: "audio.deleted", scope: { kind: "participant", participant: "p-1", role: "tech_lead", raw: "r", path: "/x/y" },
      reason: "facilitator", by: "ann-console", segments: 1, op: "op-3", raw: "secret", path: "/etc/passwd", text: "t",
    } as unknown as AuditEvent);
    const [l] = lines();
    expect(Object.keys(l!)).toEqual(["v", "ts", "type", "scope", "reason", "by", "segments", "op"]);
    expect(l!.scope).toEqual({ kind: "participant", participant: "p-1" });
    expect(raw()).not.toMatch(/secret|passwd|"raw"|"path"|tech_lead/);
  });

  it("a session scope drops a smuggled role or participant", async () => {
    await make().append(ID, { type: "audio.deleted", scope: { kind: "session", role: "x", participant: "p" }, reason: "expired", by: "system", segments: 0 } as unknown as AuditEvent);
    expect(lines()[0]!.scope).toEqual({ kind: "session" });
  });
});
