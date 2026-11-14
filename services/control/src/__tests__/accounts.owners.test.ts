import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OwnerStore } from "../accounts/owners.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (): string => { const d = mkdtempSync(path.join(tmpdir(), "acr-ctl-owners-")); dirs.push(d); return d; };
const A = "a".repeat(32), B = "b".repeat(32);

describe("session owners store", () => {
  it("owner_store_round_trips_and_missing_file_is_empty", () => {
    const file = path.join(tmp(), "session-owners.json");
    const s = new OwnerStore(file);
    expect(s.get(A)).toBeNull();
    expect(s.all()).toEqual({});
    s.set(A, "acc-1");
    s.set(B, "acc-2");
    expect(new OwnerStore(file).get(A)).toBe("acc-1");
    expect(new OwnerStore(file).all()).toEqual({ [A]: "acc-1", [B]: "acc-2" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ owners: { [A]: "acc-1", [B]: "acc-2" } });
    s.set(A, null);
    expect(s.get(A)).toBeNull();
    expect(s.all()).toEqual({ [B]: "acc-2" });
  });

  it("owner_store_refuses_corrupt_and_group_writable", () => {
    const d = tmp();
    const file = path.join(d, "session-owners.json");
    const s = new OwnerStore(file);
    for (const bad of ["not json", "[]", "{}", '{"owners":[]}', '{"owners":{"a":1}}']) {
      writeFileSync(file, bad, { mode: 0o600 }); chmodSync(file, 0o600);
      expect(() => s.get(A)).toThrow();
      expect(() => s.all()).toThrow();
      expect(() => s.set(A, "x")).toThrow();
      expect(readFileSync(file, "utf8")).toBe(bad); // never replaced
    }
    writeFileSync(file, '{"owners":{}}', { mode: 0o600 }); chmodSync(file, 0o660);
    expect(() => s.get(A)).toThrow();
    expect(() => s.set(A, "x")).toThrow();
    expect(readFileSync(file, "utf8")).toBe('{"owners":{}}');
  });
});
