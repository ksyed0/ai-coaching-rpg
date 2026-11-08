import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config";
import { setEnvelopeClock } from "../envelope";
import type { Deps } from "../handlers";
import { LauncherError } from "../launcher-client";
import { handleReportRate, handleReportRespond, REPORT_COOKIE } from "../report-handlers";
import { seal } from "../seal";
import { JoinThrottle } from "../throttle";

const ORIGIN = "https://play.example.org";
const KEYS: Config["cookieKeys"] = [{ id: "k1", key: Buffer.alloc(32, 7) }];
const T0 = 1_900_000_000_000;
const SID = "s-0123456789abcdef";
const CRED_ID = "AbCdEfGhIjK";
const EXPIRES = T0 + 86_400_000;
const SECRET_TEXT = "CONTROL-INTERNAL-TEXT";

const config: Config = {
  runtimeUrl: "ws://127.0.0.1:1", publicOrigin: ORIGIN, cookieKeys: KEYS, cookieMaxAgeHours: 12, maxStreams: 10, maxStreamsPerSession: 10,
  maxStreamsPerAddress: 10, facilitatorSecret: "correct horse battery staple", launcherUrl: "http://127.0.0.1:47123", launcherToken: "launcher-token-" + "t".repeat(20),
};

const cookieValue = (purpose: "rpt" | "fac" = "rpt") => seal({ sessionId: SID, credentialId: CRED_ID, role: "ana", expiresAt: EXPIRES }, KEYS, T0, purpose);
const cookie = (purpose?: "rpt" | "fac") => `${REPORT_COOKIE}=${cookieValue(purpose)}`;
const SAME_SITE = { Origin: ORIGIN, "X-Requested-With": "scenecoach", "Content-Type": "application/json", Cookie: cookie() };
const RATINGS = { ratings: [{ criterion: "c1", level: 3 }] };
const rateReq = (body: unknown = RATINGS, headers: Record<string, string> = SAME_SITE) =>
  new Request(`${ORIGIN}/api/v1/report/self-ratings`, { method: "PUT", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
const respondReq = (body: unknown = { text: "I disagree" }, headers: Record<string, string> = SAME_SITE) =>
  new Request(`${ORIGIN}/api/v1/report/responses`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

type Launcher = Record<"rateReport" | "respondReport" | "readReport", ReturnType<typeof vi.fn>>;
let launcher: Launcher;
let deps: Deps;
let now = T0;

beforeEach(() => {
  now = T0;
  setEnvelopeClock(() => new Date(T0));
  launcher = {
    rateReport: vi.fn(async () => ({ state: "ok" })),
    respondReport: vi.fn(async () => ({ state: "ok" })),
    readReport: vi.fn(async () => ({ state: "released", view: { own: { title: "Fresh" } } })),
  };
  const t = () => now;
  deps = {
    config, now: t, launcher: launcher as never,
    reportThrottle: new JoinThrottle({ max: 60, windowMs: 60_000, blockMs: 60_000, now: t }),
    reportWriteThrottle: new JoinThrottle({ max: 30, windowMs: 60_000, blockMs: 60_000, now: t }),
    reportEnterThrottle: new JoinThrottle({ max: 5, windowMs: 60_000, blockMs: 60_000, now: t }),
    reportReadFailThrottle: new JoinThrottle({ max: 5, windowMs: 60_000, blockMs: 60_000, now: t }),
  } as unknown as Deps;
  for (const k of ["error", "warn", "log", "info", "debug"] as const) vi.spyOn(console, k).mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

async function parts(res: Response) {
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as Record<string, any>, headers: res.headers };
}
const calls = () => launcher.rateReport.mock.calls.length + launcher.respondReport.mock.calls.length + launcher.readReport.mock.calls.length;

describe("participant write routes", () => {
  it("forged Origin or Fetch-Metadata is refused before the throttle and before any control call", async () => {
    for (const h of [
      { ...SAME_SITE, Origin: "https://evil.example" },
      { ...SAME_SITE, "Sec-Fetch-Site": "cross-site" },
    ]) {
      for (const run of [() => handleReportRate(rateReq(RATINGS, h), deps), () => handleReportRespond(respondReq(undefined, h), deps)]) {
        expect((await run()).status).toBe(403);
      }
    }
    expect(calls()).toBe(0);
    expect(deps.reportWriteThrottle.blockedForMs(CRED_ID, "*report-write-cred")).toBe(0);
    expect(deps.reportEnterThrottle.size).toBe(0);
    expect(deps.reportReadFailThrottle.size).toBe(0);
    expect(deps.reportWriteThrottle.size).toBe(0);
  });

  it("non-JSON, oversized, and bodies with a role key are refused", async () => {
    const noJson = { ...SAME_SITE, "Content-Type": "text/plain" };
    expect((await handleReportRate(rateReq(RATINGS, noJson), deps)).status).toBe(400);
    expect((await handleReportRespond(respondReq(undefined, noJson), deps)).status).toBe(400);
    const big = await parts(await handleReportRate(rateReq({ ratings: [{ criterion: "c", level: 1, note: "x".repeat(65 * 1024) }] }), deps));
    expect(big.status).toBe(413);
    expect(big.json.data).toEqual({ state: "too_large" });
    expect((await handleReportRespond(respondReq({ text: "x".repeat(17 * 1024) }), deps)).status).toBe(413);
    expect((await handleReportRate(rateReq({ ...RATINGS, role: "bo" }), deps)).status).toBe(400);
    expect((await handleReportRespond(respondReq({ text: "hi", role: "bo" }), deps)).status).toBe(400);
    expect((await handleReportRespond(respondReq({ text: "hi", extra: 1 }), deps)).status).toBe(400);
    expect((await handleReportRate(rateReq("not json"), deps)).status).toBe(400);
    expect(calls()).toBe(0);
  });

  it("a full-size multi-byte submission passes the body cap; one over the cap is 413", async () => {
    const emoji = "\u{1F600}".repeat(1500); // four bytes each in UTF-8
    const ratings = Array.from({ length: 7 }, (_, i) => ({ criterion: `c${i + 1}`, level: 3, note: emoji }));
    const bytes = new TextEncoder().encode(JSON.stringify({ ratings })).length;
    expect(bytes).toBeGreaterThan(40_000);
    expect(bytes).toBeLessThan(64 * 1024);
    const ok = await handleReportRate(rateReq({ ratings }), deps);
    expect(ok.status).toBe(200);
    expect(launcher.rateReport).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(launcher.rateReport.mock.calls[0])).toContain(emoji);
    const over = await parts(await handleReportRate(rateReq({ ratings: [{ criterion: "c1", level: 3, note: "\u{1F600}".repeat(17_000) }] }), deps));
    expect(over.status).toBe(413);
    expect(over.json.data).toEqual({ state: "too_large" });
    expect((await handleReportRespond(respondReq({ text: "\u{1F600}".repeat(4_200) }), deps)).status).toBe(413); // 16,800 bytes
    expect(launcher.rateReport).toHaveBeenCalledTimes(1);
  });

  it("no cookie, forged cookie or other-audience cookie is the neutral 404", async () => {
    const { Cookie: _c, ...none } = SAME_SITE;
    for (const h of [none, { ...SAME_SITE, Cookie: `${REPORT_COOKIE}=forged` }, { ...SAME_SITE, Cookie: cookie("fac") }]) {
      const p = await parts(await handleReportRate(rateReq(RATINGS, h), deps));
      expect(p.status).toBe(404);
      expect(p.json.error.code).toBe("not_found");
      expect(p.headers.get("Set-Cookie")).toBeNull();
    }
    expect(calls()).toBe(0);
    // Each refusal counted against the address: the sixth is blocked.
    for (let i = 0; i < 3; i += 1) await handleReportRespond(respondReq(undefined, none), deps);
    const blocked = await handleReportRate(rateReq(RATINGS, none), deps);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).not.toBeNull();
    // the failures are charged to the read-fail table, never to the enter table
    expect(deps.reportEnterThrottle.size).toBe(0);
  });

  it("BUG-0025: writes unseal first, so forged writes from an address never block a valid writer behind it", async () => {
    const forged = { ...SAME_SITE, Cookie: `${REPORT_COOKIE}=forged` };
    for (let i = 0; i < 50; i += 1) await handleReportRespond(respondReq(undefined, forged), deps);
    expect((await handleReportRate(rateReq(RATINGS, forged), deps)).status).toBe(429);
    expect((await handleReportRespond(respondReq(), deps)).status).toBe(200);
    expect((await handleReportRate(rateReq(), deps)).status).toBe(200);
    expect(launcher.respondReport).toHaveBeenCalledTimes(1);
    expect(launcher.rateReport).toHaveBeenCalledTimes(1);
  });

  it("BUG-0025: a valid write cookie whose credential is gone is the neutral 404 and is not charged to the address", async () => {
    launcher.respondReport.mockRejectedValue(new LauncherError("not_found"));
    for (let i = 0; i < 8; i += 1) {
      const p = await parts(await handleReportRespond(respondReq(), deps));
      expect(p.status).toBe(404);
      expect(p.json.error).toEqual({ code: "not_found", message: "Not found." });
      expect(p.headers.get("Set-Cookie")).toMatch(/Max-Age=0/);
    }
    expect(deps.reportReadFailThrottle.size).toBe(0);
  });

  it("a control 404 clears the cookie; a 503 keeps it (Review Focus 4)", async () => {
    launcher.rateReport.mockRejectedValueOnce(new LauncherError("not_found"));
    const gone = await handleReportRate(rateReq(), deps);
    expect(gone.status).toBe(404);
    expect(gone.headers.get("Set-Cookie")).toMatch(/Max-Age=0/);
    launcher.respondReport.mockRejectedValueOnce(new LauncherError("unavailable"));
    const down = await handleReportRespond(respondReq(), deps);
    expect(down.status).toBe(503);
    expect(down.headers.get("Set-Cookie")).toBeNull();
  });

  it("busy, closed, too_many, invalid, 413 and 429 are passed through as fixed states with no control text", async () => {
    const cases: [any, number, string][] = [
      [{ state: "busy" }, 503, "busy"],
      [{ state: "closed" }, 409, "closed"],
      [{ state: "not_released" }, 409, "not_released"],
      [{ state: "withdrawn" }, 409, "withdrawn"],
      [{ state: "too_many" }, 409, "too_many"],
      [{ state: "link_full" }, 409, "link_full"],
      [{ state: "old_schema" }, 409, "old_schema"],
      [{ state: "invalid" }, 400, "invalid"],
      [{ state: "too_large" }, 413, "too_large"],
    ];
    for (const [outcome, status, state] of cases) {
      launcher.rateReport.mockResolvedValueOnce({ ...outcome, message: SECRET_TEXT });
      const p = await parts(await handleReportRate(rateReq(), deps));
      expect(p.status).toBe(status);
      expect(p.json.data).toEqual({ state });
      expect(p.text).not.toContain(SECRET_TEXT);
      expect(p.headers.get("Cache-Control")).toBe("no-store");
      launcher.respondReport.mockResolvedValueOnce(outcome);
      expect((await handleReportRespond(respondReq(), deps)).status).toBe(status);
    }
    launcher.rateReport.mockResolvedValueOnce({ state: "throttled", retryAfterMs: 4_200 });
    const t = await handleReportRate(rateReq(), deps);
    expect(t.status).toBe(429);
    expect(t.headers.get("Retry-After")).toBe("5");
    expect(launcher.readReport).not.toHaveBeenCalled();
  });

  it("BUG-0030: link_full is a 409 whose message is the shared sentence telling the participant to ask for a new link", async () => {
    launcher.respondReport.mockResolvedValueOnce({ state: "link_full" });
    const p = await parts(await handleReportRespond(respondReq(), deps));
    expect(p.status).toBe(409);
    expect(p.json.data).toEqual({ state: "link_full" });
    expect(p.json.error).toEqual({ code: "conflict", message: "This link has reached its limit of 25 responses. Ask your facilitator for a new link to send more." });
    expect(launcher.readReport).not.toHaveBeenCalled();
  });

  it("a per-credential write throttle answers 429 with Retry-After", async () => {
    for (let i = 0; i < 30; i += 1) expect((await handleReportRate(rateReq(), deps)).status).toBe(200);
    const res = await handleReportRespond(respondReq(), deps);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect(launcher.respondReport).not.toHaveBeenCalled();
  });

  it("success returns the re-read view", async () => {
    const p = await parts(await handleReportRate(rateReq(), deps));
    expect(p.status).toBe(200);
    expect(p.json.data).toEqual({ state: "released", view: { own: { title: "Fresh" } }, availableUntil: new Date(EXPIRES).toISOString() });
    expect(launcher.rateReport).toHaveBeenCalledWith(SID, CRED_ID, RATINGS.ratings);
    const r = await parts(await handleReportRespond(respondReq({ criterion: "c1", text: "no", dispute: true }), deps));
    expect(r.status).toBe(200);
    expect(launcher.respondReport).toHaveBeenCalledWith(SID, CRED_ID, { criterion: "c1", text: "no", dispute: true });
  });

  it("a failed re-read after a successful write answers 200 saved/retry", async () => {
    launcher.readReport.mockRejectedValueOnce(new LauncherError("unavailable"));
    const p = await parts(await handleReportRate(rateReq(), deps));
    expect(p.status).toBe(200);
    expect(p.json.data).toEqual({ saved: true, state: "retry" });
  });

  it("responses are no-store", async () => {
    for (const res of [await handleReportRate(rateReq(), deps), await handleReportRespond(respondReq(), deps), await handleReportRate(rateReq(RATINGS, { ...SAME_SITE, Origin: "https://x.example" }), deps)]) {
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    }
  });
});
