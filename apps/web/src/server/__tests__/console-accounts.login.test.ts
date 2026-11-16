import { afterEach, describe, expect, it, vi } from "vitest";
import { handleConsoleLogin, handleConsolePassword, requireConsole } from "../console-handlers";
import { openConsoleCookie } from "../console-session";
import { LauncherError, type AccountInfo } from "../launcher-client";
import {
  ADMIN, FACILITATOR, FIXTURE_ORIGIN, FIXTURE_SECRET, FIXTURE_T0, accountCookie, fakeDeps, legacyCookie,
} from "../test-support/console-fixtures";
import { JoinThrottle } from "../throttle";
import type { Deps } from "../handlers";

// US-0083 Task 5b: account sign-in (login + password, or the legacy secret while the latch is open) and the password change.

const guarded = { Origin: FIXTURE_ORIGIN, "X-Requested-With": "scenecoach", "Content-Type": "application/json", "X-Forwarded-For": "198.51.100.7" };
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${FIXTURE_ORIGIN}${path}`, { method: "POST", headers: { ...guarded, ...headers }, body: JSON.stringify(body) });
const login = (body: unknown, headers: Record<string, string> = {}) => post("/api/v1/console/login", body, headers);
const password = (body: unknown, cookie: string, headers: Record<string, string> = {}) => post("/api/v1/console/password", body, { Cookie: cookie, ...headers });
const cookieValue = (res: Response) => /^[^=]+=([^;]*)/.exec(res.headers.get("Set-Cookie") ?? "")?.[1] ?? "";
const PW = "right-password-123";
const NEW_PW = "brand-new-password-456";

type Fake = { accountLogin: ReturnType<typeof vi.fn>; accountChangePassword: ReturnType<typeof vi.fn> };
function setup(over: { loginError?: LauncherError; info?: AccountInfo } = {}) {
  const info = over.info ?? FACILITATOR;
  const accountLogin = vi.fn(async (l: string, p: string) => {
    if (over.loginError) throw over.loginError;
    if (l.toLowerCase() !== info.login || p !== PW) throw new LauncherError("login_refused");
    return { ...info };
  });
  const accountChangePassword = vi.fn(async (id: string, epoch: number, current: string, next: string) => {
    // Control's real answers: a revoked or stale account and a wrong current password are both `account_refused`.
    if (id !== info.id || epoch !== info.epoch || current !== PW) throw new LauncherError("account_refused");
    if (next.length < 12) throw new LauncherError("weak_password");
    deps.auth.bump(id, { mustChange: false });
    return { ...info, epoch: info.epoch + 1, mustChange: false };
  });
  const closeAccount = vi.fn(() => 0);
  const deps = fakeDeps({
    launcher: { accountLogin, accountChangePassword },
    facilitatorHub: { closeAccount } as unknown as Deps["facilitatorHub"],
    consoleLoginThrottle: new JoinThrottle({ max: 5, windowMs: 60_000, blockMs: 60_000, now: () => FIXTURE_T0 }),
  });
  return { deps, accountLogin, accountChangePassword, closeAccount } as { deps: Deps & { auth: ReturnType<typeof fakeDeps>["auth"] } } & Fake & { closeAccount: ReturnType<typeof vi.fn> };
}

afterEach(() => vi.restoreAllMocks());

describe("console account sign-in", () => {
  it("login_with_account_sets_sealed_cookie_and_returns_role", async () => {
    const { deps, accountLogin } = setup();
    const res = await handleConsoleLogin(login({ login: "Dana@Client.example", password: PW }), deps);
    expect(res.status).toBe(200);
    const sc = res.headers.get("Set-Cookie")!;
    for (const a of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/", `Max-Age=${12 * 3600}`]) expect(sc).toContain(a);
    expect((await res.json()).data).toEqual({ name: "Dana Cook", role: "facilitator", mustChange: false });
    expect(openConsoleCookie(cookieValue(res), deps.config, FIXTURE_T0)).toEqual({
      kind: "account", accountId: FACILITATOR.id, epoch: FACILITATOR.epoch, name: "Dana Cook", expiresAt: FIXTURE_T0 + 12 * 3_600_000,
    });
    expect(accountLogin).toHaveBeenCalledWith("Dana@Client.example", PW);
  });

  it("works with no FACILITATOR_SECRET set (accounts only)", async () => {
    const { deps } = setup();
    deps.config = { ...deps.config, facilitatorSecret: undefined };
    expect((await handleConsoleLogin(login({ login: FACILITATOR.login, password: PW }), deps)).status).toBe(200);
  });

  it("wrong_password_is_neutral_401_and_charges_address_and_login", async () => {
    const { deps } = setup();
    const addr = vi.spyOn(deps.consoleThrottle, "fail");
    const glob = vi.spyOn(deps.consoleGlobalThrottle, "fail");
    const lg = vi.spyOn(deps.consoleLoginThrottle, "fail");
    const res = await handleConsoleLogin(login({ login: "Dana@Client.example", password: "nope-nope-nope" }), deps);
    expect(res.status).toBe(401);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    const text = await res.text();
    const unknown = await (await handleConsoleLogin(login({ login: "nobody@x.example", password: "nope-nope-nope" }), deps)).text();
    expect(JSON.parse(text).error.code).toBe("login_refused");
    expect(JSON.parse(text).error.message).toBe(JSON.parse(unknown).error.message);
    expect(text).not.toContain("nope-nope-nope");
    expect(addr).toHaveBeenCalledWith("198.51.100.7", "console");
    expect(glob).toHaveBeenCalledTimes(2);
    expect(lg).toHaveBeenCalledWith("dana@client.example", "login");
  });

  it("the sixth wrong password for one login is throttled even from a fresh address, and the right one is blocked too", async () => {
    const { deps, accountLogin } = setup();
    for (let i = 0; i < 5; i++) {
      expect((await handleConsoleLogin(login({ login: FACILITATOR.login, password: `bad-${i}-bad-bad` }, { "X-Forwarded-For": `203.0.113.${i}` }), deps)).status).toBe(401);
    }
    const sixth = await handleConsoleLogin(login({ login: FACILITATOR.login.toUpperCase(), password: "bad-6-bad-bad" }, { "X-Forwarded-For": "203.0.113.99" }), deps);
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get("Retry-After")).toBeTruthy();
    accountLogin.mockClear();
    const right = await handleConsoleLogin(login({ login: FACILITATOR.login, password: PW }, { "X-Forwarded-For": "203.0.113.150" }), deps);
    expect(right.status).toBe(429);
    expect(accountLogin).not.toHaveBeenCalled();
  });

  it("expired_temporary_password_message_only_after_right_password", async () => {
    const { deps } = setup({ loginError: new LauncherError("login_expired") });
    const res = await handleConsoleLogin(login({ login: FACILITATOR.login, password: PW }), deps);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("login_expired");
    expect(body.error.message).toMatch(/expired/i);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    // a right password is not a guess: it is not charged
    expect(deps.consoleThrottle.blockedForMs("198.51.100.7", "console")).toBe(0);
    const wrong = setup();
    const w = await (await handleConsoleLogin(login({ login: FACILITATOR.login, password: "wrong-wrong-wrong" }), wrong.deps)).json();
    expect(w.error.code).toBe("login_refused");
    expect(w.error.message).not.toMatch(/expired/i);
  });

  it("an unreachable control service answers 502 and charges nothing", async () => {
    const { deps } = setup({ loginError: new LauncherError("unavailable") });
    const res = await handleConsoleLogin(login({ login: FACILITATOR.login, password: PW }), deps);
    expect(res.status).toBe(502);
    expect(deps.consoleThrottle.blockedForMs("198.51.100.7", "console")).toBe(0);
  });

  it("legacy secret login still works while the latch is open", async () => {
    const { deps } = setup();
    const res = await handleConsoleLogin(login({ secret: FIXTURE_SECRET, name: "Ann Lee" }), deps);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ name: "Ann Lee" });
  });

  it("legacy_login_refused_after_the_latch_closes", async () => {
    const { deps } = setup();
    const wrongSecret = await handleConsoleLogin(login({ secret: "wrong wrong wrong!!", name: "Ann" }), deps);
    deps.auth.closeLatch();
    const res = await handleConsoleLogin(login({ secret: FIXTURE_SECRET, name: "Ann" }), deps);
    expect(res.status).toBe(401);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(await res.json()).toEqual({ ...(await wrongSecret.json()), meta: expect.anything() });
  });

  it("legacy login fails closed with 502 when the latch cannot be read", async () => {
    const { deps } = setup();
    deps.auth.down();
    const res = await handleConsoleLogin(login({ secret: FIXTURE_SECRET, name: "Ann" }), deps);
    expect(res.status).toBe(502);
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  it("keeps the origin, fetch-metadata and address-throttle protections", async () => {
    const { deps, accountLogin } = setup();
    expect((await handleConsoleLogin(login({ login: FACILITATOR.login, password: PW }, { Origin: "https://evil.example" }), deps)).status).toBe(403);
    expect((await handleConsoleLogin(login({ login: FACILITATOR.login, password: PW }, { "Sec-Fetch-Site": "cross-site" }), deps)).status).toBe(403);
    for (let i = 0; i < 6; i++) await handleConsoleLogin(login({ login: `u${i}@x.example`, password: "bad-bad-bad-bad" }), deps);
    accountLogin.mockClear();
    expect((await handleConsoleLogin(login({ login: FACILITATOR.login, password: PW }), deps)).status).toBe(429);
    expect(accountLogin).not.toHaveBeenCalled();
  });

  it("rejects malformed and over-long fields with 400 before control is asked", async () => {
    const { deps, accountLogin } = setup();
    for (const body of [{}, { login: "a" }, { login: 1, password: "x" }, { login: "a".repeat(201), password: PW }, { login: "a", password: "p".repeat(201) }, { login: "", password: PW }]) {
      expect((await handleConsoleLogin(login(body), deps)).status).toBe(400);
    }
    expect(accountLogin).not.toHaveBeenCalled();
  });

  it("no_secret_or_password_in_any_response_or_log", async () => {
    const { deps } = setup();
    const logs: string[] = [];
    for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
    const texts: string[] = [];
    const take = async (r: Response) => { texts.push(await r.text(), [...r.headers].filter(([k]) => k.toLowerCase() !== "set-cookie").join("|")); };
    await take(await handleConsoleLogin(login({ login: FACILITATOR.login, password: "secret-guess-999" }), deps));
    await take(await handleConsoleLogin(login({ login: FACILITATOR.login, password: PW }), deps));
    await take(await handleConsoleLogin(login({ secret: "secret-guess-888", name: "Ann" }), deps));
    await take(await handleConsoleLogin(login({ secret: FIXTURE_SECRET, name: "Ann" }), deps));
    const cookie = accountCookie(FACILITATOR);
    await take(await handleConsolePassword(password({ current: PW, next: NEW_PW }, cookie), deps));
    await take(await handleConsolePassword(password({ current: "secret-guess-777", next: "also-secret-555-xx" }, cookie), deps));
    for (const s of [...texts, ...logs]) for (const v of ["secret-guess", PW, NEW_PW, FIXTURE_SECRET, "also-secret"]) expect(s).not.toContain(v);
  });
});

describe("console password change", () => {
  it("change_password_reseals_cookie_old_cookie_fails_two_tabs_second_gets_401", async () => {
    const { deps, accountChangePassword, closeAccount } = setup();
    const old = accountCookie(FACILITATOR);
    const res = await handleConsolePassword(password({ current: PW, next: NEW_PW }, old), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { name: "Dana Cook", role: "facilitator", mustChange: false } });
    expect(accountChangePassword).toHaveBeenCalledWith(FACILITATOR.id, FACILITATOR.epoch, PW, NEW_PW);
    expect(closeAccount).toHaveBeenCalledWith(FACILITATOR.id);
    const fresh = openConsoleCookie(cookieValue(res), deps.config, FIXTURE_T0);
    expect(fresh).toMatchObject({ kind: "account", accountId: FACILITATOR.id, epoch: FACILITATOR.epoch + 1, name: "Dana Cook" });
    expect(res.headers.get("Set-Cookie")).toContain("HttpOnly");
    // the new cookie works; the second tab still holding the old one is refused and cleared
    const next = new Request(`${FIXTURE_ORIGIN}/api/v1/console/sessions`, { headers: { Cookie: `__Host-scenecoach-fac=${cookieValue(res)}` } });
    expect(await requireConsole(next, deps)).toMatchObject({ accountId: FACILITATOR.id });
    const tab2 = await requireConsole(new Request(`${FIXTURE_ORIGIN}/api/v1/console/sessions`, { headers: { Cookie: old } }), deps);
    expect((tab2 as Response).status).toBe(401);
    expect((tab2 as Response).headers.get("Set-Cookie")).toContain("Max-Age=0");
    // and the second tab changing the password with its old cookie also gets 401
    deps.auth.bump(FACILITATOR.id);
    expect((await handleConsolePassword(password({ current: PW, next: NEW_PW }, old), deps)).status).toBe(401);
  });

  it("is reachable while the account must change its password", async () => {
    const info = { ...FACILITATOR, mustChange: true };
    const { deps } = setup({ info });
    deps.auth.set(info);
    const res = await handleConsolePassword(password({ current: PW, next: NEW_PW }, accountCookie(info)), deps);
    expect(res.status).toBe(200);
  });

  it("refuses a legacy cookie with 403 and an anonymous caller with 401", async () => {
    const { deps, accountChangePassword } = setup();
    expect((await handleConsolePassword(password({ current: PW, next: NEW_PW }, legacyCookie("Ann")), deps)).status).toBe(403);
    expect((await handleConsolePassword(password({ current: PW, next: NEW_PW }, ""), deps)).status).toBe(401);
    expect(accountChangePassword).not.toHaveBeenCalled();
  });

  it("checks Origin and Fetch-Metadata, and validates the body", async () => {
    const { deps, accountChangePassword } = setup();
    const c = accountCookie(FACILITATOR);
    expect((await handleConsolePassword(password({ current: PW, next: NEW_PW }, c, { Origin: "https://evil.example" }), deps)).status).toBe(403);
    expect((await handleConsolePassword(password({ current: PW, next: NEW_PW }, c, { "Sec-Fetch-Site": "cross-site" }), deps)).status).toBe(403);
    for (const body of [{}, { current: PW }, { current: 1, next: "x" }, { current: "a".repeat(201), next: NEW_PW }, { current: PW, next: "n".repeat(201) }, { current: PW, next: "" }]) {
      expect((await handleConsolePassword(password(body, c), deps)).status).toBe(400);
    }
    expect(accountChangePassword).not.toHaveBeenCalled();
  });

  it("wrong current with a valid account: 403, cookie kept, charged per account and eventually throttled", async () => {
    const { deps, closeAccount } = setup();
    const c = accountCookie(FACILITATOR);
    for (let i = 0; i < 5; i++) {
      const r = await handleConsolePassword(password({ current: `wrong-${i}-wrong`, next: NEW_PW }, c), deps);
      expect(r.status).toBe(403);
      expect((await r.json()).error.code).toBe("wrong_password");
      expect(r.headers.get("Set-Cookie")).toBeNull();
    }
    const sixth = await handleConsolePassword(password({ current: "wrong-6-wrong", next: NEW_PW }, c), deps);
    expect(sixth.status).toBe(429);
    expect(sixth.headers.get("Set-Cookie")).toBeNull();
    // blocked even with the right current password
    expect((await handleConsolePassword(password({ current: PW, next: NEW_PW }, c), deps)).status).toBe(429);
    expect(closeAccount).not.toHaveBeenCalled();
  });

  it("revoked or stale account during the change: 401 and the cookie is cleared", async () => {
    const { deps, closeAccount } = setup();
    const c = accountCookie(FACILITATOR);
    deps.auth.revoke(FACILITATOR.id);
    // requireConsole already refuses; also cover the race where it passes and control then refuses
    const racing = setup();
    racing.accountChangePassword.mockImplementationOnce(async () => { racing.deps.auth.revoke(FACILITATOR.id); throw new LauncherError("account_refused"); });
    const r = await handleConsolePassword(password({ current: PW, next: NEW_PW }, c), racing.deps);
    expect(r.status).toBe(401);
    expect(r.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect((await handleConsolePassword(password({ current: PW, next: NEW_PW }, c), deps)).status).toBe(401);
    expect(closeAccount).not.toHaveBeenCalled();
  });

  it("accountCheck unavailable while classifying a refusal: 502 and the cookie is kept", async () => {
    const t = setup();
    t.accountChangePassword.mockImplementationOnce(async () => { t.deps.auth.down(); throw new LauncherError("account_refused"); });
    const r = await handleConsolePassword(password({ current: "wrong-wrong-wrong", next: NEW_PW }, accountCookie(FACILITATOR)), t.deps);
    expect(r.status).toBe(502);
    expect(r.headers.get("Set-Cookie")).toBeNull();
  });

  it("maps control's refusals: weak password 400, wrong current 403 (cookie kept), unreachable 502", async () => {
    const { deps } = setup();
    const c = accountCookie(FACILITATOR);
    const weak = await handleConsolePassword(password({ current: PW, next: "short" }, c), deps);
    expect(weak.status).toBe(400);
    expect((await weak.json()).error.code).toBe("weak_password");
    const wrong = await handleConsolePassword(password({ current: "not-the-password", next: NEW_PW }, c), deps);
    expect(wrong.status).toBe(403);
    expect(wrong.headers.get("Set-Cookie")).toBeNull();
    const down = setup();
    down.accountChangePassword.mockRejectedValueOnce(new LauncherError("unavailable"));
    const res = await handleConsolePassword(password({ current: PW, next: NEW_PW }, c), down.deps);
    expect(res.status).toBe(502);
    expect(down.closeAccount).not.toHaveBeenCalled();
  });

  it("valid_cookie_bypasses_address_throttle", async () => {
    const { deps } = setup();
    // saturate the address and global login throttles
    for (let i = 0; i < 25; i++) await handleConsoleLogin(login({ login: `u${i}@x.example`, password: "bad-bad-bad-bad" }, { "X-Forwarded-For": `203.0.113.${i}` }), deps);
    expect(deps.consoleThrottle.blockedForMs("198.51.100.7", "console")).toBe(0);
    for (let i = 0; i < 10; i++) deps.consoleThrottle.fail("198.51.100.7", "console");
    expect(deps.consoleThrottle.blockedForMs("198.51.100.7", "console")).toBeGreaterThan(0);
    const spy = vi.spyOn(deps.consoleThrottle, "blockedForMs");
    const res = await handleConsolePassword(password({ current: PW, next: NEW_PW }, accountCookie(FACILITATOR)), deps);
    expect(res.status).toBe(200);
    const other = await requireConsole(new Request(`${FIXTURE_ORIGIN}/api/v1/console/sessions`, { headers: { Cookie: accountCookie(ADMIN) } }), deps);
    expect(other).toMatchObject({ accountId: ADMIN.id });
    expect(spy).not.toHaveBeenCalled();
  });
});
