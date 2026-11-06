import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config";
import { CONSOLE_COOKIE, secretEpoch } from "../console-session";
import { setEnvelopeClock } from "../envelope";
import { COOKIE_NAME, type Deps } from "../handlers";
import { LauncherError, type LauncherReason } from "../launcher-client";
import {
  handleConsoleReportLinkAction,
  handleConsoleReportLinks,
  handleConsoleReportLinksIssue,
  handleReportEnter,
  handleReportGet,
  REPORT_COOKIE,
} from "../report-handlers";
import { seal, unseal } from "../seal";
import { JoinThrottle } from "../throttle";

const ORIGIN = "https://play.example.org";
const KEYS: Config["cookieKeys"] = [{ id: "k1", key: Buffer.alloc(32, 7) }];
const SECRET = "correct horse battery staple";
const T0 = 1_900_000_000_000;
const SID = "s-0123456789abcdef";
const CRED_ID = "AbCdEfGhIjK";
const TOKEN = "AbCdEfGhIjK.0123456789abcdefghijkl";
const EXPIRES = T0 + 86_400_000;
const CONFLICT_SENTENCE = "A link is already active for this role.";
const NOT_READY_SENTENCE = "No reports are ready for this session yet. Evaluate it from the Report panel of its console.";

const config: Config = {
  runtimeUrl: "ws://127.0.0.1:1",
  publicOrigin: ORIGIN,
  cookieKeys: KEYS,
  cookieMaxAgeHours: 12,
  maxStreams: 10,
  maxStreamsPerSession: 10,
  maxStreamsPerAddress: 10,
  facilitatorSecret: SECRET,
  launcherUrl: "http://127.0.0.1:47123",
  launcherToken: "launcher-token-" + "t".repeat(20),
};

const reportCookieValue = (o: Partial<{ sessionId: string; credentialId: string; role: string; expiresAt: number }> = {}) =>
  seal({ sessionId: SID, credentialId: CRED_ID, role: "ana", expiresAt: EXPIRES, ...o }, KEYS, T0, "rpt");
const reportCookie = (o?: Parameters<typeof reportCookieValue>[0]) => `${REPORT_COOKIE}=${reportCookieValue(o)}`;
const facCookie = () => `${CONSOLE_COOKIE}=${seal({ name: "Ann", epoch: secretEpoch(SECRET), expiresAt: T0 + 3_600_000 }, KEYS, T0, "fac")}`;
const playerCookie = () =>
  `${COOKIE_NAME}=${seal({ sessionId: SID, roleId: "r", participantId: "p", credential: "c", logIdentity: "l", expiresAt: EXPIRES }, KEYS, T0)}`;

const SAME_SITE = { Origin: ORIGIN, "X-Requested-With": "scenecoach", "Content-Type": "application/json" };
const enterReq = (body: unknown = { token: TOKEN }, headers: Record<string, string> = SAME_SITE) =>
  new Request(`${ORIGIN}/api/v1/report/enter`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
const getReq = (cookie?: string, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/api/v1/report`, { method: "GET", headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers } });

type Launcher = Record<
  "reportLinks" | "issueReportLink" | "reissueReportLink" | "revokeReportLink" | "exchangeReportToken" | "readReport",
  ReturnType<typeof vi.fn>
>;
const SAFE_CRED = { role: "ana", createdAt: 1, expiresAt: EXPIRES, lastUsedAt: 5 };
function fakeLauncher(): Launcher {
  return {
    reportLinks: vi.fn(async () => ({ state: "ready", players: null, roles: [{ role: "ana", credential: SAFE_CRED, selfRated: null }, { role: "bo", credential: null, selfRated: null }] })),
    issueReportLink: vi.fn(async () => ({ credential: SAFE_CRED, token: TOKEN })),
    reissueReportLink: vi.fn(async () => ({ credential: SAFE_CRED, token: TOKEN })),
    revokeReportLink: vi.fn(async () => true),
    exchangeReportToken: vi.fn(async () => ({ credentialId: CRED_ID, sessionId: SID, role: "ana", expiresAt: EXPIRES })),
    readReport: vi.fn(async () => ({ state: "released", view: { kind: "released", own: { title: "Hi" } } })),
  };
}

let launcher: Launcher;
let deps: Deps;
let now = T0;
let logged: string[];

beforeEach(() => {
  now = T0;
  setEnvelopeClock(() => new Date(T0));
  launcher = fakeLauncher();
  const t = () => now;
  deps = {
    config,
    now: t,
    launcher: launcher as never,
    joinThrottle: new JoinThrottle({ max: 5, windowMs: 60_000, blockMs: 60_000, now: t }),
    reportThrottle: new JoinThrottle({ max: 60, windowMs: 60_000, blockMs: 60_000, now: t }),
    reportEnterThrottle: new JoinThrottle({ max: 5, windowMs: 60_000, blockMs: 60_000, now: t }),
  } as unknown as Deps;
  logged = [];
  for (const k of ["error", "warn", "log", "info", "debug"] as const) {
    vi.spyOn(console, k).mockImplementation((...a) => {
      logged.push(a.map(String).join(" "));
    });
  }
});
afterEach(() => vi.restoreAllMocks());

async function parts(res: Response) {
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as Record<string, any>, headers: res.headers };
}
const NEUTRAL = JSON.stringify({ success: false, data: null, error: { code: "not_found", message: "Not found." }, meta: { version: "1.0", timestamp: new Date(T0).toISOString() } });

function expectPrivate(res: Response) {
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
}

describe("POST /api/v1/report/enter", () => {
  it("sets the sealed rpt cookie with exact attributes and Max-Age = seconds left, and answers an empty data object", async () => {
    const res = await handleReportEnter(enterReq(), deps);
    const p = await parts(res);
    expect(p.status).toBe(200);
    expect(p.json).toMatchObject({ success: true, data: {}, error: null });
    expectPrivate(res);
    const set = res.headers.get("Set-Cookie")!;
    const m = /^__Host-scenecoach-report=([^;]+); Path=\/; Max-Age=(\d+); HttpOnly; Secure; SameSite=Lax$/.exec(set);
    expect(m).not.toBeNull();
    expect(Number(m![2])).toBe(86_400);
    expect(unseal(m![1]!, KEYS, T0, "rpt")).toEqual({ sessionId: SID, credentialId: CRED_ID, role: "ana", expiresAt: EXPIRES });
    expect(unseal(m![1]!, KEYS, T0)).toBeNull();
    expect(unseal(m![1]!, KEYS, T0, "fac")).toBeNull();
    expect(launcher.exchangeReportToken).toHaveBeenCalledWith(TOKEN);
  });

  it("a credential with under a second left is refused; with a second left Max-Age is 1; the cookie never outlives the credential", async () => {
    launcher.exchangeReportToken.mockResolvedValue({ credentialId: CRED_ID, sessionId: SID, role: "ana", expiresAt: T0 + 999 });
    const short = await handleReportEnter(enterReq(), deps);
    expect(short.status).toBe(404);
    expect(short.headers.get("Set-Cookie")).toBeNull();
    launcher.exchangeReportToken.mockResolvedValue({ credentialId: CRED_ID, sessionId: SID, role: "ana", expiresAt: T0 + 1999 });
    const res = await handleReportEnter(enterReq(), deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=1;");
    launcher.exchangeReportToken.mockResolvedValue({ credentialId: CRED_ID, sessionId: SID, role: "ana", expiresAt: T0 });
    const dead = await handleReportEnter(enterReq(), deps);
    expect(dead.status).toBe(404);
    expect(dead.headers.get("Set-Cookie")).toBeNull();
  });

  it("a cross-site Origin, a missing custom header or Sec-Fetch-Site: cross-site is refused 403 before the throttle or control", async () => {
    for (const h of [
      { ...SAME_SITE, Origin: "https://evil.example" },
      { Origin: ORIGIN, "Content-Type": "application/json" },
      { ...SAME_SITE, "Sec-Fetch-Site": "cross-site" },
    ]) {
      const res = await handleReportEnter(enterReq({ token: TOKEN }, h), deps);
      expect(res.status).toBe(403);
      expect((await parts(res)).json.error.code).toBe("forbidden");
      expectPrivate(res);
      expect(res.headers.get("Set-Cookie")).toBeNull();
    }
    expect(launcher.exchangeReportToken).not.toHaveBeenCalled();
    // none of those counted as a failure: five real failures are still free (a charged 403 would block the fifth) and a good token passes
    launcher.exchangeReportToken.mockRejectedValue(new LauncherError("not_found"));
    for (let i = 0; i < 5; i++) expect((await handleReportEnter(enterReq(), deps)).status).toBe(404);
    launcher.exchangeReportToken.mockResolvedValue({ credentialId: CRED_ID, sessionId: SID, role: "ana", expiresAt: EXPIRES });
    expect((await handleReportEnter(enterReq(), deps)).status).toBe(200);
    expect(launcher.exchangeReportToken).toHaveBeenCalledTimes(6);
  });

  it("a refusal (control 404) is the neutral 404, byte-equal for every kind, without a cookie", async () => {
    const bodies: string[] = [];
    launcher.exchangeReportToken.mockRejectedValue(new LauncherError("not_found"));
    const a = await handleReportEnter(enterReq(), deps);
    bodies.push(await a.text());
    const b = await handleReportEnter(enterReq({ token: "x".repeat(65) }), deps);
    bodies.push(await b.text());
    const c = await handleReportEnter(enterReq({ token: "" }), deps);
    bodies.push(await c.text());
    expect(a.status).toBe(404);
    expect(new Set(bodies)).toEqual(new Set([NEUTRAL]));
    for (const r of [a, b, c]) {
      expectPrivate(r);
      expect(r.headers.get("Set-Cookie")).toBeNull();
    }
    // the over-long and empty tokens never went to control
    expect(launcher.exchangeReportToken).toHaveBeenCalledTimes(1);
  });

  it("the sixth failure from one address inside 60 s is throttled (JoinThrottle semantics): refused without calling control, until the block ends", async () => {
    launcher.exchangeReportToken.mockRejectedValue(new LauncherError("not_found"));
    for (let i = 0; i < 6; i++) expect((await handleReportEnter(enterReq(), deps)).status).toBe(404);
    expect(launcher.exchangeReportToken).toHaveBeenCalledTimes(6);
    // now blocked: even a good token is not tried
    launcher.exchangeReportToken.mockResolvedValue({ credentialId: CRED_ID, sessionId: SID, role: "ana", expiresAt: EXPIRES });
    const blocked = await handleReportEnter(enterReq(), deps);
    const bp = await parts(blocked);
    expect(bp.status).toBe(429);
    expect(bp.json.error).toEqual({ code: "rate_limited", message: "Too many attempts. Wait a minute and try again." });
    expect(blocked.headers.get("Retry-After")).toBe("60");
    expectPrivate(blocked);
    expect(blocked.headers.get("Set-Cookie")).toBeNull();
    expect(launcher.exchangeReportToken).toHaveBeenCalledTimes(6);
    // another address is unaffected
    const other = await handleReportEnter(enterReq(undefined, { ...SAME_SITE, "X-Forwarded-For": "203.0.113.9" }), deps);
    expect(other.status).toBe(200);
    now += 60_001;
    expect((await handleReportEnter(enterReq(), deps)).status).toBe(200);
  });

  it("five failures are not yet blocked", async () => {
    launcher.exchangeReportToken.mockRejectedValue(new LauncherError("not_found"));
    for (let i = 0; i < 5; i++) await handleReportEnter(enterReq(), deps);
    launcher.exchangeReportToken.mockResolvedValue({ credentialId: CRED_ID, sessionId: SID, role: "ana", expiresAt: EXPIRES });
    expect((await handleReportEnter(enterReq(), deps)).status).toBe(200);
  });

  it("control unavailable is a 503 envelope, is not charged and sets no cookie", async () => {
    for (const reason of ["unavailable", "timeout", "failed", "unauthorized"] as LauncherReason[]) {
      launcher.exchangeReportToken.mockRejectedValue(new LauncherError(reason));
      const res = await handleReportEnter(enterReq(), deps);
      const p = await parts(res);
      expect(p.status).toBe(503);
      expect(p.json.error).toEqual({ code: "unavailable", message: "The report is unavailable. Try again." });
      expectPrivate(res);
      expect(res.headers.get("Set-Cookie")).toBeNull();
    }
    expect(launcher.exchangeReportToken).toHaveBeenCalledTimes(4);
    // four 503s were not charged: five failures are still free (a charged 503 would block the fifth), then a good token passes
    launcher.exchangeReportToken.mockRejectedValue(new LauncherError("not_found"));
    for (let i = 0; i < 5; i++) expect((await handleReportEnter(enterReq(), deps)).status).toBe(404);
    launcher.exchangeReportToken.mockResolvedValue({ credentialId: CRED_ID, sessionId: SID, role: "ana", expiresAt: EXPIRES });
    expect((await handleReportEnter(enterReq(), deps)).status).toBe(200);
  });

  it("no launcher configured is a 503", async () => {
    const res = await handleReportEnter(enterReq(), { ...deps, launcher: undefined } as Deps);
    expect(res.status).toBe(503);
    expectPrivate(res);
  });

  it("a body that is not exactly { token } is a 400", async () => {
    for (const body of ["not json", "[]", { token: TOKEN, extra: 1 }, { nope: 1 }, { token: 5 }, "{}"]) {
      const res = await handleReportEnter(enterReq(body), deps);
      expect(res.status).toBe(400);
      expectPrivate(res);
    }
    const noType = await handleReportEnter(enterReq({ token: TOKEN }, { Origin: ORIGIN, "X-Requested-With": "scenecoach" }), deps);
    expect(noType.status).toBe(400);
    expect(launcher.exchangeReportToken).not.toHaveBeenCalled();
  });

  it("an address that is not an address is a 400", async () => {
    const res = await handleReportEnter(enterReq(undefined, { ...SAME_SITE, "X-Forwarded-For": "1.2.3.4, 5.6.7.8" }), deps);
    expect(res.status).toBe(400);
  });

  it("never logs a token, credential id, role, session id or address, and an unexpected throw is a private 500", async () => {
    await handleReportEnter(enterReq(), deps);
    launcher.exchangeReportToken.mockRejectedValue(new LauncherError("not_found"));
    await handleReportEnter(enterReq(), deps);
    // a credential the cookie cannot be sealed for (not a finite expiry) is a bug, not a refusal: private 500, no detail logged
    launcher.exchangeReportToken.mockResolvedValue({ credentialId: CRED_ID, sessionId: SID, role: "ana", expiresAt: Number.NaN });
    const res = await handleReportEnter(enterReq(), deps);
    expect(res.status).toBe(500);
    expectPrivate(res);
    const all = logged.join("\n");
    for (const secret of [TOKEN, TOKEN.split(".")[1]!, CRED_ID, SID, "ana", "unknown"]) expect(all).not.toContain(secret);
  });
});

describe("GET /api/v1/report", () => {
  it("proxies a released report for the cookie's own session and credential", async () => {
    const res = await handleReportGet(getReq(reportCookie()), deps);
    const p = await parts(res);
    expect(p.status).toBe(200);
    expect(p.json.data).toEqual({ state: "released", view: { kind: "released", own: { title: "Hi" } }, availableUntil: new Date(EXPIRES).toISOString() });
    expectPrivate(res);
    expect(launcher.readReport).toHaveBeenCalledWith(SID, CRED_ID);
  });

  it("not_released passes through", async () => {
    launcher.readReport.mockResolvedValue({ state: "not_released" });
    const p = await parts(await handleReportGet(getReq(reportCookie()), deps));
    expect(p.status).toBe(200);
    expect(p.json.data).toEqual({ state: "not_released", availableUntil: new Date(EXPIRES).toISOString() });
  });

  it("no cookie, a tampered cookie, an expired cookie, a fac, player or garbage cookie is the neutral 404 without calling control", async () => {
    const good = reportCookieValue();
    const tampered = good.slice(0, -2) + (good.endsWith("AA") ? "BB" : "AA");
    const expired = seal({ sessionId: SID, credentialId: CRED_ID, role: "ana", expiresAt: T0 + 10 }, KEYS, T0, "rpt");
    const odd = seal({ sessionId: "bad id", credentialId: CRED_ID, role: "ana", expiresAt: EXPIRES }, KEYS, T0, "rpt");
    const wrongShape = seal({ sessionId: SID, expiresAt: EXPIRES }, KEYS, T0, "rpt");
    const cookies: (string | undefined)[] = [
      undefined,
      `${REPORT_COOKIE}=${tampered}`,
      `${REPORT_COOKIE}=garbage`,
      `${REPORT_COOKIE}=${expired}`,
      `${REPORT_COOKIE}=${odd}`,
      `${REPORT_COOKIE}=${wrongShape}`,
      // a facilitator-sealed or player-sealed value planted under the report cookie's name
      `${REPORT_COOKIE}=${facCookie().slice(CONSOLE_COOKIE.length + 1)}`,
      `${REPORT_COOKIE}=${playerCookie().slice(COOKIE_NAME.length + 1)}`,
      facCookie(),
    ];
    now = T0 + 20; // so `expired` is past its expiry
    let n = 0;
    for (const c of cookies) {
      // each from its own address: this test is about the answer, not the per-address block
      const res = await handleReportGet(getReq(c, { "X-Forwarded-For": `198.51.100.${++n}` }), deps);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(NEUTRAL);
      expectPrivate(res);
    }
    expect(launcher.readReport).not.toHaveBeenCalled();
  });

  it("control 404 (revoked, expired, withdrawn link) clears the cookie and answers the same neutral 404", async () => {
    launcher.readReport.mockRejectedValue(new LauncherError("not_found"));
    const res = await handleReportGet(getReq(reportCookie()), deps);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(NEUTRAL);
    expect(res.headers.get("Set-Cookie")).toBe("__Host-scenecoach-report=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
    expectPrivate(res);
  });

  it("control 503 is a 503 envelope and the cookie is NOT cleared", async () => {
    for (const reason of ["unavailable", "timeout", "failed"] as LauncherReason[]) {
      launcher.readReport.mockRejectedValue(new LauncherError(reason));
      const res = await handleReportGet(getReq(reportCookie()), deps);
      const p = await parts(res);
      expect(p.status).toBe(503);
      expect(p.json.error).toEqual({ code: "unavailable", message: "The report is unavailable. Try again." });
      expect(res.headers.get("Set-Cookie")).toBeNull();
      expectPrivate(res);
    }
  });

  it("valid reads are limited per credential, not per address: one credential gets 60 reads a minute, the 61st is a 429 with Retry-After", async () => {
    for (let i = 0; i < 60; i++) expect((await handleReportGet(getReq(reportCookie()), deps)).status).toBe(200);
    const next = await handleReportGet(getReq(reportCookie()), deps);
    expect(next.status).toBe(429);
    expect(next.headers.get("Retry-After")).toBe("60");
    expectPrivate(next);
    expect(launcher.readReport).toHaveBeenCalledTimes(60);
    // another credential behind the same address is unaffected
    const other = await handleReportGet(getReq(reportCookie({ credentialId: "ZZZZZZZZZZZ" })), deps);
    expect(other.status).toBe(200);
    now += 60_001;
    expect((await handleReportGet(getReq(reportCookie()), deps)).status).toBe(200);
  });

  it("a room behind one address: 20 different credentials each read five times and none is throttled", async () => {
    for (let n = 0; n < 20; n++) {
      const cookie = reportCookie({ credentialId: `CRED${String(n).padStart(7, "0")}` });
      for (let i = 0; i < 5; i++) expect((await handleReportGet(getReq(cookie), deps)).status).toBe(200);
    }
    expect(launcher.readReport).toHaveBeenCalledTimes(100);
  });

  it("cookies that fail before reaching control are counted per address: the sixth is refused, the seventh is a 429; other addresses and valid readers behind a clean address are fine", async () => {
    for (let i = 0; i < 6; i++) expect((await handleReportGet(getReq(`${REPORT_COOKIE}=forged${i}`), deps)).status).toBe(404);
    const blocked = await handleReportGet(getReq(`${REPORT_COOKIE}=forged7`), deps);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("60");
    expectPrivate(blocked);
    // the block is for the address, so a valid cookie from it waits too; a different address does not
    expect((await handleReportGet(getReq(reportCookie()), deps)).status).toBe(429);
    expect((await handleReportGet(getReq(reportCookie(), { "X-Forwarded-For": "203.0.113.9" }), deps)).status).toBe(200);
    expect(launcher.readReport).toHaveBeenCalledTimes(1);
    now += 60_001;
    expect((await handleReportGet(getReq(reportCookie()), deps)).status).toBe(200);
  });

  it("valid reads never count as address failures, and the read keys do not collide with the enter keys", async () => {
    for (let i = 0; i < 30; i++) await handleReportGet(getReq(reportCookie({ credentialId: `CRED${String(i).padStart(7, "0")}` })), deps);
    // five bad enter tokens leave reads alone
    launcher.exchangeReportToken.mockRejectedValue(new LauncherError("not_found"));
    for (let i = 0; i < 5; i++) expect((await handleReportEnter(enterReq(), deps)).status).toBe(404);
    expect((await handleReportGet(getReq(reportCookie()), deps)).status).toBe(200);
    // and five forged reads leave enter alone
    launcher.exchangeReportToken.mockResolvedValue({ credentialId: CRED_ID, sessionId: SID, role: "ana", expiresAt: EXPIRES });
    for (let i = 0; i < 5; i++) await handleReportGet(getReq(`${REPORT_COOKIE}=forged${i}`), deps);
    expect((await handleReportEnter(enterReq(), deps)).status).toBe(200);
  });

  it("never logs the credential id, role, session id or address", async () => {
    await handleReportGet(getReq(reportCookie()), deps);
    launcher.readReport.mockRejectedValue(new LauncherError("not_found"));
    await handleReportGet(getReq(reportCookie()), deps);
    launcher.readReport.mockRejectedValue(new LauncherError("unavailable"));
    await handleReportGet(getReq(reportCookie()), deps);
    const all = logged.join("\n");
    for (const secret of [CRED_ID, SID, "ana", "unknown"]) expect(all).not.toContain(secret);
  });
});

describe("console report-link routes", () => {
  const consoleReq = (path: string, method: string, body?: unknown, o: { cookie?: string | null; headers?: Record<string, string> } = {}) =>
    new Request(`${ORIGIN}/api/v1/console/sessions/${SID}/report-links${path}`, {
      method,
      headers: {
        ...(o.cookie === null ? {} : { Cookie: o.cookie ?? facCookie() }),
        ...(method === "GET" ? {} : SAME_SITE),
        ...(o.headers ?? {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it("every route needs the facilitator cookie: none, a player cookie and a report cookie are 401", async () => {
    for (const cookie of [null, playerCookie(), reportCookie()]) {
      for (const [h, req] of [
        [handleConsoleReportLinks, consoleReq("", "GET", undefined, { cookie })],
        [handleConsoleReportLinksIssue, consoleReq("", "POST", { role: "ana" }, { cookie })],
        [handleConsoleReportLinkAction, consoleReq("/ana", "POST", { action: "revoke" }, { cookie })],
      ] as const) {
        const res = await h(req, deps);
        expect(res.status).toBe(401);
      }
    }
    for (const m of ["reportLinks", "issueReportLink", "reissueReportLink", "revokeReportLink"] as const) expect(launcher[m]).not.toHaveBeenCalled();
  });

  it("the list drops credential ids and gives booleans", async () => {
    launcher.reportLinks.mockResolvedValue({
      state: "ready",
      players: { rated: 1, total: 2 },
      roles: [
        { role: "ana", credential: { ...SAFE_CRED, id: CRED_ID }, selfRated: null, draft: false },
        { role: "bo", credential: { role: "bo", createdAt: 1, expiresAt: T0 - 1, revokedAt: 2 }, selfRated: { rated: 1, total: 4 }, draft: true },
        { role: "cy", credential: null, selfRated: null, draft: true },
      ],
    });
    const res = await handleConsoleReportLinks(consoleReq("", "GET"), deps);
    const p = await parts(res);
    expect(p.status).toBe(200);
    expect(p.text).not.toContain(CRED_ID);
    expect(p.json.data).toEqual({
      state: "ready",
      players: { rated: 1, total: 2 },
      roles: [
        { role: "ana", credential: { role: "ana", createdAt: 1, expiresAt: EXPIRES, lastUsedAt: 5, active: true, revoked: false }, selfRated: null, draft: false },
        { role: "bo", credential: { role: "bo", createdAt: 1, expiresAt: T0 - 1, active: false, revoked: true }, selfRated: { rated: 1, total: 4 }, draft: true },
        { role: "cy", credential: null, selfRated: null, draft: true },
      ],
    });
    expectPrivate(res);
    expect(launcher.reportLinks).toHaveBeenCalledWith(SID);
  });

  it("issue returns the token once with a credential DTO that has no id; it needs the guards", async () => {
    const res = await handleConsoleReportLinksIssue(consoleReq("", "POST", { role: "ana" }), deps);
    const p = await parts(res);
    expect(p.status).toBe(200);
    expect(p.json.data).toEqual({ role: "ana", token: TOKEN, credential: { role: "ana", createdAt: 1, expiresAt: EXPIRES, lastUsedAt: 5, active: true, revoked: false } });
    expectPrivate(res);
    expect(launcher.issueReportLink).toHaveBeenCalledWith(SID, "ana");
    const cross = await handleConsoleReportLinksIssue(consoleReq("", "POST", { role: "ana" }, { headers: { Origin: "https://evil.example" } }), deps);
    expect(cross.status).toBe(403);
    expect((await handleConsoleReportLinksIssue(consoleReq("", "POST", { role: "../x" }), deps)).status).toBe(400);
    expect((await handleConsoleReportLinksIssue(consoleReq("", "POST", { role: "ana", x: 1 }), deps)).status).toBe(400);
    expect(launcher.issueReportLink).toHaveBeenCalledTimes(1);
  });

  it("reissue returns a new token once; revoke returns the boolean", async () => {
    const r = await parts(await handleConsoleReportLinkAction(consoleReq("/ana", "POST", { action: "reissue" }), deps));
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ role: "ana", token: TOKEN });
    expect(r.json.data.credential).not.toHaveProperty("id");
    expect(launcher.reissueReportLink).toHaveBeenCalledWith(SID, "ana");
    const v = await parts(await handleConsoleReportLinkAction(consoleReq("/ana", "POST", { action: "revoke" }), deps));
    expect(v.json.data).toEqual({ role: "ana", revoked: true });
    expect(launcher.revokeReportLink).toHaveBeenCalledWith(SID, "ana");
    expect((await handleConsoleReportLinkAction(consoleReq("/ana", "POST", { action: "nuke" }), deps)).status).toBe(400);
    const cross = await handleConsoleReportLinkAction(consoleReq("/ana", "POST", { action: "revoke" }, { headers: { "Sec-Fetch-Site": "cross-site" } }), deps);
    expect(cross.status).toBe(403);
  });

  it("a control 409 passes through only when it is one of the known fixed sentences", async () => {
    launcher.issueReportLink.mockRejectedValue(new LauncherError("conflict", CONFLICT_SENTENCE));
    let p = await parts(await handleConsoleReportLinksIssue(consoleReq("", "POST", { role: "ana" }), deps));
    expect(p.status).toBe(409);
    expect(p.json.error).toEqual({ code: "conflict", message: CONFLICT_SENTENCE });
    launcher.issueReportLink.mockRejectedValue(new LauncherError("conflict", NOT_READY_SENTENCE));
    p = await parts(await handleConsoleReportLinksIssue(consoleReq("", "POST", { role: "ana" }), deps));
    expect(p.json.error.message).toBe(NOT_READY_SENTENCE);
    launcher.issueReportLink.mockRejectedValue(new LauncherError("conflict", "/srv/data/reports/s-1 is odd"));
    p = await parts(await handleConsoleReportLinksIssue(consoleReq("", "POST", { role: "ana" }), deps));
    expect(p.status).toBe(409);
    expect(p.text).not.toContain("/srv");
    launcher.issueReportLink.mockRejectedValue(new LauncherError("conflict"));
    expect((await handleConsoleReportLinksIssue(consoleReq("", "POST", { role: "ana" }), deps)).status).toBe(409);
  });

  it("the console shows the not-ready and no-report sentences; a stale sentence becomes the generic one", async () => {
    const NO_REPORT_SENTENCE = "There is no report to link for this role.";
    for (const sentence of [NOT_READY_SENTENCE, NO_REPORT_SENTENCE]) {
      launcher.issueReportLink.mockRejectedValue(new LauncherError("conflict", sentence));
      const p = await parts(await handleConsoleReportLinksIssue(consoleReq("", "POST", { role: "ana" }), deps));
      expect([p.status, p.json.error.message]).toEqual([409, sentence]);
    }
    for (const stale of [
      "No reports are ready for this session yet. Run evaluate, then moderate open and release, from the terminal (see the guide).",
      "There is no released report to link for this role.",
    ]) {
      launcher.issueReportLink.mockRejectedValue(new LauncherError("conflict", stale));
      const p = await parts(await handleConsoleReportLinksIssue(consoleReq("", "POST", { role: "ana" }), deps));
      expect([p.status, p.json.error.message]).toEqual([409, "That action is not possible right now."]);
    }
  });

  it("control unavailable is 503; not found is 404", async () => {
    launcher.reportLinks.mockRejectedValue(new LauncherError("unavailable"));
    const u = await parts(await handleConsoleReportLinks(consoleReq("", "GET"), deps));
    expect(u.status).toBe(503);
    expect(u.json.error.code).toBe("unavailable");
    launcher.reportLinks.mockRejectedValue(new LauncherError("not_found"));
    expect((await handleConsoleReportLinks(consoleReq("", "GET"), deps)).status).toBe(404);
  });
});
