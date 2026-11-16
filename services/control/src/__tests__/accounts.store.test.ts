import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileAccountStore } from "../accounts/store.js";
import type { Account, AccountsFile } from "../accounts/types.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (): string => { const d = mkdtempSync(path.join(tmpdir(), "acr-ctl-store-")); dirs.push(d); return d; };
const acct = (id: string, login: string): Account => ({
  id, login, name: "N", role: "facilitator", status: "active", password: { salt: "c2FsdA", hash: "aGFzaA" },
  mustChange: false, tempExpiresAt: null, epoch: 0, createdAt: 1, createdBy: null,
});
const file = (accounts: Account[]): AccountsFile => ({ legacyClosed: false, accounts });
const put = (p: string, v: unknown): void => writeFileSync(p, JSON.stringify(v), { mode: 0o600 });

describe("accounts store", () => {
  it("test_store_missing_file_reads_null", () => {
    expect(new FileAccountStore(path.join(tmp(), "accounts.json")).read()).toBeNull();
  });

  it("test_store_round_trips_a_valid_file", () => {
    const s = new FileAccountStore(path.join(tmp(), "accounts.json"));
    const f = file([acct("a", "ann"), { ...acct("b", "bob"), role: "admin", tempExpiresAt: 5, createdBy: "a" }]);
    s.write(f);
    expect(s.read()).toEqual(f);
  });

  it("test_store_refuses_wrong_shape_duplicate_ids_and_duplicate_logins", () => {
    const p = path.join(tmp(), "accounts.json");
    const s = new FileAccountStore(p);
    const bad: unknown[] = [
      [], null, "x", {}, { legacyClosed: "no", accounts: [] }, { legacyClosed: false },
      { legacyClosed: false, accounts: "x" },
      { legacyClosed: false, accounts: [{ ...acct("a", "ann"), role: "root" }] },
      { legacyClosed: false, accounts: [{ ...acct("a", "ann"), status: "gone" }] },
      { legacyClosed: false, accounts: [{ ...acct("a", "ann"), password: { salt: "x" } }] },
      { legacyClosed: false, accounts: [{ ...acct("a", "ann"), epoch: "1" }] },
      { legacyClosed: false, accounts: [{ ...acct("a", "ann"), extra: 1 }] },
      { legacyClosed: false, extra: 1, accounts: [] },
      file([acct("a", "ann"), acct("a", "bob")]),
      file([acct("a", "ann"), acct("b", "ann")]),
    ];
    for (const v of bad) {
      put(p, v);
      expect(() => s.read(), JSON.stringify(v)).toThrow();
    }
    expect(() => s.write(file([acct("a", "ann"), acct("a", "bob")]))).toThrow();
    expect(() => s.write(file([acct("a", "ann"), acct("b", "ann")]))).toThrow();
    expect(() => s.write({ legacyClosed: false, accounts: [{ ...acct("a", "ann"), role: "root" as never }] })).toThrow();
  });
});
