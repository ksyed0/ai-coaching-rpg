import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REPORT_REFUSALS } from "../../lib/messages";
import type { Config } from "../config";
import { CONSOLE_COOKIE, secretEpoch } from "../console-session";
import {
  handleConsoleReportAmend, handleConsoleReportExport, handleConsoleReportRelease, handleConsoleReportResolve, handleConsoleReportWithdraw,
} from "../console-report-handlers";
import { setEnvelopeClock } from "../envelope";
import type { Deps } from "../handlers";
import { LauncherClient } from "../launcher-client";
import { JoinThrottle } from "../throttle";
import { seal } from "../seal";
import { manualTimers } from "./fakes";
import { accountCookieValue, adminNamed, withConsoleAuth } from "../test-support/console-fixtures";

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
const consoleCookie = (name = "Cookie Name") =>
  `${CONSOLE_COOKIE}=${accountCookieValue(adminNamed(name), { keys: KEYS, now: T0, expiresAt: T0 + 3_600_000 })}`;

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


const EXPORT_OK = { fileName: "report-alice.md", markdown: "# Alice\n\nBody." };
const exportReq = (body: unknown = { subject: "alice", audience: "facilitator", by: "priya" }, o: Parameters<typeof headers>[0] = {}) => post("/export", body, o);

describe("console report handlers, part B", () => {
  it("export by GET is 404 and by a cross-site POST is refused before the throttle", async () => {
    const g = await handleConsoleReportExport(new Request(`${base}/export`, { headers: { Cookie: COOKIE } }), deps);
    expect(g.status).toBe(404);
    for (const extra of [{ Origin: "https://evil.example" }, { "X-Requested-With": null }, { "Sec-Fetch-Site": "cross-site" }] as Record<string, string | null>[]) {
      expect((await handleConsoleReportExport(exportReq(undefined, { extra }), deps)).status).toBe(403);
    }
    expect(deps.consoleReportThrottle.size).toBe(0);
    expect(sent).toEqual([]);
  });

  it("the export response headers are exactly the four above", async () => {
    answer = () => good(EXPORT_OK);
    const res = await handleConsoleReportExport(exportReq(), deps);
    expect(res.status).toBe(200);
    expect(Object.fromEntries(res.headers.entries())).toEqual({
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": 'attachment; filename="report-alice.md"',
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    expect(await res.text()).toBe(EXPORT_OK.markdown);
    expect(sent[0]!.url).toBe(`${config.launcherUrl}/sessions/${SID}/report/export`);
    expect(sent[0]!.body).toEqual({ subject: "alice", audience: "facilitator", by: "priya" });
    // control's headers are never copied, and an unknown key or audience is refused
    answer = () => new Response(JSON.stringify({ success: true, data: EXPORT_OK, error: null }), { status: 200, headers: { "Content-Type": "application/json", "Set-Cookie": "a=b", "X-Control-Secret": "nope" } });
    const again = await handleConsoleReportExport(exportReq({ subject: "alice", audience: "participant:alice", by: "priya" }), deps);
    expect(again.headers.get("set-cookie")).toBeNull();
    expect(again.headers.get("x-control-secret")).toBeNull();
    expect((await handleConsoleReportExport(exportReq({ subject: "alice", audience: "everyone", by: "priya" }), deps)).status).toBe(400);
    expect((await handleConsoleReportExport(exportReq({ subject: "../x", audience: "facilitator", by: "priya" }), deps)).status).toBe(400);
    expect((await handleConsoleReportExport(exportReq({ subject: "alice", audience: "facilitator", by: "priya", path: "/etc" }), deps)).status).toBe(400);
  });

  it("export audience: participant: with an empty, slashed or 65-character id is 400 before control; a 64-character id is forwarded", async () => {
    for (const audience of ["participant:", "participant:a/b", `participant:${"a".repeat(65)}`]) {
      const r = await handleConsoleReportExport(exportReq({ subject: "alice", audience, by: "priya" }), deps);
      expect([audience.slice(0, 20), r.status]).toEqual([audience.slice(0, 20), 400]);
    }
    expect(sent).toEqual([]);
    answer = () => good(EXPORT_OK);
    const long = `participant:${"a".repeat(64)}`;
    expect((await handleConsoleReportExport(exportReq({ subject: "alice", audience: long, by: "priya" }), deps)).status).toBe(200);
    expect(sent[0]!.body).toEqual({ subject: "alice", audience: long, by: "priya" });
  });

  it("an unknown subject is 404 with its own fixed sentence; an unknown session keeps the session sentence", async () => {
    answer = () => env(404, { success: false, data: null, error: { code: "unknown_subject" } });
    let r = await handleConsoleReportAmend(post("/subjects/alice/amend", { reason: "r", by: "priya" }), deps);
    expect([r.status, (await json(r)).error]).toEqual([404, { code: "unknown_subject", message: "That report was not found. Reload the page." }]);
    answer = () => refused(404, "not_found");
    r = await handleConsoleReportAmend(post("/subjects/alice/amend", { reason: "r", by: "priya" }), deps);
    expect([r.status, (await json(r)).error]).toEqual([404, { code: "not_found", message: "That session was not found." }]);
  });

  it("a bad fileName is replaced by report.md", async () => {
    for (const bad of ['report-a".md', "../report-a.md", "report-a.md\r\nX: y", "report-.md", "notes.md", "report-a.txt", "report-" + "a".repeat(65) + ".md", 7, null]) {
      answer = () => good({ fileName: bad, markdown: "m" });
      const res = await handleConsoleReportExport(exportReq(), deps);
      expect([bad, res.status, res.headers.get("content-disposition")]).toEqual([bad, 200, 'attachment; filename="report.md"']);
    }
    answer = () => good({ fileName: "report-index.md", markdown: "m" });
    expect((await handleConsoleReportExport(exportReq(), deps)).headers.get("content-disposition")).toBe('attachment; filename="report-index.md"');
    answer = () => good({ markdown: 5 });
    expect((await handleConsoleReportExport(exportReq(), deps)).status).toBe(502);
  });

  it("release forwards an explicit list unchanged and refuses all", async () => {
    answer = () => good({ released: ["alice", "group"], groupTableStale: true });
    const res = await handleConsoleReportRelease(post("/release", { subjects: ["alice", "group"], by: "priya" }), deps);
    expect(res.status).toBe(200);
    expect(sent[0]!.url).toBe(`${config.launcherUrl}/sessions/${SID}/report/release`);
    expect(sent[0]!.body).toEqual({ subjects: ["alice", "group"], by: "priya" });
    expect((await json(res)).data).toEqual({ released: ["alice", "group"], groupTableStale: true });
    const n = sent.length;
    for (const body of [
      { all: true, by: "priya" }, { subjects: [], by: "priya" }, { subjects: ["alice"], all: true, by: "priya" }, { subjects: "all", by: "priya" },
      { subjects: ["a b"], by: "priya" }, { subjects: Array.from({ length: 51 }, (_, i) => `r${i}`), by: "priya" }, { by: "priya" },
    ]) {
      const r = await handleConsoleReportRelease(post("/release", body), deps);
      expect([JSON.stringify(body).slice(0, 40), r.status]).toEqual([JSON.stringify(body).slice(0, 40), 400]);
      expect((await json(r)).error!.message).toBe("The request could not be read.");
    }
    expect(sent).toHaveLength(n);
    const fifty = Array.from({ length: 50 }, (_, i) => `r${i}`);
    expect((await handleConsoleReportRelease(post("/release", { subjects: fifty, by: "priya" }), deps)).status).toBe(200);
    expect((sent.at(-1)!.body as { subjects: string[] }).subjects).toEqual(fifty);
    answer = () => good({ released: "alice", groupTableStale: true });
    expect((await handleConsoleReportRelease(post("/release", { subjects: ["alice"], by: "priya" }), deps)).status).toBe(502);
  });

  it("blocked maps to a fixed sentence plus the subject ids and nothing else", async () => {
    answer = () => refused(409, "blocked", { blocked: ["alice", "../x", "bob"], path: "/srv/x" });
    const res = await handleConsoleReportRelease(post("/release", { subjects: ["alice", "bob"], by: "priya" }), deps);
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({ success: false, data: { blocked: ["alice", "bob"] }, error: { code: "blocked", message: REPORT_REFUSALS.blocked }, meta: expect.anything() });
    expect(res.headers.get("retry-after")).toBeNull();
    expect(res.headers.get("x-control-secret")).toBeNull();
  });

  it("resolve, amend and withdraw forward field by field, with the 16 KB text cap; the others cap at 4 KB", async () => {
    expect((await handleConsoleReportResolve(post("/resolve", { seq: 4, outcome: "upheld", reason: "ok", by: "priya" }), deps)).status).toBe(200);
    expect(sent.at(-1)!.url).toBe(`${config.launcherUrl}/sessions/${SID}/report/resolve`);
    expect(sent.at(-1)!.body).toEqual({ seq: 4, outcome: "upheld", reason: "ok", by: "priya" });
    expect((await json(await handleConsoleReportResolve(post("/resolve", { seq: 4, outcome: "declined", reason: "ok", by: "priya" }), deps))).data).toEqual({});
    for (const bad of [{ seq: 0 }, { seq: 1.5 }, { seq: "1" }, { seq: 1_000_000_000 }, { outcome: "maybe" }, { reason: 5 }]) {
      const r = await handleConsoleReportResolve(post("/resolve", { seq: 4, outcome: "upheld", reason: "ok", by: "priya", ...bad }), deps);
      expect([JSON.stringify(bad), r.status]).toEqual([JSON.stringify(bad), 400]);
    }
    expect((await handleConsoleReportAmend(post("/subjects/alice/amend", { reason: "typo", by: "priya" }), deps)).status).toBe(200);
    expect(sent.at(-1)!.url).toBe(`${config.launcherUrl}/sessions/${SID}/report/subjects/alice/amend`);
    expect(sent.at(-1)!.body).toEqual({ reason: "typo", by: "priya" });
    answer = () => good({ groupTableStale: false });
    const w = await handleConsoleReportWithdraw(post("/subjects/group/withdraw", { reason: "wrong", by: "priya" }), deps);
    expect(w.status).toBe(200);
    expect(sent.at(-1)!.url).toBe(`${config.launcherUrl}/sessions/${SID}/report/subjects/group/withdraw`);
    expect((await json(w)).data).toEqual({ groupTableStale: false });
    answer = () => good({ groupTableStale: "no" });
    expect((await handleConsoleReportWithdraw(post("/subjects/alice/withdraw", { reason: "x", by: "priya" }), deps)).status).toBe(502);
    answer = () => good();
    expect((await handleConsoleReportAmend(post("/subjects/..%2Fx/amend", { reason: "x", by: "priya" }), deps)).status).toBe(404);
    expect((await handleConsoleReportAmend(post("/subjects/alice/amend", { by: "priya" }), deps)).status).toBe(400);

    answer = () => good({ groupTableStale: false });
    const n = sent.length;
    const long = "é".repeat(5000); // 10 KB: over 4 KB, under 16 KB
    for (const [fn, path, body] of [
      [handleConsoleReportResolve, "/resolve", { seq: 1, outcome: "upheld", reason: long, by: "priya" }],
      [handleConsoleReportAmend, "/subjects/alice/amend", { reason: long, by: "priya" }],
      [handleConsoleReportWithdraw, "/subjects/alice/withdraw", { reason: long, by: "priya" }],
    ] as const) expect([path, (await fn(post(path, body), deps)).status]).toEqual([path, 200]);
    const huge = "x".repeat(17 * 1024);
    for (const [fn, path, body] of [
      [handleConsoleReportResolve, "/resolve", { seq: 1, outcome: "upheld", reason: huge, by: "priya" }],
      [handleConsoleReportAmend, "/subjects/alice/amend", { reason: huge, by: "priya" }],
      [handleConsoleReportWithdraw, "/subjects/alice/withdraw", { reason: huge, by: "priya" }],
    ] as const) {
      const r = await fn(post(path, body), deps);
      expect([path, r.status]).toEqual([path, 413]);
      expect((await json(r)).error!.message).toBe(REPORT_REFUSALS.payload_too_large);
    }
    for (const [fn, path, body] of [
      [handleConsoleReportRelease, "/release", { subjects: ["alice"], by: "priya", pad: "" }],
      [handleConsoleReportExport, "/export", { subject: "alice", audience: "facilitator", by: "priya", pad: "" }],
    ] as const) {
      const r = await fn(post(path, body, { raw: JSON.stringify({ ...body, pad: "x".repeat(5000) }) }), deps);
      expect([path, r.status]).toEqual([path, 413]);
    }
    expect(sent).toHaveLength(n + 3);
  });

  it("every part B route needs the cookie, the typed name and the write throttle; closed codes use the fixed sentences", async () => {
    const routes: [string, (r: Request, d: Deps) => Promise<Response>, unknown][] = [
      ["/release", handleConsoleReportRelease, { subjects: ["alice"] }],
      ["/resolve", handleConsoleReportResolve, { seq: 1, outcome: "upheld", reason: "r" }],
      ["/export", handleConsoleReportExport, { subject: "alice", audience: "facilitator" }],
      ["/subjects/alice/amend", handleConsoleReportAmend, { reason: "r" }],
      ["/subjects/alice/withdraw", handleConsoleReportWithdraw, { reason: "r" }],
    ];
    for (const [path, fn, body] of routes) {
      expect([path, (await fn(post(path, { ...(body as object), by: "priya" }, { cookie: null }), deps)).status]).toEqual([path, 401]);
      expect([path, (await fn(post(path, body), deps)).status]).toEqual([path, 400]);
      const bad = await fn(post(path, { ...(body as object), by: "Pat Lee" }), deps);
      expect([path, bad.status, (await json(bad)).error!.code]).toEqual([path, 400, "invalid_name"]);
    }
    expect(sent).toEqual([]);
    for (const code of ["not_released", "needs_amend", "not_editable", "superseded", "no_review", "refused"] as const) {
      answer = () => refused(409, code);
      const r = await handleConsoleReportWithdraw(post("/subjects/alice/withdraw", { reason: "r", by: "priya" }), deps);
      expect([code, r.status, (await json(r)).error!.message]).toEqual([code, 409, REPORT_REFUSALS[code]]);
    }
    answer = () => good();
    for (let i = 0; i < 70; i++) await handleConsoleReportAmend(post("/subjects/alice/amend", { reason: "r", by: "priya" }), deps);
    expect((await handleConsoleReportRelease(post("/release", { subjects: ["alice"], by: "priya" }), deps)).status).toBe(429);
    expect((await handleConsoleReportExport(exportReq(), deps)).status).toBe(429);
  });
});
