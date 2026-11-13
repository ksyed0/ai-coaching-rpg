import { describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ verify: 0, hash: 0, failHash: 0 }));
vi.mock("../accounts/passwords.js", async (orig) => {
  const m = await orig<typeof import("../accounts/passwords.js")>();
  return {
    ...m,
    verifyPassword: (...a: Parameters<typeof m.verifyPassword>) => { calls.verify++; return m.verifyPassword(...a); },
    hashPassword: (...a: Parameters<typeof m.hashPassword>) => {
      calls.hash++;
      if (calls.failHash > 0) { calls.failHash--; return Promise.reject(new Error("scrypt failed")); }
      return m.hashPassword(...a);
    },
  };
});
import { AccountError, AccountService } from "../accounts/service.js";
import type { AccountStore } from "../accounts/store.js";
import type { AccountsFile } from "../accounts/types.js";
import { verifyPassword } from "../accounts/passwords.js";

const H72 = 72 * 3600 * 1000;
class MemStore implements AccountStore {
  file: AccountsFile | null = null;
  corrupt = false;
  read(): AccountsFile | null {
    if (this.corrupt) throw new Error("the accounts file is not usable");
    return this.file ? structuredClone(this.file) : null;
  }
  write(f: AccountsFile): void { this.file = structuredClone(f); }
}

function setup(o: { reset?: boolean; store?: MemStore } = {}) {
  const store = o.store ?? new MemStore();
  const clock = { t: 1_000_000 };
  let n = 0, i = 0;
  const logs: string[] = [];
  const svc = new AccountService({
    store, now: () => clock.t, bootstrapPassword: "ChangeMe-Admin-1", reset: o.reset ?? false,
    newTemporary: () => `TEMP-PASSWORD-${++n}`, newId: () => `id${++i}`, log: (l) => logs.push(l),
  });
  return { store, clock, svc, logs };
}
const admin = (s: ReturnType<typeof setup>) => s.store.file!.accounts.find((a) => a.login === "admin")!;
const NEWPW = "a-much-better-pass";

describe("AccountService", () => {
  it("ensure_default_admin_creates_active_must_change_admin_once", async () => {
    const s = setup();
    await s.svc.ensureDefaultAdmin();
    await s.svc.ensureDefaultAdmin();
    const a = s.store.file!.accounts;
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ login: "admin", role: "admin", status: "active", mustChange: true, tempExpiresAt: null, epoch: 0 });
    expect(await verifyPassword("ChangeMe-Admin-1", a[0].password)).toBe(true);
    expect(s.store.file!.legacyClosed).toBe(false);
  });

  it("concurrent_ensure_default_admin_creates_one_admin_without_a_reset", async () => {
    const s = setup();
    await Promise.all([s.svc.ensureDefaultAdmin(), s.svc.ensureDefaultAdmin()]);
    expect(s.store.file!.accounts).toHaveLength(1);
    expect(admin(s).epoch).toBe(0);
    expect(s.logs.join("\n")).not.toMatch(/reset/i);
  });

  it("admin_reset_logs_the_loud_line_each_start_and_never_a_password", async () => {
    const s = setup({ reset: true });
    await s.svc.ensureDefaultAdmin(); // file missing
    await s.svc.ensureDefaultAdmin(); // file present
    expect(s.logs.filter((l) => l === "ADMIN_RESET is set: unset it after use")).toHaveLength(2);
    expect(s.logs.some((l) => l.includes("the default admin was reset (ADMIN_RESET)"))).toBe(true);
    expect(s.logs.join("\n")).not.toContain("ChangeMe-Admin-1");
    expect(setup().logs).toEqual([]);
  });

  it("missing_file_is_first_start_but_corrupt_file_is_refused", async () => {
    const s = setup();
    expect(s.store.file).toBeNull();
    await s.svc.ensureDefaultAdmin();
    expect(s.store.file).not.toBeNull();
    const c = new MemStore(); c.corrupt = true;
    await expect(setup({ store: c }).svc.ensureDefaultAdmin()).rejects.toThrow();
    expect(c.file).toBeNull();
  });

  it("present_file_never_gets_a_second_default_admin", async () => {
    const s = setup();
    await s.svc.ensureDefaultAdmin();
    s.store.file!.accounts = [];
    await s.svc.ensureDefaultAdmin();
    expect(s.store.file!.accounts).toHaveLength(0);
  });

  it("admin_reset_restores_default_and_bumps_epoch_but_keeps_legacy_closed", async () => {
    const s = setup();
    await s.svc.ensureDefaultAdmin();
    const id = admin(s).id;
    await s.svc.changePassword(id, 0, "ChangeMe-Admin-1", NEWPW);
    expect(s.store.file!.legacyClosed).toBe(true);
    const epoch = admin(s).epoch;
    const r = setup({ reset: true, store: s.store });
    await r.svc.ensureDefaultAdmin();
    const a = admin(s);
    expect(a.epoch).toBe(epoch + 1);
    expect(a).toMatchObject({ status: "active", mustChange: true, tempExpiresAt: null, role: "admin" });
    expect(await verifyPassword("ChangeMe-Admin-1", a.password)).toBe(true);
    expect(s.store.file!.legacyClosed).toBe(true);
    expect(r.logs.join("\n")).not.toContain("ChangeMe-Admin-1");
  });

  it("login_unknown_wrong_and_revoked_all_refused_with_one_verify_each", async () => {
    const s = setup();
    await s.svc.ensureDefaultAdmin();
    const iss = await s.svc.create({ login: "Bob", name: "Bob", role: "facilitator" }, null);
    s.svc.revoke(iss.account.id);
    await s.svc.login("warmup", "x"); // creates the dummy hash
    for (const [l, p] of [["nobody", "x"], ["admin", "wrong"], ["bob", iss.temporaryPassword]] as const) {
      calls.verify = 0; calls.hash = 0;
      expect(await s.svc.login(l, p)).toEqual({ ok: false, reason: "refused" });
      expect(calls.verify, l).toBe(1);
      expect(calls.hash, l).toBe(0);
    }
    const ok = await s.svc.login(" ADMIN ", "ChangeMe-Admin-1");
    expect(ok.ok).toBe(true);
    expect(JSON.stringify(ok)).not.toContain("salt");
  });

  it("login_after_72h_is_expired_only_with_the_right_password", async () => {
    const s = setup();
    await s.svc.ensureDefaultAdmin();
    const iss = await s.svc.create({ login: "bob", name: "Bob", role: "facilitator" }, null);
    expect(iss.account.tempExpiresAt).toBe(s.clock.t + H72);
    expect((await s.svc.login("bob", iss.temporaryPassword)).ok).toBe(true);
    s.clock.t += H72 + 1;
    expect(await s.svc.login("bob", iss.temporaryPassword)).toEqual({ ok: false, reason: "expired" });
    expect(await s.svc.login("bob", "wrong")).toEqual({ ok: false, reason: "refused" });
  });

  it("default_admin_does_not_expire", async () => {
    const s = setup();
    await s.svc.ensureDefaultAdmin();
    s.clock.t += 10 * H72;
    expect((await s.svc.login("admin", "ChangeMe-Admin-1")).ok).toBe(true);
  });

  it("change_password_clears_must_change_closes_legacy_and_old_check_fails", async () => {
    const s = setup();
    await s.svc.ensureDefaultAdmin();
    const id = admin(s).id;
    const r = await s.svc.changePassword(id, 0, "ChangeMe-Admin-1", NEWPW);
    expect(r.ok).toBe(true);
    expect(admin(s)).toMatchObject({ mustChange: false, tempExpiresAt: null, status: "active", epoch: 1 });
    expect(s.store.file!.legacyClosed).toBe(true);
    expect(s.svc.legacySecretAllowed()).toBe(false);
    expect(s.svc.check(id, 0)).toBeNull();
    expect(s.svc.check(id, 1)?.login).toBe("admin");
    expect((await s.svc.login("admin", NEWPW)).ok).toBe(true);
  });

  it("change_password_activates_an_invited_account_and_refuses_wrong_current", async () => {
    const s = setup();
    await s.svc.ensureDefaultAdmin();
    const iss = await s.svc.create({ login: "bob", name: "Bob", role: "facilitator" }, null);
    expect(await s.svc.changePassword(iss.account.id, 0, "nope", NEWPW)).toEqual({ ok: false, reason: "refused" });
    expect((await s.svc.changePassword(iss.account.id, 0, iss.temporaryPassword, NEWPW)).ok).toBe(true);
    expect(s.svc.list().find((a) => a.login === "bob")).toMatchObject({ status: "active", mustChange: false, tempExpiresAt: null });
  });

  it("change_password_rejects_short_and_same_as_current", async () => {
    const s = setup();
    await s.svc.ensureDefaultAdmin();
    const id = admin(s).id;
    expect(await s.svc.changePassword(id, 0, "ChangeMe-Admin-1", "short")).toEqual({ ok: false, reason: "weak" });
    expect(await s.svc.changePassword(id, 0, "ChangeMe-Admin-1", "ChangeMe-Admin-1")).toEqual({ ok: false, reason: "weak" });
    expect(s.store.file!.legacyClosed).toBe(false);
    expect(admin(s).epoch).toBe(0);
  });

  it("create_returns_temporary_once_stores_only_hash", async () => {
    const s = setup();
    await s.svc.ensureDefaultAdmin();
    const iss = await s.svc.create({ login: "bob", name: "Bob", role: "facilitator" }, "x");
    expect(iss.temporaryPassword).toBe("TEMP-PASSWORD-1");
    expect(iss.account).toMatchObject({ status: "invited", mustChange: true, createdBy: "x", epoch: 0 });
    expect(JSON.stringify(s.store.file)).not.toContain("TEMP-PASSWORD-1");
    expect(JSON.stringify(s.svc.list())).not.toContain("TEMP-PASSWORD-1");
  });

  it("create_closes_legacy", async () => {
    const s = setup();
    await s.svc.ensureDefaultAdmin();
    expect(s.svc.legacySecretAllowed()).toBe(true);
    await s.svc.create({ login: "bob", name: "Bob", role: "facilitator" }, null);
    expect(s.svc.legacySecretAllowed()).toBe(false);
  });

  it("create_duplicate_login_case_insensitive_is_conflict", async () => {
    const s = setup();
    await s.svc.ensureDefaultAdmin();
    await expect(s.svc.create({ login: " ADMIN ", name: "X", role: "admin" }, null)).rejects.toMatchObject({ code: "conflict" });
    await s.svc.create({ login: "bob", name: "Bob", role: "facilitator" }, null);
    await expect(s.svc.create({ login: "BOB", name: "B", role: "facilitator" }, null)).rejects.toBeInstanceOf(AccountError);
  });

  it("create_rejects_name_that_cleans_to_empty_or_blank_login", async () => {
    const s = setup();
    await s.svc.ensureDefaultAdmin();
    await expect(s.svc.create({ login: "bob", name: "​  ", role: "facilitator" }, null)).rejects.toMatchObject({ code: "invalid" });
    await expect(s.svc.create({ login: "   ", name: "Bob", role: "facilitator" }, null)).rejects.toMatchObject({ code: "invalid" });
  });

  it("resend_replaces_temporary_and_old_stops_working", async () => {
    const s = setup();
    await s.svc.ensureDefaultAdmin();
    const a = await s.svc.create({ login: "bob", name: "Bob", role: "facilitator" }, null);
    s.clock.t += 1000;
    const b = await s.svc.resend(a.account.id);
    expect(b.temporaryPassword).not.toBe(a.temporaryPassword);
    expect(b.account.epoch).toBe(1);
    expect(b.account.tempExpiresAt).toBe(s.clock.t + H72);
    expect(await s.svc.login("bob", a.temporaryPassword)).toEqual({ ok: false, reason: "refused" });
    expect((await s.svc.login("bob", b.temporaryPassword)).ok).toBe(true);
    await expect(s.svc.resend("admin-none")).rejects.toMatchObject({ code: "not_found" });
    await expect(s.svc.resend(admin(s).id)).rejects.toMatchObject({ code: "state" });
  });

  it("reset_password_on_active_returns_to_must_change", async () => {
    const s = setup();
    await s.svc.ensureDefaultAdmin();
    const iss = await s.svc.create({ login: "bob", name: "Bob", role: "facilitator" }, null);
    await expect(s.svc.resetPassword(iss.account.id)).rejects.toMatchObject({ code: "state" });
    await s.svc.changePassword(iss.account.id, 0, iss.temporaryPassword, NEWPW);
    const r = await s.svc.resetPassword(iss.account.id);
    expect(r.account).toMatchObject({ mustChange: true, status: "active", epoch: 2 });
    expect(r.account.tempExpiresAt).toBe(s.clock.t + H72);
    expect(await s.svc.login("bob", NEWPW)).toEqual({ ok: false, reason: "refused" });
    expect((await s.svc.login("bob", r.temporaryPassword)).ok).toBe(true);
  });

  it("revoke_bumps_epoch_check_null_login_refused", async () => {
    const s = setup();
    await s.svc.ensureDefaultAdmin();
    const iss = await s.svc.create({ login: "bob", name: "Bob", role: "facilitator" }, null);
    s.svc.revoke(iss.account.id);
    const b = s.store.file!.accounts.find((a) => a.login === "bob")!;
    expect(b).toMatchObject({ status: "revoked", epoch: 1 });
    expect(s.svc.check(b.id, 1)).toBeNull();
    expect(await s.svc.login("bob", iss.temporaryPassword)).toEqual({ ok: false, reason: "refused" });
    expect(() => s.svc.revoke("missing")).toThrow(AccountError);
  });

  it("revoke_last_active_admin_is_conflict", async () => {
    const s = setup();
    await s.svc.ensureDefaultAdmin();
    expect(() => s.svc.revoke(admin(s).id)).toThrowError(expect.objectContaining({ code: "conflict" }));
    const iss = await s.svc.create({ login: "ann", name: "Ann", role: "admin" }, null);
    const adminId = admin(s).id;
    expect(() => s.svc.revoke(adminId)).toThrowError(expect.objectContaining({ code: "conflict" })); // ann is only invited
    await s.svc.changePassword(iss.account.id, 0, iss.temporaryPassword, NEWPW);
    s.svc.revoke(adminId);
    expect(admin(s).status).toBe("revoked");
  });

  it("reinstate_issues_new_temporary", async () => {
    const s = setup();
    await s.svc.ensureDefaultAdmin();
    const a = await s.svc.create({ login: "bob", name: "Bob", role: "facilitator" }, null);
    await expect(s.svc.reinstate(a.account.id)).rejects.toMatchObject({ code: "state" });
    s.svc.revoke(a.account.id);
    const r = await s.svc.reinstate(a.account.id);
    expect(r.account).toMatchObject({ status: "invited", mustChange: true, epoch: 2 });
    expect(r.temporaryPassword).not.toBe(a.temporaryPassword);
    expect((await s.svc.login("bob", r.temporaryPassword)).ok).toBe(true);
  });

  it("public_account_never_has_password", async () => {
    const s = setup();
    await s.svc.ensureDefaultAdmin();
    const iss = await s.svc.create({ login: "bob", name: "Bob", role: "facilitator" }, null);
    for (const a of [...s.svc.list(), iss.account, s.svc.check(admin(s).id, 0)!]) expect(a).not.toHaveProperty("password");
  });
});

describe("AccountService dummy hash (final review M1)", () => {
  it("test_accounts_service_first_unknown_login_after_ensure_default_admin_does_one_verify_and_no_hash", async () => {
    const s = setup();
    await s.svc.ensureDefaultAdmin();
    calls.verify = 0; calls.hash = 0;
    expect(await s.svc.login("nobody@example.org", "whatever-pass")).toEqual({ ok: false, reason: "refused" });
    expect(calls).toMatchObject({ verify: 1, hash: 0 });
    // An existing file (a later start) builds the dummy too.
    const later = setup({ store: s.store });
    await later.svc.ensureDefaultAdmin();
    calls.verify = 0; calls.hash = 0;
    expect((await later.svc.login("nobody@example.org", "x")).ok).toBe(false);
    expect(calls).toMatchObject({ verify: 1, hash: 0 });
  });

  it("test_accounts_service_a_rejected_dummy_build_is_not_cached", async () => {
    const s = setup();
    await s.svc.ensureDefaultAdmin().catch(() => {});
    const fresh = setup({ store: s.store });
    calls.failHash = 1;
    await fresh.svc.ensureDefaultAdmin(); // the eager dummy build fails quietly; startup is not refused by it
    await expect(fresh.svc.login("nobody@example.org", "x")).resolves.toEqual({ ok: false, reason: "refused" });
    calls.failHash = 1;
    const lazy = setup({ store: s.store });
    await expect(lazy.svc.login("nobody@example.org", "x")).rejects.toThrow("scrypt failed");
    calls.hash = 0;
    await expect(lazy.svc.login("nobody@example.org", "x")).resolves.toEqual({ ok: false, reason: "refused" });
    expect(calls.hash).toBe(1);
  });
});
