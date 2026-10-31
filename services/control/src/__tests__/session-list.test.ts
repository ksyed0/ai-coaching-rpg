import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionList, type Entry } from "../session-list.js";
import { dirMode, readOnce } from "./read-once.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (): string => { const d = mkdtempSync(path.join(tmpdir(), "acr-ctl-list-")); dirs.push(d); return d; };
const e = (sessionId: string, status: Entry["status"] = "running"): Entry => ({ sessionId, scenarioId: "friday-escalation", status });
const REFUSED = "the session list is not usable";
const readErr = (l: SessionList): string => { try { l.read(); } catch (x) { return (x as Error).message; } throw new Error("expected read to throw"); };

describe("SessionList", () => {
  it("a missing file reads as empty and a missing directory is created 0700", () => {
    const d = tmp();
    const file = path.join(d, "sub", "sessions.json");
    const l = new SessionList(file);
    expect(l.read()).toEqual([]);
    l.upsert(e("a"));
    expect(dirMode(path.dirname(file))).toBe(0o700);
  });

  it("upserts by session id and removes", () => {
    const l = new SessionList(path.join(tmp(), "sessions.json"));
    l.upsert(e("a")); l.upsert(e("b")); l.upsert(e("a", "ended"));
    expect(l.read()).toEqual([e("a", "ended"), e("b")]);
    l.remove("a"); l.remove("zzz");
    expect(l.read()).toEqual([e("b")]);
  });

  it("refuses to write an invalid entry", () => {
    const l = new SessionList(path.join(tmp(), "sessions.json"));
    expect(() => l.upsert({ ...e("a"), status: "weird" as Entry["status"] })).toThrow();
    expect(() => l.upsert(e("../x"))).toThrow();
    expect(() => l.upsert({ ...e("a"), scenarioId: "a/b" })).toThrow();
    expect(l.read()).toEqual([]);
  });

  it("session-list file is 0600 and replaced atomically", () => {
    const d = tmp();
    const file = path.join(d, "sessions.json");
    const l = new SessionList(file);
    l.upsert(e("a"));
    const first = readOnce(file);
    expect(first.mode).toBe(0o600);
    l.upsert(e("b"));
    const second = readOnce(file);
    expect(second.mode).toBe(0o600);
    expect(second.ino).not.toBe(first.ino); // a new file was renamed over the old one
    expect(readdirSync(d)).toEqual(["sessions.json"]); // no temp file left behind
    // a reader never sees a partial file: the content is always complete JSON
    expect(JSON.parse(second.text)).toHaveLength(2);
  });

  it("a failed write leaves the old file intact and no temp file", () => {
    const d = tmp();
    const file = path.join(d, "sessions.json");
    const l = new SessionList(file, { beforeRename: () => { throw new Error("injected"); } });
    const ok = new SessionList(file);
    ok.upsert(e("a"));
    const before = readFileSync(file, "utf8");
    expect(() => l.upsert(e("b"))).toThrow("injected");
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readdirSync(d)).toEqual(["sessions.json"]);
  });

  it("a corrupt session list is refused, never replaced by an empty one", () => {
    const d = tmp();
    const file = path.join(d, "sessions.json");
    const l = new SessionList(file);
    writeFileSync(file, "{not json", { mode: 0o600 });
    expect(readErr(l)).toBe(REFUSED);
    expect(() => l.upsert(e("a"))).toThrow(REFUSED);
    expect(() => l.remove("a")).toThrow(REFUSED);
    expect(readFileSync(file, "utf8")).toBe("{not json");
  });

  it("wrong-shape content is refused", () => {
    const d = tmp();
    const file = path.join(d, "sessions.json");
    const l = new SessionList(file);
    const bad: unknown[] = [
      {}, "x", null,
      [{ sessionId: "a", scenarioId: "s", status: "weird" }],
      [{ sessionId: "../a", scenarioId: "s", status: "running" }],
      [{ sessionId: "a", scenarioId: "s/x", status: "running" }],
      [{ sessionId: "a", scenarioId: "s" }],
      [{ sessionId: "a", scenarioId: "s", status: "running", extra: 1 }],
      [e("a"), e("a")],
      [5],
    ];
    for (const b of bad) {
      writeFileSync(file, JSON.stringify(b), { mode: 0o600 });
      expect(readErr(l)).toBe(REFUSED);
    }
  });

  it("an oversize file is refused", () => {
    const d = tmp();
    const file = path.join(d, "sessions.json");
    writeFileSync(file, " ".repeat(1024 * 1024 + 1), { mode: 0o600 });
    expect(readErr(new SessionList(file))).toBe(REFUSED);
  });

  it("a symlink in place of the file is refused and its target untouched", () => {
    const d = tmp();
    const target = path.join(d, "target.json");
    writeFileSync(target, "[]", { mode: 0o600 });
    const file = path.join(d, "sessions.json");
    symlinkSync(target, file);
    const l = new SessionList(file);
    expect(readErr(l)).toBe(REFUSED);
    expect(() => l.upsert(e("a"))).toThrow(REFUSED);
    expect(readFileSync(target, "utf8")).toBe("[]");
  });

  it("a hard-linked file is refused", () => {
    const d = tmp();
    const other = path.join(d, "other.json");
    writeFileSync(other, "[]", { mode: 0o600 });
    const file = path.join(d, "sessions.json");
    linkSync(other, file);
    expect(readErr(new SessionList(file))).toBe(REFUSED);
  });

  it("a non-regular file (a directory) is refused", () => {
    const d = tmp();
    const file = path.join(d, "sessions.json");
    mkdirSync(file);
    expect(readErr(new SessionList(file))).toBe(REFUSED);
  });

  it("a file owned by someone else is refused", () => {
    const d = tmp();
    const file = path.join(d, "sessions.json");
    writeFileSync(file, "[]", { mode: 0o600 });
    const uid = process.getuid?.() ?? 0;
    const l = new SessionList(file, { currentUid: () => uid + 1 });
    expect(readErr(l)).toBe(REFUSED);
    expect(new SessionList(file, { currentUid: () => uid }).read()).toEqual([]);
  });

  it("a stale temp file from a crash does not block a write", () => {
    const d = tmp();
    const file = path.join(d, "sessions.json");
    writeFileSync(path.join(d, ".sessions.json.tmp-1"), "junk");
    const l = new SessionList(file);
    l.upsert(e("a"));
    expect(JSON.parse(readOnce(file).text)).toEqual([e("a")]);
    expect(l.read()).toEqual([e("a")]);
  });

  it("a file that is more permissive than 0600 is tightened on the next write", () => {
    const d = tmp();
    const file = path.join(d, "sessions.json");
    const l = new SessionList(file);
    l.upsert(e("a"));
    chmodSync(file, 0o644);
    l.upsert(e("b"));
    expect(readOnce(file).mode).toBe(0o600);
  });
});
