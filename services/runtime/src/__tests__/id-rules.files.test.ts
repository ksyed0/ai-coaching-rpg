import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
  it("every function that takes a session id refuses a hostile one and creates nothing", async () => {
    const scenario = await loadScenario(fixture);
    for (const id of HOSTILE) {
      const parent = await mkdtemp(path.join(root, "h-"));
      const data = path.join(parent, "data");
      await mkdir(data, { mode: 0o700 });
      const label = JSON.stringify(id.slice(0, 20));
      expect(isValidSessionId(id), label).toBe(false);
      expect(() => new JsonlEventLog(id, data), label).toThrow(/invalid session id/);
      expect(() => SessionLock.acquire(data, id), label).toThrow(/invalid session id/);
      expect(() => rotateStaleLog(data, id, new Date(0)), label).toThrow(/invalid session id/);
      expect(() => finishInterruptedRotation(data, id), label).toThrow(/invalid session id/);
      expect(() => codesFileName(id), label).toThrow(/invalid session id/);
      expect(() => readJoinCodesFile(data, id), label).toThrow(/invalid session id/);
      expect(() => removeJoinCodesFile(data, id), label).toThrow(/invalid session id/);
      expect(() => sweepJoinCodesTemps(data, id), label).toThrow(/invalid session id/);
      await expect(openSession({ scenario, sessionId: id, dataDir: data, clock: new SystemClock(), mode: "resume", joinCodes: true }), label).rejects.toThrow(/invalid session id/);
      await expect(openSession({ scenario, sessionId: id, dataDir: path.join(parent, "never"), clock: new SystemClock(), mode: "fresh" }), label).rejects.toThrow(/invalid session id/);
      expect(await readdir(data), label).toEqual([]);
      expect(await readdir(parent), label).toEqual(["data"]); // the refusal came before the data directory was even created
    }
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

  it("two different session ids never share a file name (the rule has no alias that maps two ids to one name)", () => {
    const ids = ["a", "A", "a-", "a_", "-a", "_a", "aa", "a-a", "a_a"];
    const names = new Set(ids.map((i) => `${i}.jsonl`));
    expect(names.size).toBe(ids.length);
  });
});

describe("one definition of the identifier rules (US-0020)", () => {
  const SRC_ROOTS = ["../../../../packages", "../../../../services"].map((r) => path.join(path.dirname(fileURLToPath(import.meta.url)), r));
  const own = path.join("packages", "events", "src", "ids.ts");
  const skip = new Set(["node_modules", "dist", "coverage", "__tests__", "fixtures"]);

  async function sources(dir: string, out: string[] = []): Promise<string[]> {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await sources(p, out);
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".d.ts")) out.push(p);
    }
    return out;
  }

  // Text heuristics that are NOT id validation and so keep their own character class: a code-fence language and the "[name]:" speaker labels a model may echo.
  const NOT_ID_VALIDATION = [/```\[A-Za-z0-9_-\]\*/, /\(\[A-Za-z0-9_-\]\{2,\}\)/];

  it("no source file other than packages/events/src/ids.ts spells an identifier character class or a reserved id list", async () => {
    // Anything that is a character class of the id alphabet: [a-z0-9_-], [A-Za-z0-9_-], [a-z0-9_\-], in a regex literal or a string.
    const alphabet = /\[(?:A-Za-z|a-z)0-9_(?:\\-|-)\]/;
    const reserved = /["']__proto__["']\s*,\s*["']constructor["']/;
    const offenders: string[] = [];
    for (const dir of SRC_ROOTS) {
      for (const file of await sources(dir)) {
        if (file.endsWith(own)) continue;
        const text = (await readFile(file, "utf8")).split("\n").filter((l) => !NOT_ID_VALIDATION.some((re) => re.test(l))).join("\n");
        if (alphabet.test(text) || reserved.test(text)) offenders.push(path.relative(path.join(dir, ".."), file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
