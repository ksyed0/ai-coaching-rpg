import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountService } from "../accounts/service.js";
import type { AccountStore } from "../accounts/store.js";
import type { AccountsFile } from "../accounts/types.js";
import { createApi } from "../api.js";
import type { ControlConfig } from "../config.js";
import type { Supervisor } from "../supervisor.js";

const TOKEN = "t".repeat(40);
const BOOT = "ChangeMe-Admin-1";
class MemStore implements AccountStore {
  file: AccountsFile | null = null;
  corrupt = false;
  read(): AccountsFile | null {
    if (this.corrupt) throw new Error("the accounts file is not usable: /secret/path/accounts.json");
    return this.file ? structuredClone(this.file) : null;
  }
  write(f: AccountsFile): void { this.file = structuredClone(f); }
}
let store: MemStore;
let logs: string[];
let server: http.Server;
let port: number;
let n: number;

beforeEach(async () => {
  store = new MemStore();
  logs = [];
  n = 0;
  const accounts = new AccountService({
    store, now: () => 1_000_000, bootstrapPassword: BOOT, reset: false, newTemporary: () => `TEMP-PASSWORD-${++n}`, newId: () => `id${n + 100}`,
    log: (m) => logs.push(m),
  });
  await accounts.ensureDefaultAdmin();
  const handler = createApi({
    config: { serviceToken: TOKEN } as ControlConfig, supervisor: {} as unknown as Supervisor, scenarios: () => Promise.resolve([]),
    log: (m) => logs.push(m), accounts,
  });
  server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});
afterEach(async () => { await new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }); });

type Reply = { status: number; text: string; json: any };
async function call(method: string, path: string, o: { token?: string | null; body?: unknown } = {}): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (o.token !== null) headers["x-service-token"] = o.token ?? TOKEN;
  const body = o.body === undefined ? undefined : JSON.stringify(o.body);
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, text, json };
}
const adminAccount = () => store.file!.accounts.find((a) => a.login === "admin")!;
const create = (login = "pat") => call("POST", "/accounts", { body: { login, name: "Pat", role: "facilitator", by: adminAccount().id } });

describe("account routes", () => {
  it("login_route_returns_account_without_hash", async () => {
    const r = await call("POST", "/accounts/login", { body: { login: "Admin", password: BOOT } });
    expect(r.status).toBe(200);
    expect(r.json.success).toBe(true);
    expect(r.json.data.account).toMatchObject({ login: "admin", role: "admin", mustChange: true });
    expect(r.text).not.toMatch(/password|hash|salt/i);
    const bad = await call("POST", "/accounts/login", { body: { login: "admin", password: "nope-nope-nope" } });
    expect(bad.status).toBe(401);
    expect(bad.json.error.code).toBe("login_refused");
  });

  it("login_expired_for_a_stale_temporary_password", async () => {
    await create();
    store.file!.accounts.find((a) => a.login === "pat")!.tempExpiresAt = 1;
    const r = await call("POST", "/accounts/login", { body: { login: "pat", password: "TEMP-PASSWORD-1" } });
    expect([r.status, r.json.error.code]).toEqual([401, "login_expired"]);
  });

  it("routes_require_service_token", async () => {
    for (const [m, p, body] of [
      ["GET", "/accounts"], ["GET", "/accounts/legacy"], ["POST", "/accounts", { login: "a", name: "b", role: "admin", by: null }],
      ["POST", "/accounts/login", { login: "a", password: "b" }], ["POST", "/accounts/check", { accountId: "x", epoch: 0 }],
      ["POST", "/accounts/id1/revoke", {}],
    ] as [string, string, unknown?][]) {
      for (const token of [null, "wrong"]) {
        const r = await call(m, p, { token, ...(body ? { body } : {}) });
        expect([r.status, r.json.error.code], `${m} ${p}`).toEqual([401, "unauthorized"]);
      }
    }
  });

  it("check_route_account_refused_after_revoke_is_distinct_from_bad_token", async () => {
    const issued = (await create()).json.data;
    const id = issued.account.id;
    const okr = await call("POST", "/accounts/check", { body: { accountId: id, epoch: 0 } });
    expect(okr.status).toBe(200);
    expect(okr.json.data.account.id).toBe(id);
    expect((await call("POST", `/accounts/${id}/revoke`, { body: {} })).status).toBe(200);
    const refused = await call("POST", "/accounts/check", { body: { accountId: id, epoch: 1 } });
    expect([refused.status, refused.json.error.code]).toEqual([401, "account_refused"]);
    const badToken = await call("POST", "/accounts/check", { token: "nope", body: { accountId: id, epoch: 1 } });
    expect([badToken.status, badToken.json.error.code]).toEqual([401, "unauthorized"]);
  });

  it("password_route_changes_then_refuses_the_old_epoch_and_weak_passwords", async () => {
    const a = adminAccount();
    const weak = await call("POST", "/accounts/password", { body: { accountId: a.id, epoch: 0, current: BOOT, next: "short" } });
    expect([weak.status, weak.json.error.code]).toEqual([400, "weak_password"]);
    const good = await call("POST", "/accounts/password", { body: { accountId: a.id, epoch: 0, current: BOOT, next: "a-much-better-pass" } });
    expect(good.status).toBe(200);
    expect(good.json.data.account).toMatchObject({ mustChange: false, epoch: 1 });
    const stale = await call("POST", "/accounts/password", { body: { accountId: a.id, epoch: 0, current: BOOT, next: "another-good-pass" } });
    expect([stale.status, stale.json.error.code]).toEqual([401, "account_refused"]);
    expect((await call("GET", "/accounts/legacy")).json.data).toEqual({ allowed: false });
  });

  it("issued_has_temporary_password_but_list_never_does", async () => {
    const c = await create();
    expect(c.status).toBe(200);
    expect(c.json.data.temporaryPassword).toBe("TEMP-PASSWORD-1");
    expect(c.json.data.account.status).toBe("invited");
    const list = await call("GET", "/accounts");
    expect(list.json.data.accounts.map((x: any) => [x.login, x.status])).toEqual([["admin", "active"], ["pat", "invited"]]);
    expect(list.text).not.toMatch(/TEMP-PASSWORD|password|hash|salt/i);
    const id = c.json.data.account.id;
    const again = await call("POST", `/accounts/${id}/resend`, { body: {} });
    expect(again.json.data.temporaryPassword).toBe("TEMP-PASSWORD-2");
    await call("POST", `/accounts/${id}/revoke`, { body: {} });
    const back = await call("POST", `/accounts/${id}/reinstate`, { body: {} });
    expect(back.json.data.account.status).toBe("invited");
  });

  it("reset_route_issues_for_an_active_account", async () => {
    const id = (await create()).json.data.account.id;
    await call("POST", "/accounts/login", { body: { login: "pat", password: "TEMP-PASSWORD-1" } });
    expect((await call("POST", `/accounts/${id}/reset`, { body: {} })).json.error.code).toBe("state"); // still invited
    store.file!.accounts.find((a) => a.id === id)!.status = "active";
    const r = await call("POST", `/accounts/${id}/reset`, { body: {} });
    expect(r.status).toBe(200);
    expect(r.json.data.temporaryPassword).toBe("TEMP-PASSWORD-2");
  });

  it("account_error_codes_map_to_404_409_409_400", async () => {
    expect((await call("POST", "/accounts/nobody/revoke", { body: {} })).status).toBe(404);
    await create("pat");
    const dup = await create("PAT");
    expect([dup.status, dup.json.error.code]).toEqual([409, "conflict"]);
    const id = adminAccount().id;
    const last = await call("POST", `/accounts/${id}/revoke`, { body: {} });
    expect([last.status, last.json.error.code]).toEqual([409, "conflict"]);
    const state = await call("POST", `/accounts/${id}/resend`, { body: {} });
    expect([state.status, state.json.error.code]).toEqual([409, "state"]);
    const invalid = await call("POST", "/accounts", { body: { login: "   ", name: "Pat", role: "facilitator", by: null } });
    expect([invalid.status, invalid.json.error.code]).toEqual([400, "invalid"]);
  });

  it("bodies_are_validated_and_length_limited", async () => {
    const long = "x".repeat(201);
    for (const [p, body] of [
      ["/accounts/login", { login: long, password: "a" }], ["/accounts/login", { login: "a", password: long }],
      ["/accounts/login", { login: "a" }], ["/accounts/login", { login: "a", password: "b", extra: 1 }],
      ["/accounts/check", { accountId: "x", epoch: -1 }], ["/accounts/check", { accountId: "x", epoch: 1.5 }],
      ["/accounts/password", { accountId: "x", epoch: 0, current: "a", next: long }],
      ["/accounts", { login: "a", name: long, role: "admin", by: null }], ["/accounts", { login: "a", name: "n", role: "root", by: null }],
      ["/accounts", { login: "a", name: "n", role: "admin", by: long }],
    ] as [string, unknown][]) {
      const r = await call("POST", p, { body });
      expect([r.status, r.json.error.code], p).toEqual([400, "bad_request"]);
    }
    const huge = await fetch(`http://127.0.0.1:${port}/accounts/login`, { method: "POST", headers: { "x-service-token": TOKEN, "content-type": "application/json" }, body: JSON.stringify({ login: "a", password: "p".repeat(10_000) }) });
    expect(huge.status).toBe(413);
  });

  it("legacy_route_reports_the_latch", async () => {
    expect((await call("GET", "/accounts/legacy")).json.data).toEqual({ allowed: true });
    await create();
    expect((await call("GET", "/accounts/legacy")).json.data).toEqual({ allowed: false });
  });

  it("an_unusable_accounts_file_answers_a_generic_500_with_no_detail", async () => {
    store.corrupt = true;
    for (const [m, p, body] of [
      ["POST", "/accounts/check", { accountId: "x", epoch: 0 }], ["GET", "/accounts/legacy"], ["POST", "/accounts/login", { login: "a", password: "bbbbbbbbbbbb" }],
    ] as [string, string, unknown?][]) {
      const r = await call(m, p, body ? { body } : {});
      expect(r.status, p).toBe(500);
      expect(r.json.error.code).toBe("internal");
      expect(r.text).not.toMatch(/secret|path|accounts\.json|at /);
    }
    expect(logs.join("\n")).not.toMatch(/secret|accounts\.json/);
  });

  it("unknown_account_paths_are_404", async () => {
    expect((await call("GET", "/accounts/login")).status).toBe(404);
    expect((await call("POST", "/accounts/a/explode", { body: {} })).status).toBe(404);
  });

  it("logs_never_contain_a_password_or_hash", async () => {
    const SECRET_LOGIN = "S3cret-Login-Pass";
    const NEXT = "Brand-New-Secret-77";
    await call("POST", "/accounts/login", { body: { login: "admin", password: BOOT } });
    await call("POST", "/accounts/login", { body: { login: "admin", password: SECRET_LOGIN } });
    const a = adminAccount();
    await call("POST", "/accounts/password", { body: { accountId: a.id, epoch: 0, current: BOOT, next: NEXT } });
    const c = await create();
    await call("POST", "/accounts/password", { body: { accountId: "ghost", epoch: 0, current: SECRET_LOGIN, next: NEXT } });
    await call("POST", "/accounts/check", { body: { accountId: a.id, epoch: 9 } });
    const all = logs.join("\n");
    const hashes = store.file!.accounts.flatMap((x) => [x.password.hash, x.password.salt]);
    for (const secret of [BOOT, SECRET_LOGIN, NEXT, c.json.data.temporaryPassword, ...hashes]) expect(all).not.toContain(secret);
  });
});
