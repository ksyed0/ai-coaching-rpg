import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, missingConsoleVars } from "../config";
import { handleConsoleLogout, requireConsole, type ConsoleCaller } from "../console-handlers";
import { handleConsoleAiRoles } from "../console-ai";
import { handleConsoleCommand } from "../console-command";
import { CONSOLE_COOKIE } from "../console-session";
import { handleConsoleSessionsList, handleConsoleStart } from "../console-sessions";
import { handleConsoleStream } from "../console-stream";
import { setEnvelopeClock } from "../envelope";
import { consoleRecheck, FacilitatorHub } from "../facilitator-hub";
import type { Deps } from "../handlers";
import { handleConsoleReportLinks } from "../report-handlers";
import { CONSOLE_PASSWORD_PATH, adminPageRedirect, consolePageRedirect, consoleView } from "../routes";
import { HEARTBEAT_MS } from "../sse";
import {
  ADMIN, FACILITATOR, FIXTURE_ORIGIN as ORIGIN, FIXTURE_T0 as T0, accountCookie, accountCookieValue, consoleAuth, consoleConfig, fakeDeps,
  legacyCookie, legacyCookieValue, type ConsoleAuth,
} from "../test-support/console-fixtures";
import { seal } from "../seal";
import { FIXTURE_KEYS } from "../test-support/console-fixtures";
import { FakeConn, manualTimers, sseReader, until } from "./fakes";

// US-0083 Task 5a: every console request, server page and open stream re-checks the account with the control service.

const SID = "s-0123456789abcdef";
const SAME = { Origin: ORIGIN, "X-Requested-With": "scenecoach", "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" };

const get = (path: string, cookie: string | null, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${path}`, { headers: { ...(cookie !== null && { Cookie: cookie }), ...headers } });
const post = (path: string, cookie: string | null, body: unknown = {}) =>
  new Request(`${ORIGIN}${path}`, { method: "POST", headers: { ...SAME, ...(cookie !== null && { Cookie: cookie }) }, body: JSON.stringify(body) });
const cleared = (res: Response) => (res.headers.get("Set-Cookie") ?? "").includes("Max-Age=0");
const codeOf = async (res: Response) => ((await res.clone().json()) as { error?: { code?: string } }).error?.code;

/** A facilitator connection whose join answers like the runtime's. */
class FacConn extends FakeConn {
  async joinFacilitator() {
    return {
      frame: { type: "joined" as const, roleId: "facilitator", scenes: [], replay: { afterSeq: 0, toSeq: 0, events: 0, complete: true }, state: { status: "running", lastSeq: 0 } as never },
      roster: [], status: "running" as const,
    };
  }
  override close() { super.close(); queueMicrotask(() => this.drop(1000)); }
}

let readers: ReturnType<typeof sseReader>[] = [];
beforeEach(() => {
  setEnvelopeClock(() => new Date(T0));
  readers = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  for (const r of readers) await r.cancel().catch(() => {});
  vi.restoreAllMocks();
  setEnvelopeClock(() => new Date());
});

/** Deps whose stream route works end to end: a fake runtime, manual timers, and the hub re-checking through `auth`. */
function streamDeps(auth: ConsoleAuth = consoleAuth()) {
  const timers = manualTimers();
  const conns: FacConn[] = [];
  const deps = fakeDeps({
    auth,
    connect: (async () => { const c = new FacConn(); conns.push(c); return c; }) as unknown as Deps["connect"],
    facilitatorHub: new FacilitatorHub({ setTimer: timers.setTimer, now: () => T0, recheck: consoleRecheck(auth.launcher) }),
    setTimer: timers.setTimer,
    launcher: {
      // US-0083 Task 6: owned by FACILITATOR, so its stream opens (admins and legacy open any session's stream).
      session: vi.fn(async () => ({ sessionId: SID, scenarioId: "pitch", status: "running", port: 1, owner: FACILITATOR.id })),
      facilitator: vi.fn(async () => ({ port: 43_211, token: "facilitator-token-" + "f".repeat(20) })),
    },
  });
  return { deps, timers, conns };
}
const streamReq = (cookie: string) =>
  new Request(`${ORIGIN}/api/v1/console/sessions/${SID}/stream`, { headers: { Accept: "text/event-stream", "Sec-Fetch-Site": "same-origin", Cookie: cookie } });
async function openStream(deps: Deps, cookie: string) {
  const res = await handleConsoleStream(streamReq(cookie), deps);
  expect(res.status).toBe(200);
  const r = sseReader(res);
  readers.push(r);
  await until(() => r.frames().some((f) => f.event === "roster"), { what: "the roster frame" });
  return r;
}
/** Lets the heartbeat's re-check (a resolved promise chain) settle. */
const settle = () => new Promise<void>((r) => setImmediate(r));

describe("console re-check (US-0083)", () => {
  it("test_console_recheck_guard_rechecks_account_on_every_request_and_clears_a_refused_cookie", async () => {
    const deps = fakeDeps({ launcher: { sessions: vi.fn(async () => []) } });
    const cookie = accountCookie(ADMIN);
    const list = () => handleConsoleSessionsList(get("/api/v1/console/sessions", cookie), deps);
    expect((await list()).status).toBe(200);
    expect((await list()).status).toBe(200);
    expect(deps.auth.accountCheck).toHaveBeenCalledTimes(2);
    expect(deps.auth.accountCheck).toHaveBeenLastCalledWith(ADMIN.id, ADMIN.epoch);

    // A revoke (or a reset / password change: both bump the epoch) refuses the very next request, and the cookie is cleared.
    deps.auth.revoke(ADMIN.id);
    const res = await list();
    expect(res.status).toBe(401);
    expect(cleared(res)).toBe(true);
    deps.auth.set(ADMIN);
    deps.auth.bump(ADMIN.id);
    const bumped = await requireConsole(get("/api/v1/console/x", cookie), deps);
    expect((bumped as Response).status).toBe(401);
    expect(cleared(bumped as Response)).toBe(true);

    // The caller is the account as control has it now (name, role), never a value only the cookie claims.
    deps.auth.set({ ...FACILITATOR, name: "Dana C." });
    const who = (await requireConsole(get("/api/v1/console/x", accountCookie({ ...FACILITATOR, name: "Old Name" })), deps)) as ConsoleCaller;
    expect(who).toMatchObject({ name: "Dana C.", role: "facilitator", accountId: FACILITATOR.id, legacy: false, mustChange: false, epoch: FACILITATOR.epoch });

    // No cookie: 401 with nothing to clear. A cookie that does not open, or with an unknown kind: 401, cleared, control not asked.
    const calls = deps.auth.accountCheck.mock.calls.length;
    const none = await requireConsole(get("/api/v1/console/x", null), deps);
    expect((none as Response).status).toBe(401);
    expect(cleared(none as Response)).toBe(false);
    const odd = seal({ kind: "robot", accountId: ADMIN.id, epoch: 1, name: "x", expiresAt: T0 + 60_000 }, FIXTURE_KEYS, T0, "fac");
    for (const v of ["junk", odd]) {
      const r = (await requireConsole(get("/api/v1/console/x", `${CONSOLE_COOKIE}=${v}`), deps)) as Response;
      expect(r.status).toBe(401);
      expect(cleared(r)).toBe(true);
    }
    expect(deps.auth.accountCheck.mock.calls.length).toBe(calls);
  });

  it("test_console_recheck_control_unreachable_answers_502_and_keeps_the_cookie", async () => {
    const { deps } = streamDeps();
    deps.auth.down();
    for (const cookie of [accountCookie(ADMIN), legacyCookie("Ann Lee")]) {
      const direct = (await requireConsole(get("/api/v1/console/x", cookie), deps)) as Response;
      const routed = await handleConsoleSessionsList(get("/api/v1/console/sessions", cookie), deps);
      const streamed = await handleConsoleStream(streamReq(cookie), deps);
      for (const r of [direct, routed, streamed]) {
        expect(r.status).toBe(502);
        expect(r.headers.get("Set-Cookie")).toBeNull();
        expect(await codeOf(r)).toBe("launcher_unavailable");
      }
    }
    // Once control answers again the same cookie works: nothing was cleared or remembered.
    deps.auth.down(false);
    expect(await requireConsole(get("/api/v1/console/x", accountCookie(ADMIN)), deps)).toMatchObject({ accountId: ADMIN.id });
  });

  it("test_console_recheck_legacy_cookie_without_kind_works_only_while_the_latch_is_open", async () => {
    const deps = fakeDeps();
    const cookie = legacyCookie("Ann Lee");
    expect(await requireConsole(get("/api/v1/console/x", cookie), deps)).toEqual({
      name: "Ann Lee", role: "admin", accountId: null, legacy: true, mustChange: false, epoch: null, expiresAt: T0 + 3_600_000,
    });
    expect(deps.auth.accountCheck).not.toHaveBeenCalled();
    deps.auth.closeLatch();
    const res = (await requireConsole(get("/api/v1/console/x", cookie), deps)) as Response;
    expect(res.status).toBe(401);
    expect(cleared(res)).toBe(true);
    // An account cookie is unaffected by the latch.
    expect(await requireConsole(get("/api/v1/console/x", accountCookie(ADMIN)), deps)).toMatchObject({ legacy: false, role: "admin" });
    // A legacy cookie from another secret never reaches control.
    const open = fakeDeps();
    const other = (await requireConsole(get("/api/v1/console/x", legacyCookie("Ann", { secret: "an older secret entirely" })), open)) as Response;
    expect(other.status).toBe(401);
    expect(open.auth.legacyAllowed).not.toHaveBeenCalled();
  });

  it("test_console_recheck_must_change_blocks_every_route_including_the_stream_except_password_and_logout", async () => {
    const auth = consoleAuth([{ ...ADMIN, mustChange: true }]);
    const { deps, conns } = streamDeps(auth);
    const cookie = accountCookie(ADMIN);
    const base = `/api/v1/console/sessions/${SID}`;
    const answers: [string, Response][] = [
      ["list", await handleConsoleSessionsList(get("/api/v1/console/sessions", cookie), deps)],
      ["start", await handleConsoleStart(post(`${base}/start`, cookie), deps)],
      ["command", await handleConsoleCommand(post(`${base}/command`, cookie, { channel: "c", command: { kind: "pause" } }), deps)],
      ["ai-roles", await handleConsoleAiRoles(post(`${base}/ai-roles`, cookie, { roles: [] }), deps)],
      ["report-links", await handleConsoleReportLinks(get(`${base}/report-links`, cookie), deps)],
      ["stream", await handleConsoleStream(streamReq(cookie), deps)],
    ];
    for (const [name, res] of answers) {
      expect(res.status, name).toBe(403);
      expect(await codeOf(res), name).toBe("must_change_password");
      expect(res.headers.get("Set-Cookie"), name).toBeNull();
    }
    expect(conns).toHaveLength(0);
    // The password-change route and logout are the exceptions.
    expect(await requireConsole(post("/api/v1/console/password", cookie), deps)).toMatchObject({ accountId: ADMIN.id, mustChange: true });
    const out = await handleConsoleLogout(post("/api/v1/console/logout", cookie), deps);
    expect(out.status).toBe(200);
    expect(cleared(out)).toBe(true);
  });

  it("test_console_recheck_consoleView_is_async_and_a_revoked_cookie_is_signed_out", async () => {
    const auth = consoleAuth([ADMIN, { ...FACILITATOR, mustChange: true }]);
    const deps = fakeDeps({ auth });
    const view = consoleView(accountCookieValue(ADMIN), () => deps);
    expect(view).toBeInstanceOf(Promise);
    expect(await view).toEqual({ kind: "signed_in", name: "Ann Lee", role: "admin", mustChange: false, legacy: false });
    expect(consolePageRedirect(await view)).toBeNull();

    const must = await consoleView(accountCookieValue(FACILITATOR), () => deps);
    expect(must).toEqual({ kind: "signed_in", name: "Dana Cook", role: "facilitator", mustChange: true, legacy: false });
    expect(consolePageRedirect(must)).toBe(CONSOLE_PASSWORD_PATH);
    expect(CONSOLE_PASSWORD_PATH).toBe("/console/password");

    expect(await consoleView(legacyCookieValue("Bo"), () => deps)).toEqual({ kind: "signed_in", name: "Bo", role: "admin", mustChange: false, legacy: true });
    auth.revoke(ADMIN.id);
    expect(await consoleView(accountCookieValue(ADMIN), () => deps)).toEqual({ kind: "signed_out" });
    auth.down();
    expect(await consoleView(accountCookieValue(FACILITATOR), () => deps)).toEqual({ kind: "unavailable" });
    expect(await consoleView(undefined, () => deps)).toEqual({ kind: "signed_out" });
    expect(await consoleView("x", () => { throw new Error("config"); })).toEqual({ kind: "disabled" });
    expect(await consoleView(accountCookieValue(ADMIN), () => fakeDeps({ config: consoleConfig({ launcherToken: undefined }) }))).toEqual({ kind: "disabled" });
  });

  it("test_console_recheck_open_stream_ends_within_one_heartbeat_after_revoke", async () => {
    const { deps, timers, conns } = streamDeps();
    const admin = await openStream(deps, accountCookie(ADMIN));
    const legacy = await openStream(deps, legacyCookie("Ann Lee"));
    expect(deps.facilitatorHub.size()).toBe(2);

    // A beat with the account still good keeps both streams.
    timers.fire(HEARTBEAT_MS);
    await settle();
    expect(deps.facilitatorHub.size()).toBe(2);

    // Control unreachable at a beat: the streams stay open and the next beat asks again.
    deps.auth.down();
    timers.fire(HEARTBEAT_MS);
    await settle();
    expect(deps.facilitatorHub.size()).toBe(2);
    deps.auth.down(false);

    deps.auth.revoke(ADMIN.id);
    const checks = deps.auth.accountCheck.mock.calls.length;
    timers.fire(HEARTBEAT_MS);
    await until(() => admin.frames().some((f) => f.event === "expired"), { what: "the admin stream's expired frame" });
    expect(deps.auth.accountCheck.mock.calls.length).toBe(checks + 1);
    expect(deps.facilitatorHub.size()).toBe(1);
    await until(() => conns[0]!.closed > 0, { what: "the admin stream's runtime socket closing" });
    expect(legacy.frames().some((f) => f.event === "expired")).toBe(false);

    // The latch closing ends a legacy stream the same way.
    deps.auth.closeLatch();
    timers.fire(HEARTBEAT_MS);
    await until(() => legacy.frames().some((f) => f.event === "expired"), { what: "the legacy stream's expired frame" });
    expect(deps.facilitatorHub.size()).toBe(0);
  });

  it("test_console_recheck_close_account_closes_that_accounts_streams", async () => {
    const { deps } = streamDeps();
    const a1 = await openStream(deps, accountCookie(ADMIN));
    const a2 = await openStream(deps, accountCookie(ADMIN));
    const f1 = await openStream(deps, accountCookie(FACILITATOR));
    const l1 = await openStream(deps, legacyCookie("Ann Lee"));
    expect(deps.facilitatorHub.closeAccount(ADMIN.id)).toBe(2);
    for (const r of [a1, a2]) await until(() => r.frames().some((f) => f.event === "expired"), { what: "an admin stream's expired frame" });
    expect(deps.facilitatorHub.size()).toBe(2);
    for (const r of [f1, l1]) expect(r.frames().some((f) => f.event === "expired")).toBe(false);
    expect(deps.facilitatorHub.closeAccount("nobody")).toBe(0);
    expect(deps.facilitatorHub.closeAccount(FACILITATOR.id)).toBe(1);
    expect(deps.facilitatorHub.size()).toBe(1);
  });

  it("test_console_recheck_console_enabled_without_facilitator_secret", async () => {
    expect(missingConsoleVars({ launcherUrl: "http://127.0.0.1:4000", launcherToken: "t".repeat(32) })).toEqual([]);
    expect(missingConsoleVars({})).toEqual(["LAUNCHER_URL", "LAUNCHER_TOKEN"]);
    const c = loadConfig({
      PUBLIC_ORIGIN: ORIGIN, COOKIE_KEYS: `k1:${Buffer.alloc(32, 1).toString("base64")}`, LAUNCHER_URL: "http://127.0.0.1:4000", LAUNCHER_TOKEN: "t".repeat(32),
    });
    expect(c.facilitatorSecret).toBeUndefined();
    expect(missingConsoleVars(c)).toEqual([]);
    const deps = fakeDeps({ config: consoleConfig({ facilitatorSecret: undefined }) });
    expect(await requireConsole(get("/api/v1/console/x", accountCookie(ADMIN)), deps)).toMatchObject({ accountId: ADMIN.id });
    // Without a secret no legacy cookie opens, whatever the latch says.
    const legacy = (await requireConsole(get("/api/v1/console/x", legacyCookie("Ann Lee")), deps)) as Response;
    expect(legacy.status).toBe(401);
    expect(deps.auth.legacyAllowed).not.toHaveBeenCalled();
  });

  it("test_console_recheck_heartbeat_check_refuses_must_change_and_asks_once_at_a_time", async () => {
    const auth = consoleAuth([ADMIN, { ...FACILITATOR, mustChange: true }]);
    const check = consoleRecheck(auth.launcher);
    expect(await check({ accountId: ADMIN.id, epoch: ADMIN.epoch })).toBe("ok");
    expect(await check({ accountId: FACILITATOR.id, epoch: FACILITATOR.epoch })).toBe("refused");
    expect(await check({ accountId: null, epoch: null })).toBe("ok");
    auth.down();
    expect(await check({ accountId: ADMIN.id, epoch: ADMIN.epoch })).toBe("unavailable");
    expect(await check({ accountId: null, epoch: null })).toBe("unavailable");

    // A re-check still waiting for control is not started again at the next beat; a re-check that throws keeps the stream.
    let release: (r: "ok" | "refused") => void = () => {};
    const slow = vi.fn(() => new Promise<"ok" | "refused" | "unavailable">((r) => { release = r; }));
    const timers = manualTimers();
    const hub = new FacilitatorHub({ setTimer: timers.setTimer, now: () => 0, recheck: slow });
    const conn = new FacConn();
    const out = { write: () => true, end: () => {} };
    hub.open({ sessionId: SID, expiresAt: 10 ** 13, accountId: ADMIN.id, epoch: 1, conn: conn as never, joined: await conn.joinFacilitator(), out });
    timers.fire(HEARTBEAT_MS);
    timers.fire(HEARTBEAT_MS);
    expect(slow).toHaveBeenCalledTimes(1);
    release("ok");
    await settle();
    timers.fire(HEARTBEAT_MS);
    expect(slow).toHaveBeenCalledTimes(2);
    release("refused");
    await settle();
    expect(hub.size()).toBe(0);

    const throwing = new FacilitatorHub({ setTimer: timers.setTimer, now: () => 0, recheck: () => { throw new Error("boom"); } });
    const c2 = new FacConn();
    throwing.open({ sessionId: SID, expiresAt: 10 ** 13, accountId: ADMIN.id, epoch: 1, conn: c2 as never, joined: await c2.joinFacilitator(), out });
    const rejecting = new FacilitatorHub({ setTimer: timers.setTimer, now: () => 0, recheck: () => Promise.reject(new Error("boom")) });
    const c3 = new FacConn();
    rejecting.open({ sessionId: SID, expiresAt: 10 ** 13, accountId: ADMIN.id, epoch: 1, conn: c3 as never, joined: await c3.joinFacilitator(), out });
    timers.fire(HEARTBEAT_MS);
    await settle();
    expect(throwing.size()).toBe(1);
    expect(rejecting.size()).toBe(1);
  });

  it("non_admin_never_sees_the_admin_link_or_page: the admin page sends everyone but an admin account away", () => {
    const signedIn = (role: "admin" | "facilitator", mustChange = false, legacy = false) =>
      ({ kind: "signed_in", name: "N", role, mustChange, legacy }) as const;
    expect(adminPageRedirect({ kind: "signed_out" })).toBe("/console");
    expect(adminPageRedirect(signedIn("admin", true))).toBe(CONSOLE_PASSWORD_PATH);
    expect(adminPageRedirect(signedIn("facilitator"))).toBe("/console");
    expect(adminPageRedirect(signedIn("admin", false, true))).toBe("/console");
    expect(adminPageRedirect(signedIn("admin"))).toBeNull();
    expect(adminPageRedirect({ kind: "disabled" })).toBeNull();
    expect(adminPageRedirect({ kind: "unavailable" })).toBeNull();
  });
});
