import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { linkSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenario } from "@acr/script";
import { isValidSessionId } from "@acr/events";
import { JsonlEventLog } from "../engine/event-log.js";
import { codesFileName, readJoinCodesFile, removeJoinCodesFile, sweepJoinCodesTemps } from "../engine/join-code-file.js";
import { SessionLock, finishInterruptedRotation, rotateStaleLog } from "../engine/log-files.js";
import { openSession } from "../engine/session-store.js";
import { SystemClock } from "../engine/clock.js";
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 }); // real files and locks; nothing here measures elapsed time

/**
 * US-0020 / AC-0062: a session id becomes `<id>.jsonl`, `<id>.lock` and `<id>.codes.json`. Hostile ids (path traversal, hidden files,
 * separators, regular-expression syntax, control characters, over-long names) must be refused by EVERY function that takes one, before
 * anything is created, and the ids that are accepted must only ever create files directly inside the data directory.
 */
const HOSTILE = ["..", ".", "../x", "..\\x", "a/b", "a\\b", "/abs", "/etc/passwd", ".hidden", ".jsonl", "x.jsonl", "x.lock", "x.codes.json", "a.b", "a b", "a\0b", "a\nb", "a‮b",
  "%2e%2e", "a%2fb", "~", "$HOME", "`id`", "a|b", "a*", "a(b", "(a|.*)", "[a-z]", "a+", "a?", "a{2}", "^a$", "é", "ａｂ", "", "x".repeat(65), "x".repeat(10_000)];
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../packages/script/src/__tests__/fixtures/minimal");
let root: string;
beforeAll(async () => { root = await mkdtemp(path.join(os.tmpdir(), "acr-idfiles-")); });
afterAll(async () => { await rm(root, { recursive: true, force: true }); });

describe("session ids and the file system (US-0020)", () => {
  it("every function that takes a session id refuses a hostile one up front, with an existing and a missing directory, and creates nothing", async () => {
    const scenario = await loadScenario(fixture);
    for (const id of HOSTILE) {
      const parent = await mkdtemp(path.join(root, "h-"));
      const data = path.join(parent, "data");
      await mkdir(data, { mode: 0o700 });
      const label = JSON.stringify(id.slice(0, 20));
      expect(isValidSessionId(id), label).toBe(false);
      for (const dir of [data, path.join(parent, "missing")]) {
        const at = `${label} in ${path.basename(dir)}`;
        expect(() => new JsonlEventLog(id, dir), at).toThrow(/invalid session id/);
        expect(() => SessionLock.acquire(dir, id), at).toThrow(/invalid session id/);
        expect(() => rotateStaleLog(dir, id, new Date(0)), at).toThrow(/invalid session id/);
        expect(() => finishInterruptedRotation(dir, id), at).toThrow(/invalid session id/);
        expect(() => codesFileName(id), at).toThrow(/invalid session id/);
        expect(() => readJoinCodesFile(dir, id), at).toThrow(/invalid session id/);
        expect(() => removeJoinCodesFile(dir, id), at).toThrow(/invalid session id/);
        expect(() => sweepJoinCodesTemps(dir, id), at).toThrow(/invalid session id/);
        await expect(openSession({ scenario, sessionId: id, dataDir: dir, clock: new SystemClock(), mode: "resume", joinCodes: true }), at).rejects.toThrow(/invalid session id/);
        await expect(openSession({ scenario, sessionId: id, dataDir: dir, clock: new SystemClock(), mode: "fresh" }), at).rejects.toThrow(/invalid session id/);
      }
      expect(await readdir(data), label).toEqual([]);
      expect(await readdir(parent), label).toEqual(["data"]); // the refusal came before any directory was created
    }
  });

  it("a value that is not a string is refused by openSession and the lock too", async () => {
    const scenario = await loadScenario(fixture);
    const dir = path.join(await mkdtemp(path.join(root, "ns-")), "d");
    for (const id of [undefined, null, ["local"], 7] as unknown[]) {
      expect(() => SessionLock.acquire(dir, id as string)).toThrow(/invalid session id/);
      await expect(openSession({ scenario, sessionId: id as string, dataDir: dir, clock: new SystemClock(), mode: "resume" })).rejects.toThrow(/invalid session id/);
    }
    expect(await readdir(path.dirname(dir))).toEqual([]);
  });

  it("an id that is accepted creates its files directly inside the data directory and nothing else", async () => {
    const scenario = await loadScenario(fixture);
    for (const id of ["local", "A", "a-b_c", "-", "_", "x".repeat(64), "__proto__", "constructor", "prototype", "facilitator", "toString", "CON"]) {
      const data = path.join(await mkdtemp(path.join(root, "ok-")), "data");
      const store = await openSession({ scenario, sessionId: id, dataDir: data, clock: new SystemClock(), mode: "resume", joinCodes: true });
      try {
        const names = (await readdir(data)).sort();
        expect(names.length).toBeGreaterThan(0);
        for (const n of names) expect(n.startsWith(`${id}.`), `${id}: ${n}`).toBe(true);
        expect(names).toContain(`${id}.lock`);
        expect(names).toContain(`${id}.codes.json`);
        expect(path.dirname(path.resolve(data, `${id}.lock`))).toBe(path.resolve(data));
      } finally { store.lock.release(); }
    }
  });

  it("two ids that name one file are refused as already held (a case-insensitive file system maps LOCAL.lock and local.lock to one file)", async () => {
    // A hard link stands in for the file system's case folding: both names are one inode, as `LOCAL` and `local` are on APFS or NTFS.
    const dir = path.join(await mkdtemp(path.join(root, "ci-")), "data");
    await mkdir(dir, { mode: 0o700 });
    const first = SessionLock.acquire(dir, "local");
    try {
      // (on a case-insensitive file system the two names already are one file and the link says so)
      try { linkSync(path.join(dir, "local.lock"), path.join(dir, "LOCAL.lock")); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
      expect(() => SessionLock.acquire(dir, "LOCAL")).toThrow(/already open in this server process/);
      expect(first.verify()).toBe(true); // the first holder was not taken over
    } finally { first.release(); }
  });

});

describe("one definition of the identifier rules (US-0020)", () => {
  const SRC_ROOTS = ["../../../../packages", "../../../../services"].map((r) => path.join(path.dirname(fileURLToPath(import.meta.url)), r));
  const own = path.join("packages", "events", "src", "ids.ts");
  const skip = new Set(["node_modules", "dist", "coverage", "__tests__", "fixtures"]);
  /** Text heuristics that are NOT id validation and keep their own character class, exempt by file:line (a code-fence language strip, the "[name]:" speaker labels a model may echo, and the two model-id patterns). */
  const EXEMPT = new Set(["services/runtime/src/agents/gm-parse.ts:109", "services/runtime/src/agents/npc-reply.ts:90",
    // the character class of a MODEL id (`gemma-4-31b-it-qat-mxfp4`, `vendor/model:tag`), not an identifier of this system
    "services/runtime/src/demo/args.ts:12", "services/runtime/src/evaluator/config.ts:16"]);

  /** Comments are blanked (same line count) so a word in a comment is not a spelling. */
  const blankComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));
  /** Lines (1-based) that spell an id rule: a character class with letters, digits and `_` in any order, a `\w` class, a reserved-name list in any order, or a lone prototype-key literal. */
  function findIdSpellings(text: string): number[] {
    const hits = new Set<number>();
    const lines = blankComments(text).split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/\[((?:\\.|[^\]\\])*)\]/g)) {
        const body = m[1]!;
        if ((/a-z/i.test(body) && /0-9/.test(body) && body.includes("_")) || (/\\w/.test(body) && /-/.test(body))) hits.add(i + 1);
      }
      if (/["'`](?:__proto__|constructor|prototype)["'`]/.test(line)) hits.add(i + 1);
    });
    return [...hits];
  }

  async function sources(dir: string, out: string[] = []): Promise<string[]> {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await sources(p, out);
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
    }
    return out;
  }

  it("no source file other than packages/events/src/ids.ts spells an identifier rule (outside the two exempt heuristics)", async () => {
    const offenders: string[] = [];
    for (const dir of SRC_ROOTS) {
      for (const file of await sources(dir)) {
        if (file.endsWith(own)) continue;
        const rel = path.relative(path.resolve(dir, ".."), file).split(path.sep).join("/");
        for (const line of findIdSpellings(await readFile(file, "utf8"))) if (!EXEMPT.has(`${rel}:${line}`)) offenders.push(`${rel}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the exempt lines are still where the exemption says (a moved line must be re-judged, not silently covered)", async () => {
    const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
    for (const key of EXEMPT) {
      const [file, line] = [key.slice(0, key.lastIndexOf(":")), Number(key.slice(key.lastIndexOf(":") + 1))];
      const text = (await readFile(path.join(base, file), "utf8")).split("\n")[line - 1] ?? "";
      expect(findIdSpellings(text), key).toEqual([1]);
    }
  });

  it.each([
    "const a = /^[a-z0-9_-]{1,64}$/;", "const a = /^[A-Za-z0-9_-]+$/;", "const a = /^[a-zA-Z0-9_-]{1,64}$/;", "const a = /^[0-9a-z_-]+$/;", "const a = /^[a-z0-9_.-]+$/;",
    "const a = /^[_a-z0-9\\-]+$/;", "const a = /^[\\w-]{1,64}$/;", 'const a = new RegExp("^[a-z0-9_-]+$");', "const a = `[A-Za-z0-9_-]`;",
    'const r = ["__proto__", "constructor", "prototype"];', 'const r = ["prototype", "__proto__"];', 'const r = new Set(["constructor", "facilitator", "__proto__"]);', 'if (id === "__proto__") x();', "const k = '__proto__';",
  ])("the guard flags the variant %s", (line) => {
    expect(findIdSpellings(`const x = 1;\n${line}\n`)).toEqual([2]);
  });

  it.each(["// /^[a-z0-9_-]+$/ in a comment", "/* [A-Za-z0-9_-] and \"__proto__\" */\nconst a = 1;", "const a = /^[0-9]+$/;", "const b = /[a-z]+/;", "const url = 'http://x/[a-z]';", "const o = { constructor: 1 };"])("the guard does not flag %s", (src) => {
    expect(findIdSpellings(src)).toEqual([]);
  });
});
