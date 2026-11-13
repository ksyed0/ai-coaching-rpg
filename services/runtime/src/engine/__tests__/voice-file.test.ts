import { closeSync, fstatSync, openSync, constants as fsConstants } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_VOICE_FILE_BYTES, VoiceChoices, VoiceRecordError, readVoiceFile, removeVoiceFile, voiceFileName, writeVoiceFile } from "../voice-file.js";

// US-0070 (EPIC-0003 voice A1a): the per-session voice record `<sessionId>.voice.json` (overview section 4, contradiction C5).
let parentTmp = "";
let savedTmp: string | undefined;
let dir = "";
beforeAll(async () => { savedTmp = process.env.TMPDIR; parentTmp = await mkdtemp(path.join(os.tmpdir(), "acr-voicefile-")); process.env.TMPDIR = parentTmp; });
afterAll(async () => { if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp; await rm(parentTmp, { recursive: true, force: true }); });
beforeEach(async () => { dir = await mkdtemp(path.join(parentTmp, "d-")); });

const bind = { sessionId: "s1", logIdentity: "0123456789abcdef0123456789abcdef" };
const entry = (participantId = "p-1", choice: "voice" | "text_only" = "voice") => ({ participantId, choice, noticeVersion: "v3", at: 1731050000000 });
const record = (entries: Record<string, unknown> = { cfo: entry() }, over: Record<string, unknown> = {}) => ({ v: 1, sessionId: bind.sessionId, logIdentity: bind.logIdentity, entries, ...over });
const writeRaw = (value: unknown) => writeFile(path.join(dir, voiceFileName(bind.sessionId)), typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });

describe("voiceFileName", () => {
  it("is <sessionId>.voice.json", () => { expect(voiceFileName("s1")).toBe("s1.voice.json"); });
  it("refuses a hostile session id before touching the disk", async () => {
    for (const id of ["..", ".", "../x", "a/b", "a\\b", "/abs", ".hidden", "a.b", "a b", "a\0b", "a\nb", "é", "", "x".repeat(65)]) {
      expect(() => voiceFileName(id), JSON.stringify(id)).toThrow(/invalid session id/);
      expect(() => readVoiceFile(dir, { ...bind, sessionId: id }), JSON.stringify(id)).toThrow(/invalid session id/);
      expect(() => removeVoiceFile(dir, id), JSON.stringify(id)).toThrow(/invalid session id/);
    }
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("readVoiceFile and writeVoiceFile", () => {
  it("a missing file reads as no choices and no problem", () => {
    const r = readVoiceFile(dir, bind);
    expect(r.problem).toBeUndefined();
    expect(r.choices.entry("cfo")).toBeUndefined();
    expect(r.choices.choiceFor("cfo", "p-1")).toBe("none");
  });

  it("a written record reads back equal and the file is 0600", () => {
    const c = VoiceChoices.empty(bind);
    c.set("cfo", entry());
    c.set("cto", entry("p-2", "text_only"));
    writeVoiceFile(dir, bind, c);
    const r = readVoiceFile(dir, bind);
    expect(r.problem).toBeUndefined();
    expect(r.choices.toRecord()).toEqual(c.toRecord());
    expect(r.choices.toRecord()).toEqual(record({ cfo: entry(), cto: entry("p-2", "text_only") }));
    // Mode from ONE descriptor (no stat-then-open race).
    const fd = openSync(path.join(dir, "s1.voice.json"), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try { expect(fstatSync(fd).mode & 0o777).toBe(0o600); } finally { closeSync(fd); }
  });

  it("a failing pre-commit check leaves the old file and no temp file", async () => {
    const c = VoiceChoices.empty(bind);
    c.set("cfo", entry());
    writeVoiceFile(dir, bind, c);
    c.set("cfo", entry("p-1", "text_only"));
    expect(() => writeVoiceFile(dir, bind, c, () => { throw new Error("lock lost"); })).toThrow(/lock lost/);
    expect(readVoiceFile(dir, bind).choices.entry("cfo")?.choice).toBe("voice");
    expect(await readdir(dir)).toEqual(["s1.voice.json"]);
  });

  it("writeVoiceFile refuses choices bound to another session or log", () => {
    const c = VoiceChoices.empty(bind);
    expect(() => writeVoiceFile(dir, { ...bind, logIdentity: "f".repeat(32) }, c)).toThrow(VoiceRecordError);
    expect(() => writeVoiceFile(dir, { ...bind, sessionId: "s2" }, c)).toThrow(VoiceRecordError);
  });

  it("a record for another logIdentity reads as no choices with problem other_log; another session id too", async () => {
    await writeRaw(record(undefined, { logIdentity: "f".repeat(32) }));
    let r = readVoiceFile(dir, bind);
    expect(r.problem).toBe("other_log");
    expect(r.choices.entry("cfo")).toBeUndefined();
    await writeRaw(record(undefined, { sessionId: "s2" }));
    r = readVoiceFile(dir, bind);
    expect(r.problem).toBe("other_log");
  });

  it("malformed records read as no choices with problem malformed, and never quote the record", async () => {
    const SECRET = "SECRET-VOICE-7f3a";
    const bad: unknown[] = [
      // (A file holding the JSON literal null reads like a missing file through readSecureJson: no choices either way.)
      `{not json ${SECRET}`, "[]", "7", `"${SECRET}"`,
      { ...record(), extra: SECRET }, { v: 1, sessionId: "s1", logIdentity: bind.logIdentity }, record(undefined, { v: 2 }),
      record(undefined, { logIdentity: "XYZ" }), record(undefined, { sessionId: 5 }), record(undefined, { entries: [] }), record(undefined, { entries: null }),
      record({ cfo: { ...entry(), participantId: 5 } }), record({ cfo: { ...entry(), choice: "voice_only" } }),
      record({ cfo: { ...entry(), extra: SECRET } }), record({ cfo: { participantId: "p", choice: "voice", noticeVersion: "v3" } }),
      record({ cfo: { ...entry(), participantId: "rebind-pending" } }), record({ cfo: { ...entry(), participantId: "" } }),
      record({ cfo: { ...entry(), participantId: "p".repeat(129) } }), record({ cfo: { ...entry(), noticeVersion: "v 3" } }),
      record({ cfo: { ...entry(), at: -1 } }), record({ cfo: { ...entry(), at: "now" } }), record({ cfo: "voice" }),
      record({ facilitator: entry() }), record({ "Bad Id": entry() }), record({ ["x".repeat(129)]: entry() }),
    ];
    for (const b of bad) {
      await writeRaw(b);
      const r = readVoiceFile(dir, bind);
      expect(r.problem, JSON.stringify(b)).toBe("malformed");
      expect(r.choices.entry("cfo")).toBeUndefined();
    }
    // A reserved role id written as an own JSON key.
    await writeRaw(`{"v":1,"sessionId":"s1","logIdentity":"${bind.logIdentity}","entries":{"__proto__":${JSON.stringify(entry())}}}`);
    expect(readVoiceFile(dir, bind).problem).toBe("malformed");
    await writeRaw(`{"v":1,"sessionId":"s1","logIdentity":"${bind.logIdentity}","entries":{"constructor":${JSON.stringify(entry())}}}`);
    expect(readVoiceFile(dir, bind).problem).toBe("malformed");
    try { VoiceChoices.fromRecord({ ...record(), extra: SECRET }, bind); expect.unreachable(); }
    catch (err) { expect(err).toBeInstanceOf(VoiceRecordError); expect((err as Error).message).not.toContain(SECRET); }
  });

  it("a file larger than 64 KiB is malformed", async () => {
    expect(MAX_VOICE_FILE_BYTES).toBe(64 * 1024);
    await writeRaw(JSON.stringify(record()) + " ".repeat(64 * 1024));
    expect(readVoiceFile(dir, bind).problem).toBe("malformed");
  });

  it("a symlink at the file path is refused, never followed", async () => {
    const target = path.join(dir, "target.json");
    await writeFile(target, JSON.stringify(record()), { mode: 0o600 });
    await symlink(target, path.join(dir, "s1.voice.json"));
    const r = readVoiceFile(dir, bind);
    expect(r.problem).toBe("malformed");
    expect(r.choices.entry("cfo")).toBeUndefined();
  });

  it("a directory at the file path is malformed; an unreadable directory is an I/O error that throws", async () => {
    await mkdir(path.join(dir, "s1.voice.json"));
    expect(readVoiceFile(dir, bind).problem).toBe("malformed");
    expect(() => readVoiceFile(path.join(dir, "missing-dir", "\0bad"), bind)).toThrow();
  });

  it("removeVoiceFile removes the file and a missing file is fine", async () => {
    writeVoiceFile(dir, bind, VoiceChoices.empty(bind));
    removeVoiceFile(dir, "s1");
    expect(await readdir(dir)).toEqual([]);
    expect(() => removeVoiceFile(dir, "s1")).not.toThrow();
  });

  it("the record on disk has exactly the overview's keys", async () => {
    const c = VoiceChoices.empty(bind);
    c.set("cfo", entry());
    writeVoiceFile(dir, bind, c);
    const raw = JSON.parse(await readFile(path.join(dir, "s1.voice.json"), "utf8"));
    expect(Object.keys(raw).sort()).toEqual(["entries", "logIdentity", "sessionId", "v"]);
    expect(Object.keys(raw.entries.cfo).sort()).toEqual(["at", "choice", "noticeVersion", "participantId"]);
  });
});

describe("VoiceChoices", () => {
  it("choiceFor returns none without an entry, the choice for the same participant and text_only for another participant", () => {
    const c = VoiceChoices.empty(bind);
    expect(c.choiceFor("cfo", "p-1")).toBe("none");
    c.set("cfo", entry("p-1", "voice"));
    expect(c.choiceFor("cfo", "p-1")).toBe("voice");
    expect(c.choiceFor("cfo", "p-2")).toBe("text_only");
    expect(c.choiceFor("cfo", undefined)).toBe("text_only");
    expect(c.choiceFor("cfo", "rebind-pending")).toBe("text_only");
    c.set("cfo", entry("p-1", "text_only"));
    expect(c.choiceFor("cfo", "p-1")).toBe("text_only");
  });

  it("remove deletes an entry and says whether there was one", () => {
    const c = VoiceChoices.empty(bind);
    c.set("cfo", entry());
    expect(c.remove("cfo")).toBe(true);
    expect(c.remove("cfo")).toBe(false);
    expect(c.choiceFor("cfo", "p-1")).toBe("none");
  });

  it("set refuses an invalid role or entry (the in-memory record never holds what the file would refuse)", () => {
    const c = VoiceChoices.empty(bind);
    expect(() => c.set("facilitator", entry())).toThrow(VoiceRecordError);
    expect(() => c.set("Bad Id", entry())).toThrow(VoiceRecordError);
    expect(() => c.set("cfo", entry("rebind-pending"))).toThrow(VoiceRecordError);
    expect(() => c.set("cfo", { ...entry(), noticeVersion: "v 3" })).toThrow(VoiceRecordError);
    expect(c.entry("cfo")).toBeUndefined();
  });

  it("empty refuses a bad binding", () => {
    expect(() => VoiceChoices.empty({ sessionId: "../x", logIdentity: bind.logIdentity })).toThrow();
    expect(() => VoiceChoices.empty({ sessionId: "s1", logIdentity: "nope" })).toThrow(VoiceRecordError);
  });

  it("an entry read is a copy (callers cannot change the store through it)", () => {
    const c = VoiceChoices.empty(bind);
    c.set("cfo", entry());
    const e = c.entry("cfo")!;
    (e as { choice: string }).choice = "text_only";
    expect(c.entry("cfo")!.choice).toBe("voice");
  });
});
