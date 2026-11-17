import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REPORT_REFUSALS } from "../../lib/messages";
import type { Config } from "../config";
import { CONSOLE_COOKIE, secretEpoch } from "../console-session";
import {
  handleConsoleReportHide, handleConsoleReportSubject,
} from "../console-report-handlers";
import { setEnvelopeClock } from "../envelope";
import type { Deps } from "../handlers";
import { LauncherClient } from "../launcher-client";
import { JoinThrottle } from "../throttle";
import { seal } from "../seal";
import { manualTimers } from "./fakes";
import { legacyCookieValue, withConsoleAuth } from "../test-support/console-fixtures";

const ORIGIN = "https://play.example.org";
const KEYS: Config["cookieKeys"] = [{ id: "k1", key: Buffer.alloc(32, 7) }];
const SECRET = "correct horse battery staple";
const T0 = 1_900_000_000_000;
const SID = "s-0123456789abcdef";
const TOKEN = "launcher-token-" + "t".repeat(20);
const config: Config = {
  runtimeUrl: "ws://127.0.0.1:1", publicOrigin: ORIGIN, cookieKeys: KEYS, cookieMaxAgeHours: 12, maxStreams: 10, maxStreamsPerSession: 10, maxStreamsPerAddress: 10,
  facilitatorSecret: SECRET, launcherUrl: "http://127.0.0.1:47123", launcherToken: TOKEN,
};
// US-0083 Task 6: a LEGACY (shared secret) cookie, so this file keeps testing the typed-name rule (`by` from the body) and the per-cookie
// write throttle that legacy sign-ins keep. An account's server-side `by` (accountSlug) and per-account throttle: console-ownership.test.ts.
const consoleCookie = (name = "Cookie Name") =>
  `${CONSOLE_COOKIE}=${legacyCookieValue(name, { keys: KEYS, now: T0, secret: SECRET, expiresAt: T0 + 3_600_000 })}`;

/** One browser session: the same cookie value on every request (a fresh seal differs each time, so it is made once). */
const COOKIE = consoleCookie();
type Sent = { method: string; url: string; body: unknown; headers: Record<string, string> };
let sent: Sent[];
/** What the fake control service answers next: [status, envelope, extra headers]. */
let answer: (s: Sent) => Promise<Response> | Response;
let timers: ReturnType<typeof manualTimers>;
let deps: Deps;
let clock: number;

const env = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const good = (data: unknown = {}) => env(200, { success: true, data, error: null });
const refused = (status: number, code: string, data: unknown = null, message = "TEXT FROM CONTROL /srv/secret") =>
  env(status, { success: false, data, error: { code, message } }, { "Retry-After": "9", "X-Control-Secret": "nope" });

beforeEach(() => {
  clock = T0;
  setEnvelopeClock(() => new Date(T0));
  sent = [];
  answer = () => good();
  timers = manualTimers();
  const launcher = new LauncherClient({
    baseUrl: config.launcherUrl!, token: TOKEN,
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      const s: Sent = { method: init?.method ?? "GET", url: String(url), body: init?.body === undefined ? undefined : JSON.parse(String(init.body)), headers: init?.headers as Record<string, string> };
      sent.push(s);
      return answer(s);
    }) as typeof fetch,
  });
  deps = {
    config, now: () => clock, launcher: withConsoleAuth(launcher), setTimer: timers.setTimer,
    consoleReportThrottle: new JoinThrottle({ max: 60, windowMs: 60_000, blockMs: 60_000, now: () => clock }),
  } as unknown as Deps;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

const base = `${ORIGIN}/api/v1/console/sessions/${SID}/report`;
const headers = (o: { cookie?: string | null; extra?: Record<string, string | null> } = {}) => {
  const h: Record<string, string> = { Origin: ORIGIN, "X-Requested-With": "scenecoach", "Content-Type": "application/json" };
  const c = o.cookie === undefined ? COOKIE : o.cookie;
  if (c !== null) h.Cookie = c;
  for (const [k, v] of Object.entries(o.extra ?? {})) { if (v === null) delete h[k]; else h[k] = v; }
  return h;
};
const post = (path: string, body: unknown, o: Parameters<typeof headers>[0] & { raw?: string } = {}) =>
  new Request(`${base}${path}`, { method: "POST", headers: headers(o), body: o.raw ?? JSON.stringify(body) });
const json = async (r: Response) => (await r.json()) as { success: boolean; data: unknown; error: { code: string; message: string } | null };


const get = (path: string) => new Request(`${base}${path}`, { headers: { Cookie: COOKIE } });
const hide = (body: unknown, o: Parameters<typeof headers>[0] = {}) => post("/hide", body, o);
const OK = { seq: 4, reason: "Has a phone number.", by: "priya" };
const VIEW = {
  id: "alice", state: "draft",
  criteria: [{ id: "clarity", name: "Clarity", current: 3, status: "needs_review", rationale: "r", evidence: [{ quote: "q" }], flags: [] }],
  summary: { strengths: ["s"], developments: [], actions: [] }, objectives: [], comments: [], versions: [],
};
const withResponses = (responses: unknown[]) => good({ ...VIEW, responses });
const VISIBLE = { seq: 2, role: "alice", text: "hello", dispute: false };
const HIDDEN = { seq: 3, role: "alice", dispute: false, hidden: { reason: "phone", by: "priya-console", at: 1_900_000_000_000 } };

describe("console report hide handler", () => {
  it("forwards seq, reason and by to control's hide route and answers an empty object", async () => {
    const res = await handleConsoleReportHide(hide(OK), deps);
    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual({});
    expect(sent.at(-1)!.method).toBe("POST");
    expect(sent.at(-1)!.url).toBe(`${config.launcherUrl}/sessions/${SID}/report/hide`);
    expect(sent.at(-1)!.body).toEqual(OK);
  });

  it("refuses extra keys, a bad seq and a missing or non-string reason as 400 before anything is sent", async () => {
    for (const bad of [{ extra: 1 }, { seq: 0 }, { seq: 1.5 }, { seq: "1" }, { seq: 1_000_000_000 }, { reason: 5 }, { reason: undefined }, { outcome: "upheld" }]) {
      const r = await handleConsoleReportHide(hide({ ...OK, ...bad }), deps);
      expect([JSON.stringify(bad), r.status]).toEqual([JSON.stringify(bad), 400]);
    }
    expect(sent).toEqual([]);
  });

  it("takes the 16 KB text cap", async () => {
    expect((await handleConsoleReportHide(hide({ ...OK, reason: "é".repeat(5000) }), deps)).status).toBe(200);
    const r = await handleConsoleReportHide(hide({ ...OK, reason: "x".repeat(17 * 1024) }), deps);
    expect(r.status).toBe(413);
    expect((await json(r)).error!.message).toBe(REPORT_REFUSALS.payload_too_large);
  });

  it("needs the cookie, the typed name and a same-site write; a cross-site write is refused before the throttle", async () => {
    for (const extra of [{ Origin: "https://evil.example" }, { "X-Requested-With": null }, { "Sec-Fetch-Site": "cross-site" }] as Record<string, string | null>[])
      expect((await handleConsoleReportHide(hide(OK, { extra }), deps)).status).toBe(403);
    expect(deps.consoleReportThrottle.size).toBe(0);
    expect((await handleConsoleReportHide(hide(OK, { cookie: null }), deps)).status).toBe(401);
    expect((await handleConsoleReportHide(hide({ seq: 4, reason: "r" }), deps)).status).toBe(400);
    const bad = await handleConsoleReportHide(hide({ ...OK, by: "Pat Lee" }), deps);
    expect([bad.status, (await json(bad)).error!.code]).toEqual([400, "invalid_name"]);
    expect(sent).toEqual([]);
    for (let i = 0; i < 70; i++) await handleConsoleReportHide(hide(OK), deps);
    expect((await handleConsoleReportHide(hide(OK), deps)).status).toBe(429);
  });

  it("answers control's closed refusal codes with the fixed sentences, a superseded review as 409", async () => {
    for (const code of ["superseded", "no_review", "refused"] as const) {
      answer = () => refused(409, code);
      const r = await handleConsoleReportHide(hide(OK), deps);
      expect([code, r.status, (await json(r)).error!.message]).toEqual([code, 409, REPORT_REFUSALS[code]]);
    }
  });

  it("a non-object answer from control closes as 502", async () => {
    answer = () => good("nope");
    expect((await handleConsoleReportHide(hide(OK), deps)).status).toBe(502);
  });
});

describe("the subject view's responses, with a hidden one", () => {
  it("passes a visible response and a hidden one (no text) through", async () => {
    answer = () => withResponses([VISIBLE, HIDDEN]);
    const res = await handleConsoleReportSubject(get("/subjects/alice"), deps);
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({ responses: [VISIBLE, HIDDEN] });
  });

  it.each([
    ["a hidden response that carries text", { ...HIDDEN, text: "secret" }],
    ["a visible response without text", { seq: 2, role: "alice", dispute: false }],
    ["a hidden marker without a reason", { ...HIDDEN, hidden: { by: "p", at: 1 } }],
    ["a hidden marker without a by", { ...HIDDEN, hidden: { reason: "r", at: 1 } }],
    ["a hidden marker with a non-finite at", { ...HIDDEN, hidden: { reason: "r", by: "p", at: "1" } }],
    ["a hidden marker that is not an object", { ...HIDDEN, hidden: true }],
  ])("closes as 502 on %s", async (_n, r) => {
    answer = () => withResponses([r]);
    expect((await handleConsoleReportSubject(get("/subjects/alice"), deps)).status).toBe(502);
  });
});
