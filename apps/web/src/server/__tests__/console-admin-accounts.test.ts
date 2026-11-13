import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setEnvelopeClock } from "../envelope";
import type { Deps } from "../handlers";
import { LauncherClient, LauncherError, type AccountInfo } from "../launcher-client";
import {
  handleAdminAccountAction, handleAdminAccountCreate, handleAdminAccountsList,
} from "../console-accounts";
import {
  ADMIN, FACILITATOR, FIXTURE_ORIGIN as ORIGIN, FIXTURE_T0 as T0, accountCookie, consoleAuth, fakeDeps, legacyCookie,
} from "../test-support/console-fixtures";

// US-0083 Task 7: the admin account routes. Admin accounts only (a facilitator and a legacy sign-in get 403 on every one), `by` comes from
// the cookie's account, the one-time temporary password appears only in create/resend/reset/reinstate answers, never cached.

const SAME = { Origin: ORIGIN, "X-Requested-With": "scenecoach", "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" };
const TARGET: AccountInfo = { ...FACILITATOR, id: "acc-fac-0042", login: "kim@client.example", name: "Kim Fox", status: "invited", mustChange: true, epoch: 0 };
const TEMP = "TEMP-PASSWORD-ONCE-9";
const BASE = `${ORIGIN}/api/v1/console/admin/accounts`;
const ACTIONS = ["resend", "reset", "revoke", "reinstate"] as const;

type Fake = {
  accountsList: ReturnType<typeof vi.fn>;
  accountCreate: ReturnType<typeof vi.fn>;
  accountAction: ReturnType<typeof vi.fn>;
};
function setup(over: Partial<Fake> = {}, auth = consoleAuth([ADMIN, FACILITATOR])) {
  const fake: Fake = {
    accountsList: vi.fn(async () => [ADMIN, FACILITATOR, TARGET]),
    accountCreate: vi.fn(async () => ({ account: TARGET, temporaryPassword: TEMP })),
    accountAction: vi.fn(async (_id: string, action: string) => (action === "revoke" ? {} : { account: TARGET, temporaryPassword: TEMP })),
    ...over,
  };
  const closeAccount = vi.fn(() => 0);
  const deps = fakeDeps({ auth, launcher: fake });
  (deps as { facilitatorHub: unknown }).facilitatorHub = { closeAccount, closeSession: vi.fn() };
  return { deps: deps as Deps, fake, closeAccount, auth };
}

const get = (cookie: string, url = BASE) => new Request(url, { headers: { Cookie: cookie } });
const post = (cookie: string, url: string, body: unknown = {}, headers: Record<string, string> = SAME) =>
  new Request(url, { method: "POST", headers: { ...headers, Cookie: cookie }, body: JSON.stringify(body) });
const adminCookie = () => accountCookie(ADMIN);

beforeEach(() => {
  setEnvelopeClock(() => new Date(T0));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); setEnvelopeClock(() => new Date()); });

async function every(deps: Deps, cookie: string): Promise<number[]> {
  const out = [(await handleAdminAccountsList(get(cookie), deps)).status];
  out.push((await handleAdminAccountCreate(post(cookie, BASE, { login: "a@b.example", name: "A", role: "facilitator" }), deps)).status);
  for (const a of ACTIONS) out.push((await handleAdminAccountAction(a)(post(cookie, `${BASE}/${TARGET.id}/${a}`), deps)).status);
  return out;
}

describe("admin account routes", () => {
  it("facilitator_and_legacy_get_403_on_every_admin_route", async () => {
    for (const cookie of [accountCookie(FACILITATOR), legacyCookie("Ann")]) {
      const { deps, fake, closeAccount } = setup();
      expect(await every(deps, cookie)).toEqual([403, 403, 403, 403, 403, 403]);
      expect(fake.accountsList).not.toHaveBeenCalled();
      expect(fake.accountCreate).not.toHaveBeenCalled();
      expect(fake.accountAction).not.toHaveBeenCalled();
      expect(closeAccount).not.toHaveBeenCalled();
    }
    const { deps } = setup();
    expect(await every(deps, adminCookie())).toEqual([200, 200, 200, 200, 200, 200]);
  });

  it("create_returns_temporary_password_and_list_never_does", async () => {
    const { deps, fake } = setup();
    const c = await handleAdminAccountCreate(post(adminCookie(), BASE, { login: " kim@client.example ", name: "Kim Fox", role: "facilitator" }), deps);
    expect(c.status).toBe(200);
    expect(c.headers.get("Cache-Control")).toBe("no-store");
    const cj = await c.json();
    expect(cj.data.temporaryPassword).toBe(TEMP);
    expect(cj.data.account).toMatchObject({ id: TARGET.id, login: TARGET.login });
    expect(fake.accountCreate).toHaveBeenCalledWith({ login: " kim@client.example ", name: "Kim Fox", role: "facilitator", by: ADMIN.id });
    for (const a of ["resend", "reset", "reinstate"] as const) {
      const r = await handleAdminAccountAction(a)(post(adminCookie(), `${BASE}/${TARGET.id}/${a}`), deps);
      expect(r.headers.get("Cache-Control")).toBe("no-store");
      expect((await r.json()).data.temporaryPassword).toBe(TEMP);
    }
    const l = await handleAdminAccountsList(get(adminCookie()), deps);
    const text = await l.text();
    expect(l.headers.get("Cache-Control")).toBe("no-store");
    expect(text).not.toContain(TEMP);
    expect(text).not.toContain("temporaryPassword");
    expect(JSON.parse(text).data.accounts).toHaveLength(3);
    const logged = JSON.stringify((console.error as unknown as { mock: { calls: unknown[] } }).mock.calls);
    expect(logged).not.toContain(TEMP);
  });

  it("actions_require_origin_and_header", async () => {
    const { deps, fake, closeAccount } = setup();
    const url = `${BASE}/${TARGET.id}/revoke`;
    const bad: Record<string, string>[] = [
      { ...SAME, Origin: "https://evil.example" },
      { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
      { Origin: ORIGIN, "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
      { ...SAME, "Sec-Fetch-Site": "cross-site" },
    ];
    for (const h of bad) {
      expect((await handleAdminAccountAction("revoke")(post(adminCookie(), url, {}, h), deps)).status).toBe(403);
      expect((await handleAdminAccountCreate(post(adminCookie(), BASE, { login: "a", name: "b", role: "admin" }, h), deps)).status).toBe(403);
    }
    expect(fake.accountAction).not.toHaveBeenCalled();
    expect(fake.accountCreate).not.toHaveBeenCalled();
    expect(closeAccount).not.toHaveBeenCalled();
  });

  it("revoke_last_admin_returns_the_conflict_message", async () => {
    const { deps, closeAccount } = setup({ accountAction: vi.fn(async () => { throw new LauncherError("conflict"); }) });
    const r = await handleAdminAccountAction("revoke")(post(adminCookie(), `${BASE}/${ADMIN.id}/revoke`), deps);
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.error.code).toBe("conflict");
    expect(j.error.message).toMatch(/last active admin/i);
    expect(closeAccount).not.toHaveBeenCalled();
    const d = setup({ accountCreate: vi.fn(async () => { throw new LauncherError("conflict"); }) });
    const dup = await handleAdminAccountCreate(post(adminCookie(), BASE, { login: "x", name: "y", role: "admin" }), d.deps);
    expect(dup.status).toBe(409);
    expect((await dup.json()).error.message).toMatch(/already/i);
  });

  it("control_failures_map_to_statuses", async () => {
    for (const [reason, status] of [["not_found", 404], ["state", 409], ["invalid", 400], ["unavailable", 502], ["timeout", 502], ["failed", 502]] as const) {
      const { deps } = setup({ accountAction: vi.fn(async () => { throw new LauncherError(reason); }) });
      const r = await handleAdminAccountAction("reset")(post(adminCookie(), `${BASE}/${TARGET.id}/reset`), deps);
      expect(r.status, reason).toBe(status);
      expect(await r.text()).not.toContain(TEMP);
    }
    const { deps } = setup({ accountCreate: vi.fn(async () => { throw new LauncherError("invalid"); }) });
    expect((await handleAdminAccountCreate(post(adminCookie(), BASE, { login: "x", name: "y", role: "admin" }), deps)).status).toBe(400);
  });

  it("by_comes_from_the_cookie_not_the_body", async () => {
    const { deps, fake } = setup();
    const r = await handleAdminAccountCreate(post(adminCookie(), BASE, { login: "n@x.example", name: "N", role: "admin", by: "someone-else" }), deps);
    expect(r.status).toBe(200);
    expect(fake.accountCreate).toHaveBeenCalledTimes(1);
    expect(fake.accountCreate.mock.calls[0]![0].by).toBe(ADMIN.id);
    expect(JSON.stringify(fake.accountCreate.mock.calls[0])).not.toContain("someone-else");
  });

  it("revoke_closes_that_accounts_streams", async () => {
    const { deps, closeAccount } = setup();
    for (const a of ["revoke", "reset", "reinstate"] as const) {
      closeAccount.mockClear();
      const r = await handleAdminAccountAction(a)(post(adminCookie(), `${BASE}/${TARGET.id}/${a}`), deps);
      expect(r.status).toBe(200);
      expect(closeAccount).toHaveBeenCalledExactlyOnceWith(TARGET.id);
    }
    closeAccount.mockClear();
    await handleAdminAccountAction("resend")(post(adminCookie(), `${BASE}/${TARGET.id}/resend`), deps);
    expect(closeAccount).not.toHaveBeenCalled();
    // a throw while ending streams must not turn a recorded change into an error
    closeAccount.mockImplementation(() => { throw new Error("boom"); });
    const r = await handleAdminAccountAction("revoke")(post(adminCookie(), `${BASE}/${TARGET.id}/revoke`), deps);
    expect(r.status).toBe(200);
  });

  it("admin_route_blocked_while_must_change", async () => {
    const stuck = { ...ADMIN, mustChange: true };
    const { deps, fake } = setup({}, consoleAuth([stuck, FACILITATOR]));
    expect(await every(deps, accountCookie(stuck))).toEqual([403, 403, 403, 403, 403, 403]);
    expect(fake.accountsList).not.toHaveBeenCalled();
    expect(fake.accountAction).not.toHaveBeenCalled();
  });

  it("validates_ids_and_bodies_before_any_control_call", async () => {
    const { deps, fake } = setup();
    for (const id of ["", "x".repeat(65), "a%00b", "a%1fb"]) {
      const r = await handleAdminAccountAction("revoke")(post(adminCookie(), `${BASE}/${id}/revoke`), deps);
      expect(r.status, id).toBe(404);
    }
    expect(fake.accountAction).not.toHaveBeenCalled();
    const bodies: unknown[] = [
      { login: "a", name: "b" }, { login: "a", name: "b", role: "owner" }, { login: "a", name: "b", role: "admin", extra: 1 },
      { login: 1, name: "b", role: "admin" }, { login: "x".repeat(201), name: "b", role: "admin" }, { login: "a", name: "x".repeat(201), role: "admin" },
      { login: "", name: "b", role: "admin" }, { login: "a", name: "  ", role: "admin" }, [],
    ];
    for (const b of bodies) expect((await handleAdminAccountCreate(post(adminCookie(), BASE, b), deps)).status, JSON.stringify(b)).toBe(400);
    const big = await handleAdminAccountCreate(post(adminCookie(), BASE, { login: "a", name: "b", role: "admin", pad: "x".repeat(5000) }), deps);
    expect(big.status).toBe(400);
    expect((await handleAdminAccountAction("reset")(post(adminCookie(), `${BASE}/${TARGET.id}/reset`, { a: 1 }), deps)).status).toBe(400);
    expect(fake.accountCreate).not.toHaveBeenCalled();
    expect(fake.accountAction).not.toHaveBeenCalled();
  });

  it("route_files_export_the_handlers", async () => {
    const root = path.resolve(__dirname, "../../app/api/v1/console/admin/accounts");
    const files: string[] = [];
    const walk = (d: string): void => { for (const n of readdirSync(d)) { const p = path.join(d, n); if (statSync(p).isDirectory()) walk(p); else if (n === "route.ts") files.push(path.relative(root, p)); } };
    walk(root);
    expect(files.sort()).toEqual(["[id]/reinstate/route.ts", "[id]/resend/route.ts", "[id]/reset/route.ts", "[id]/revoke/route.ts", "route.ts"]);
    const top = (await import(path.join(root, "route.ts"))) as Record<string, unknown>;
    expect(typeof top.GET).toBe("function");
    expect(typeof top.POST).toBe("function");
    for (const a of ACTIONS) expect(typeof ((await import(path.join(root, "[id]", a, "route.ts"))) as Record<string, unknown>).POST).toBe("function");
  });
});

describe("LauncherClient account admin calls", () => {
  const client = (fetchFn: typeof fetch) => new LauncherClient({ baseUrl: "http://127.0.0.1:1", token: "t".repeat(20), fetch: fetchFn });
  const env = (data: unknown, status = 200) => new Response(JSON.stringify({ success: status < 300, data: status < 300 ? data : null, error: status < 300 ? null : data, meta: {} }), { status });
  it("creates, acts, and maps the state code", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const c = client((async (u: string, init?: RequestInit) => { seen.push({ url: String(u), init }); return env({ account: TARGET, temporaryPassword: TEMP }); }) as unknown as typeof fetch);
    const made = await c.accountCreate({ login: "a", name: "b", role: "admin", by: ADMIN.id });
    expect(made.temporaryPassword).toBe(TEMP);
    expect(JSON.parse(String(seen[0]!.init!.body))).toEqual({ login: "a", name: "b", role: "admin", by: ADMIN.id });
    expect((await c.accountAction("acc 1/x", "reset")).temporaryPassword).toBe(TEMP);
    expect(seen[1]!.url).toBe("http://127.0.0.1:1/accounts/acc%201%2Fx/reset");
    await expect(c.accountAction("", "reset")).rejects.toMatchObject({ reason: "not_found" });
    await expect(c.accountAction("x".repeat(65), "reset")).rejects.toMatchObject({ reason: "not_found" });
    const revoked = await client((async () => env({})) as unknown as typeof fetch).accountAction("a1", "revoke");
    expect(revoked).toEqual({});
    const st = client((async () => env({ code: "state", message: "the account is revoked" }, 409)) as unknown as typeof fetch);
    await expect(st.accountAction("a1", "resend")).rejects.toMatchObject({ reason: "state" });
    const junk = client((async () => env({ account: TARGET, temporaryPassword: 5 })) as unknown as typeof fetch);
    await expect(junk.accountAction("a1", "reset")).rejects.toMatchObject({ reason: "failed" });
  });
});
