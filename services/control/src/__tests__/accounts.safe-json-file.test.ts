import { chmodSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SafeJsonFile } from "../accounts/safe-json-file.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (): string => { const d = mkdtempSync(path.join(tmpdir(), "acr-ctl-safejson-")); dirs.push(d); return d; };
const errOf = (f: () => unknown): string => { try { f(); } catch (x) { return (x as Error).message; } throw new Error("expected throw"); };

describe("accounts safe json file", () => {
  it("test_safe_file_missing_is_null", () => {
    expect(new SafeJsonFile(path.join(tmp(), "a.json")).read()).toBeNull();
  });

  it("test_safe_file_round_trips_with_mode_0600", () => {
    const d = tmp();
    const file = path.join(d, "a.json");
    const f = new SafeJsonFile(file);
    f.write({ a: 1, b: ["x"] });
    expect(f.read()).toEqual({ a: 1, b: ["x"] });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(d)).toEqual(["a.json"]);
  });

  it("test_safe_file_refuses_symlink_hardlink_foreign_owner_group_writable_corrupt_and_oversize", () => {
    const d = tmp();
    const file = path.join(d, "a.json");
    const f = new SafeJsonFile(file);
    const reset = (): void => { rmSync(file, { force: true }); };
    const good = (): void => { writeFileSync(file, "{}", { mode: 0o600 }); chmodSync(file, 0o600); };

    // symlink
    writeFileSync(path.join(d, "real.json"), "{}", { mode: 0o600 });
    symlinkSync(path.join(d, "real.json"), file);
    expect(() => f.read()).toThrow();
    reset();
    // hard link
    good(); linkSync(file, path.join(d, "other.json"));
    expect(() => f.read()).toThrow();
    rmSync(path.join(d, "other.json")); reset();
    // foreign owner
    good();
    const foreign = new SafeJsonFile(file, { currentUid: () => (process.getuid?.() ?? 0) + 1 });
    expect(() => foreign.read()).toThrow();
    reset();
    // group / other accessible
    for (const mode of [0o640, 0o604, 0o660, 0o606, 0o620, 0o602, 0o644]) {
      good(); chmodSync(file, mode);
      expect(() => f.read(), mode.toString(8)).toThrow();
      expect(() => f.write({ x: 1 }), mode.toString(8)).toThrow();
      expect(readFileSync(file, "utf8")).toBe("{}");
    }
    chmodSync(file, 0o600); reset();
    // corrupt
    writeFileSync(file, "{not json", { mode: 0o600 });
    expect(() => f.read()).toThrow();
    expect(() => f.write({ x: 1 })).toThrow();
    expect(readFileSync(file, "utf8")).toBe("{not json");
    reset();
    // oversize
    writeFileSync(file, JSON.stringify({ pad: "x".repeat(1024 * 1024) }), { mode: 0o600 });
    expect(() => f.read()).toThrow();
    reset();
    // empty file is refused, not null
    writeFileSync(file, "", { mode: 0o600 });
    expect(() => f.read()).toThrow();
    // a file holding JSON null is refused, not read as "missing"
    writeFileSync(file, "null", { mode: 0o600 });
    expect(() => f.read()).toThrow();
    // write refuses an oversize value
    reset();
    expect(() => f.write({ pad: "x".repeat(1024 * 1024) })).toThrow();
    expect(readdirSync(d).filter((n) => n.startsWith(".a.json"))).toEqual([]);
    // the message never carries file content
    writeFileSync(file, "secret-token-not-json", { mode: 0o600 });
    expect(errOf(() => f.read())).not.toContain("secret-token");
  });

  it("test_safe_file_failed_rename_leaves_old_file", () => {
    const d = tmp();
    const file = path.join(d, "a.json");
    new SafeJsonFile(file).write({ v: 1 });
    const failing = new SafeJsonFile(file, { beforeRename: () => { throw new Error("boom"); } });
    expect(() => failing.write({ v: 2 })).toThrow("boom");
    expect(new SafeJsonFile(file).read()).toEqual({ v: 1 });
    expect(readdirSync(d)).toEqual(["a.json"]);
  });
});
