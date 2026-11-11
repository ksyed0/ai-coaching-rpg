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
    await expect(a.append(ID, EVENTS[2]!)).resolves.toBeUndefined();
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
