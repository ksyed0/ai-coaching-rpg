import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IntentLog, MAX_INTENT_FILE_BYTES, MAX_INTENTS_RETURNED, intentFileName, type IntentEntry } from "../../bots/intent-log.js";
import { dirMode, readOnce } from "../read-once.js";

let root: string;
let dir: string;
const entry = (n = 0, extra: Partial<IntentEntry> = {}): IntentEntry => ({ ts: 1_000 + n, sceneId: "s1", trigger: "reply", outcome: "spoken", ...extra });

beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "acr-intent-")); dir = path.join(root, "intents"); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("intentFileName", () => {
  it("builds <sessionId>.<roleId>.jsonl", () => { expect(intentFileName("abc-1", "tech_lead")).toBe("abc-1.tech_lead.jsonl"); });
  it("throws for a bad role or session id", () => {
    for (const r of ["../x", "a/b", "Tech_Lead", "", "facilitator", "a.b"]) expect(() => intentFileName("s1", r), r).toThrow("not an intent file");
    for (const s of ["", "../s", "a/b", "a.b", "x".repeat(65)]) expect(() => intentFileName(s, "tech_lead"), s).toThrow("not an intent file");
  });
});

describe("IntentLog", () => {
  it("append then read returns the entry", () => {
    const log = new IntentLog(dir);
    log.append("s1", "tech_lead", entry(1, { hint: "ask about the rollback" }));
    expect(log.read("s1", "tech_lead")).toEqual([entry(1, { hint: "ask about the rollback" })]);
  });
  it("the file is mode 0600 in a 0700 directory", () => {
    const log = new IntentLog(dir);
    log.append("s1", "tech_lead", entry());
    expect(dirMode(dir)).toBe(0o700);
    expect(readOnce(path.join(dir, "s1.tech_lead.jsonl")).mode).toBe(0o600);
  });
  it("a bad role id or session id throws before any path is built (no file appears, no directory made)", () => {
    const lines: string[] = [];
    const log = new IntentLog(dir, (m) => lines.push(m));
    for (const r of ["../x", "a/b", "Tech_Lead", ""]) { log.append("s1", r, entry()); expect(log.read("s1", r)).toEqual([]); log.remove("s1", r); }
    log.append("../s", "tech_lead", entry());
    log.append("", "tech_lead", entry());
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
    expect(readdirSync(root)).not.toContain("x");
    expect(existsSync(path.join(root, "x.jsonl"))).toBe(false);
  });
  it("a symlink in the file's place is not followed", () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = path.join(root, "victim.txt");
    writeFileSync(target, "keep\n");
    symlinkSync(target, path.join(dir, "s1.tech_lead.jsonl"));
    const log = new IntentLog(dir);
    log.append("s1", "tech_lead", entry());
    expect(readOnce(target).text).toBe("keep\n");
    expect(log.read("s1", "tech_lead")).toEqual([]);
  });
  it("appends stop at 256 KiB", () => {
    const log = new IntentLog(dir);
    const big = entry(0, { hint: "h".repeat(400) });
    for (let i = 0; i < 1_000; i++) log.append("s1", "tech_lead", big);
    const size = statSync(path.join(dir, "s1.tech_lead.jsonl")).size;
    expect(size).toBeLessThanOrEqual(MAX_INTENT_FILE_BYTES);
    expect(size).toBeGreaterThan(MAX_INTENT_FILE_BYTES - 1_000);
    const before = size;
    log.append("s1", "tech_lead", entry());
    expect(statSync(path.join(dir, "s1.tech_lead.jsonl")).size).toBe(before);
  });
  it("read returns the last 50 and skips a corrupt line", () => {
    const log = new IntentLog(dir);
    for (let i = 0; i < 70; i++) log.append("s1", "tech_lead", entry(i));
    const file = path.join(dir, "s1.tech_lead.jsonl");
    writeFileSync(file, readOnce(file).text + "{not json\n" + JSON.stringify({ ts: "x", trigger: "reply" }) + "\n" + JSON.stringify(entry(99)) + "\n");
    const got = log.read("s1", "tech_lead");
    expect(MAX_INTENTS_RETURNED).toBe(50);
    expect(got).toHaveLength(50);
    expect(got[49]).toEqual(entry(99));
    expect(got[0]).toEqual(entry(21));
  });
  it("read of a missing file or directory is empty and never throws", () => {
    expect(new IntentLog(dir).read("s1", "tech_lead")).toEqual([]);
  });
  it("remove(id) deletes every file of the session, remove(id, role) one, and never throws", () => {
    const log = new IntentLog(dir);
    log.append("s1", "tech_lead", entry()); log.append("s1", "cfo", entry()); log.append("s2", "cfo", entry());
    log.remove("s1", "cfo");
    expect(readdirSync(dir).sort()).toEqual(["s1.tech_lead.jsonl", "s2.cfo.jsonl"]);
    log.remove("s1");
    expect(readdirSync(dir)).toEqual(["s2.cfo.jsonl"]);
    expect(() => log.remove("s1")).not.toThrow();
    expect(() => new IntentLog(path.join(root, "none")).remove("s1")).not.toThrow();
  });
  it.skipIf(process.platform === "win32")("a pre-existing 0755 directory and 0644 file end up 0700 and 0600", () => {
    mkdirSync(dir, { recursive: true }); chmodSync(dir, 0o755);
    const file = path.join(dir, "s1.tech_lead.jsonl");
    writeFileSync(file, ""); chmodSync(file, 0o644);
    new IntentLog(dir).append("s1", "tech_lead", entry());
    expect(dirMode(dir)).toBe(0o700);
    expect(readOnce(file).mode).toBe(0o600);
  });
  it.skipIf(process.platform === "win32")("a FIFO in the file's place does not block append or read", () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    execFileSync("mkfifo", [path.join(dir, "s1.tech_lead.jsonl")]);
    const log = new IntentLog(dir);
    log.append("s1", "tech_lead", entry());
    expect(log.read("s1", "tech_lead")).toEqual([]);
  });
  it("append never throws when the directory cannot be made", () => {
    writeFileSync(path.join(root, "file"), "x");
    const lines: string[] = [];
    const log = new IntentLog(path.join(root, "file", "intents"), (m) => lines.push(m));
    expect(() => log.append("s1", "tech_lead", entry())).not.toThrow();
    expect(lines.length).toBeGreaterThan(0);
  });
});
