import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REPORT_REFUSALS } from "../../lib/messages";
import type { Config } from "../config";
import { CONSOLE_COOKIE, secretEpoch } from "../console-session";
import {
  handleConsoleReportAccept, handleConsoleReportCancel, handleConsoleReportComment, handleConsoleReportEdit, handleConsoleReportEditSummary,
  handleConsoleReportEvaluate, handleConsoleReportOpen, handleConsoleReportOverview, handleConsoleReportSubject,
} from "../console-report-handlers";
import { setEnvelopeClock } from "../envelope";
import type { Deps } from "../handlers";
import { LauncherClient } from "../launcher-client";
import { JoinThrottle } from "../throttle";
import { seal } from "../seal";
import { manualTimers } from "./fakes";

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
  `${CONSOLE_COOKIE}=${seal({ name, epoch: secretEpoch(SECRET), expiresAt: T0 + 3_600_000 }, KEYS, T0, "fac")}`;

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

const JOB = { state: "idle", startedAt: null, progress: [], modelCalls: null, outputDir: null };
const OVERVIEW = { stage: "not_evaluated", job: JOB, confirm: { upTo: 8 }, orphan: false, summary: null, subjects: [] };
/** What control answers a success with, by route: the job, the opened count, or the empty object of a review write. */
const fine = (s: Sent): Response => (/\/evaluate(\/cancel)?$/.test(s.url) ? good(JOB) : s.url.endsWith("/open") ? good({ subjects: 3 }) : good());
const VIEW = {
  id: "alice", state: "draft",
  criteria: [{ id: "clarity", name: "Clarity", current: 3, status: "needs_review", rationale: "r", evidence: [{ quote: "q" }], flags: [], selfLevel: 2 }],
  summary: { strengths: ["s"], developments: [], actions: [{ lo: "a", text: "t" }] }, objectives: [], comments: [], responses: [], versions: [],
};

beforeEach(() => {
  clock = T0;
  setEnvelopeClock(() => new Date(T0));
  sent = [];
  answer = fine;
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
    config, now: () => clock, launcher, setTimer: timers.setTimer,
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
const get = (path: string, cookie: string | null = COOKIE) => new Request(`${base}${path}`, { headers: cookie === null ? {} : { Cookie: cookie } });
const json = async (r: Response) => (await r.json()) as { success: boolean; data: unknown; error: { code: string; message: string } | null };

const EDIT = { criterion: "clarity", level: 3, reason: "Seen.", expect: "2", by: "priya" };

describe("console report handlers", () => {
  it("a write without the console cookie is 401", async () => {
    const calls: [string, Request][] = [
      ["evaluate", post("/evaluate", { confirmedCalls: 8, by: "priya" }, { cookie: null })],
      ["cancel", post("/evaluate/cancel", {}, { cookie: null })],
      ["open", post("/open", { by: "priya" }, { cookie: null })],
      ["edit", post("/subjects/alice/edit", EDIT, { cookie: null })],
    ];
    const fns = { evaluate: handleConsoleReportEvaluate, cancel: handleConsoleReportCancel, open: handleConsoleReportOpen, edit: handleConsoleReportEdit };
    for (const [name, req] of calls) {
      const res = await fns[name as keyof typeof fns](req, deps);
      expect([name, res.status]).toEqual([name, 401]);
    }
    expect((await handleConsoleReportOverview(get("", null), deps)).status).toBe(401);
    expect(sent).toEqual([]);
    expect(deps.consoleReportThrottle.size).toBe(0);
  });

  it("a cross-site write is refused before the throttle counts it", async () => {
    for (const extra of [{ Origin: "https://evil.example" }, { "X-Requested-With": null }, { "Sec-Fetch-Site": "cross-site" }] as Record<string, string | null>[]) {
      const res = await handleConsoleReportEvaluate(post("/evaluate", { confirmedCalls: 8, by: "priya" }, { extra }), deps);
      expect(res.status).toBe(403);
    }
    expect(deps.consoleReportThrottle.size).toBe(0);
    expect(sent).toEqual([]);
    // 60 refused cross-site writes leave the full budget for the real ones
    for (let i = 0; i < 70; i++) await handleConsoleReportOpen(post("/open", { by: "priya" }, { extra: { Origin: "https://evil.example" } }), deps);
    expect((await handleConsoleReportOpen(post("/open", { by: "priya" }), deps)).status).toBe(200);
  });

  it("a valid write forwards the typed name as by and nothing from the cookie", async () => {
    const res = await handleConsoleReportEvaluate(post("/evaluate", { confirmedCalls: 8, by: "priya" }), deps);
    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`${config.launcherUrl}/sessions/${SID}/report/evaluate`);
    expect(sent[0]!.body).toEqual({ confirmedCalls: 8, by: "priya" });
    expect(JSON.stringify(sent[0])).not.toContain("Cookie Name");
    expect(JSON.stringify(sent[0]!.headers)).not.toContain(CONSOLE_COOKIE);
    // the typed name is the author, whatever the cookie says; without one the write is refused
    expect((await handleConsoleReportOpen(post("/open", {}), deps)).status).toBe(400);
    const spaced = await handleConsoleReportOpen(post("/open", { by: "Pat Lee" }), deps);
    expect(spaced.status).toBe(400);
    const b = await json(spaced);
    expect(b.error).toEqual({ code: "invalid_name", message: "Use letters, digits, underscore or hyphen, up to 56 characters." });
    expect((await handleConsoleReportOpen(post("/open", { by: "x".repeat(57) }), deps)).status).toBe(400);
    expect(sent).toHaveLength(1);
    // every route forwards its typed fields field by field
    expect((await handleConsoleReportEdit(post("/subjects/alice/edit", { ...EDIT, rationale: "why" }), deps)).status).toBe(200);
    expect(sent.at(-1)!.url).toBe(`${config.launcherUrl}/sessions/${SID}/report/subjects/alice/edit`);
    expect(sent.at(-1)!.body).toEqual({ criterion: "clarity", level: 3, reason: "Seen.", rationale: "why", expect: "2", by: "priya" });
    expect((await handleConsoleReportAccept(post("/subjects/group/accept", { summary: true, by: "priya" }), deps)).status).toBe(200);
    expect(sent.at(-1)!.body).toEqual({ summary: true, by: "priya" });
    expect((await handleConsoleReportComment(post("/subjects/alice/comment", { text: "t", feedback: true, by: "priya" }), deps)).status).toBe(200);
    expect(sent.at(-1)!.body).toEqual({ text: "t", feedback: true, by: "priya" });
    expect((await handleConsoleReportEditSummary(post("/subjects/alice/edit-summary", { reason: "r", actions: [{ lo: "a", text: "t" }], by: "priya" }), deps)).status).toBe(200);
    expect(sent.at(-1)!.body).toEqual({ reason: "r", actions: [{ lo: "a", text: "t" }], by: "priya" });
    expect((await handleConsoleReportCancel(post("/evaluate/cancel", {}), deps)).status).toBe(200);
    expect(sent.at(-1)!.body).toEqual({});
  });

  it("rejects bodies that do not fit the route: unknown keys, wrong types, a bad subject or criterion", async () => {
    const bads: Request[] = [
      post("/evaluate", { confirmedCalls: "8", by: "priya" }), post("/evaluate", { confirmedCalls: 8, by: "priya", extra: 1 }),
      post("/evaluate", { confirmedCalls: 8.5, by: "priya" }), post("/evaluate", { confirmedCalls: 8, by: "priya" }, { extra: { "Content-Type": "text/plain" } }),
      post("/evaluate", null, { raw: "{ no" }), post("/open", { by: 5 }),
      post("/subjects/alice/edit", { ...EDIT, level: 5 }), post("/subjects/alice/edit", { ...EDIT, expect: "5" }), post("/subjects/alice/edit", { ...EDIT, criterion: "../x" }),
      post("/subjects/alice/accept", { summary: false, by: "priya" }), post("/subjects/alice/comment", { text: 5, by: "priya" }),
      post("/subjects/alice/edit-summary", { reason: "r", actions: [{ lo: "a" }], by: "priya" }),
    ];
    const fns = [handleConsoleReportEvaluate, handleConsoleReportEvaluate, handleConsoleReportEvaluate, handleConsoleReportEvaluate, handleConsoleReportEvaluate, handleConsoleReportOpen, handleConsoleReportEdit, handleConsoleReportEdit, handleConsoleReportEdit, handleConsoleReportAccept, handleConsoleReportComment, handleConsoleReportEditSummary];
    for (const [i, req] of bads.entries()) expect([i, (await fns[i]!(req, deps)).status]).toEqual([i, 400]);
    // a subject that is not `group` or a role id is 404 before anything is read or sent
    expect((await handleConsoleReportEdit(post("/subjects/..%2Fx/edit", EDIT), deps)).status).toBe(404);
    expect((await handleConsoleReportEdit(post("/subjects/a.b/edit", EDIT), deps)).status).toBe(404);
    expect(sent).toEqual([]);
  });

  it("an unknown control code maps to the generic sentence", async () => {
    answer = () => refused(409, "brand_new_code");
    const res = await handleConsoleReportOpen(post("/open", { by: "priya" }), deps);
    const b = await json(res);
    expect(b.error).toEqual({ code: "generic", message: REPORT_REFUSALS.generic });
    expect(JSON.stringify(b)).not.toContain("TEXT FROM CONTROL");
    expect(res.headers.get("Retry-After")).toBeNull();
    expect(res.headers.get("X-Control-Secret")).toBeNull();
  });

  it("every closed control code reaches the browser as its own fixed sentence and 409", async () => {
    for (const code of ["not_ended", "already_evaluated", "already_running", "too_many_running", "confirm_mismatch", "orphan", "no_review", "unknown_criterion", "stale", "blocked", "not_released", "not_editable", "superseded", "needs_amend", "refused"] as const) {
      answer = () => refused(409, code);
      const res = await handleConsoleReportOpen(post("/open", { by: "priya" }), deps);
      expect([code, res.status]).toEqual([code, 409]);
      expect((await json(res)).error).toEqual({ code, message: REPORT_REFUSALS[code] });
    }
    expect(REPORT_REFUSALS.orphan).toBe("A report folder for this session is damaged. See the rollback notes to remove it, then evaluate again.");
    // control answers an unknown subject 404 (as an unknown session), never 409: there is no unknown_subject sentence
    expect("unknown_subject" in REPORT_REFUSALS).toBe(false);
    answer = () => refused(409, "unknown_subject");
    expect((await json(await handleConsoleReportOpen(post("/open", { by: "priya" }), deps))).error).toEqual({ code: "generic", message: REPORT_REFUSALS.generic });
  });

  it("stale reaches the browser as the stale sentence only", async () => {
    answer = () => refused(409, "stale");
    const res = await handleConsoleReportEdit(post("/subjects/alice/edit", EDIT), deps);
    expect(res.status).toBe(409);
    const text = await res.text();
    expect(JSON.parse(text).error).toEqual({ code: "stale", message: "Someone changed this. Reload the level and try again." });
    expect(text).not.toContain("TEXT FROM CONTROL");
    expect(text).not.toContain("/srv");
    expect([...res.headers.keys()].some((k) => /^x-control|retry-after/i.test(k))).toBe(false);
  });

  it("blocked carries safe subject ids only", async () => {
    answer = () => refused(409, "blocked", { blocked: ["alice", "bob", "../etc", "x y", 5, "g".repeat(65)] });
    const res = await handleConsoleReportOpen(post("/open", { by: "priya" }), deps);
    expect(res.status).toBe(409);
    expect((await json(res)).data).toEqual({ blocked: ["alice", "bob"] });
  });

  it("busy, unavailable and not found are fixed answers; control's Retry-After is not copied", async () => {
    answer = () => refused(503, "busy");
    const busy = await handleConsoleReportOpen(post("/open", { by: "priya" }), deps);
    expect([busy.status, (await json(busy)).error]).toEqual([503, { code: "busy", message: REPORT_REFUSALS.busy }]);
    expect(busy.headers.get("Retry-After")).toBe("2");
    answer = () => refused(503, "unavailable");
    expect((await json(await handleConsoleReportOpen(post("/open", { by: "priya" }), deps))).error).toEqual({ code: "unavailable", message: REPORT_REFUSALS.unavailable });
    answer = () => refused(404, "not_found");
    expect((await handleConsoleReportOverview(get(""), deps)).status).toBe(404);
    answer = () => refused(400, "invalid");
    expect((await json(await handleConsoleReportOpen(post("/open", { by: "priya" }), deps))).error).toEqual({ code: "invalid", message: REPORT_REFUSALS.invalid });
  });

  it("the control timeout (15 s, injected clock) is 504 with a fixed sentence", async () => {
    answer = () => new Promise<Response>(() => {}); // control never answers
    const pending = handleConsoleReportOpen(post("/open", { by: "priya" }), deps);
    await vi.waitFor(() => expect(timers.live().map((t) => t.ms)).toContain(15_000));
    timers.fire(15_000);
    const res = await pending;
    expect(res.status).toBe(504);
    expect((await json(res)).error).toEqual({ code: "timeout", message: REPORT_REFUSALS.timeout });
    // an answer in time cancels the timer
    answer = fine;
    await handleConsoleReportOpen(post("/open", { by: "priya" }), deps);
    expect(timers.live()).toEqual([]);
  });

  it("a body over the cap is 413", async () => {
    const big = (n: number) => JSON.stringify({ reason: "r", by: "priya", pad: "x".repeat(n) });
    const over4k = await handleConsoleReportAccept(post("/subjects/alice/accept", null, { raw: JSON.stringify({ summary: true, by: "priya", pad: "x".repeat(4096) }) }), deps);
    expect(over4k.status).toBe(413);
    expect((await json(over4k)).error).toEqual({ code: "payload_too_large", message: REPORT_REFUSALS.payload_too_large });
    // an edit's reason (500) and rationale (1,500 characters) in CJK are about 6 KB: edit takes the 16 KB cap, as comment and edit-summary
    const cjk = (n: number) => "\u8a55".repeat(n);
    expect((await handleConsoleReportEdit(post("/subjects/alice/edit", { ...EDIT, reason: cjk(500), rationale: cjk(1500) }), deps)).status).toBe(200);
    expect((await handleConsoleReportEdit(post("/subjects/alice/edit", { ...EDIT, rationale: "x".repeat(16 * 1024) }), deps)).status).toBe(413);
    // comment and edit-summary may carry up to 16 KB
    const okText = await handleConsoleReportComment(post("/subjects/alice/comment", { text: "x".repeat(8000), by: "priya" }), deps);
    expect(okText.status).toBe(200);
    expect((await handleConsoleReportComment(post("/subjects/alice/comment", { text: "x".repeat(16 * 1024), by: "priya" }), deps)).status).toBe(413);
    expect((await handleConsoleReportEditSummary(post("/subjects/alice/edit-summary", null, { raw: big(16 * 1024) }), deps)).status).toBe(413);
    expect(sent).toHaveLength(2);
  });

  it("61 writes in a minute from one cookie are throttled", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await handleConsoleReportOpen(post("/open", { by: "priya" }), deps)).status);
    expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true);
    expect(statuses[60]).toBe(429);
    const again = await handleConsoleReportOpen(post("/open", { by: "priya" }), deps);
    expect(again.status).toBe(429);
    expect(Number(again.headers.get("Retry-After"))).toBeGreaterThan(0);
    // another cookie has its own budget; reads are not counted; the window passes
    expect((await handleConsoleReportOpen(post("/open", { by: "priya" }, { cookie: consoleCookie("Other") }), deps)).status).toBe(200);
    answer = () => good(OVERVIEW);
    expect((await handleConsoleReportOverview(get(""), deps)).status).toBe(200);
    clock += 61_000;
    answer = fine;
    expect((await handleConsoleReportOpen(post("/open", { by: "priya" }), deps)).status).toBe(200);
  });

  it("reads: the overview and the subject view are parsed and sent on field by field", async () => {
    answer = () => good({ ...OVERVIEW, port: 4321, extra: "dropped" });
    const o = await json(await handleConsoleReportOverview(get(""), deps));
    const { outputDir: _dropped, ...browserJob } = JOB;
    expect(o.data).toEqual({ ...OVERVIEW, job: browserJob });
    expect(sent[0]!.url).toBe(`${config.launcherUrl}/sessions/${SID}/report`);
    answer = () => good({ ...VIEW, secret: "dropped" });
    const v = await json(await handleConsoleReportSubject(get("/subjects/alice"), deps));
    expect(v.data).toEqual(VIEW);
    expect(sent[1]!.url).toBe(`${config.launcherUrl}/sessions/${SID}/report/subjects/alice`);
    expect((await handleConsoleReportSubject(get("/subjects/a.b"), deps)).status).toBe(404);
    expect((await handleConsoleReportOverview(new Request(`${ORIGIN}/api/v1/console/sessions/bad%20id/report`, { headers: { Cookie: COOKIE } }), deps)).status).toBe(404);
  });

  it("the subject-view parser rejects an unknown level value (fails closed)", async () => {
    for (const mutate of [
      (v: typeof VIEW) => ({ ...v, criteria: [{ ...v.criteria[0]!, current: 5 }] }),
      (v: typeof VIEW) => ({ ...v, criteria: [{ ...v.criteria[0]!, selfLevel: "na" }] }),
      (v: typeof VIEW) => ({ ...v, state: "published" }),
      (v: typeof VIEW) => ({ ...v, criteria: [{ ...v.criteria[0]!, status: "maybe" }] }),
      (v: typeof VIEW) => ({ ...v, comments: [{ visibility: "public", text: "t" }] }),
    ]) {
      answer = () => good(mutate(VIEW));
      const res = await handleConsoleReportSubject(get("/subjects/alice"), deps);
      expect(res.status).toBe(502);
      expect(JSON.stringify(await json(res))).not.toContain("published");
    }
    // the overview fails closed on an unknown stage, job state or subject state too
    for (const o of [{ ...OVERVIEW, stage: "released" }, { ...OVERVIEW, job: { ...JOB, state: "paused" } }, { ...OVERVIEW, subjects: [{ id: "alice", state: "x" }] }]) {
      answer = () => good(o);
      expect((await handleConsoleReportOverview(get(""), deps)).status).toBe(502);
    }
  });

  it("the subject view may exceed the usual 1 MB cap (up to the larger report cap); the overview may not", async () => {
    const bigView = { ...VIEW, summary: { ...VIEW.summary, strengths: ["x".repeat(2 * 1024 * 1024)] } };
    answer = () => good(bigView);
    expect((await handleConsoleReportSubject(get("/subjects/alice"), deps)).status).toBe(200);
    answer = () => good({ ...OVERVIEW, summary: { npcReplies: 0, fallbackReplies: 0, scenesEndedByGm: 0, byCharacter: [], alerts: [{ seq: 1, level: "info", role: null, fallback: false, reason: "x".repeat(2 * 1024 * 1024), replySeq: null }] } });
    expect((await handleConsoleReportOverview(get(""), deps)).status).toBe(502);
  });

  it("an unexpected throw is the neutral 502 and nothing of it is echoed or logged", async () => {
    const logs: string[] = [];
    vi.mocked(console.error).mockImplementation((...a) => { logs.push(a.join(" ")); });
    (deps as { launcher: unknown }).launcher = { reportOpen: () => { throw new TypeError("secret /srv/path"); } };
    const res = await handleConsoleReportOpen(post("/open", { by: "priya" }), deps);
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain("/srv");
    expect(logs.join(" ")).not.toContain("/srv");
  });

  it("without a launcher every route is the unavailable answer", async () => {
    delete (deps as { launcher?: unknown }).launcher;
    expect((await handleConsoleReportOpen(post("/open", { by: "priya" }), deps)).status).toBe(503);
    expect((await handleConsoleReportOverview(get(""), deps)).status).toBe(503);
  });
});

describe("console report: clearer sentences and tighter parsers", () => {
  it("the timeout, blocked and no_review sentences say what to do next", () => {
    expect(REPORT_REFUSALS.timeout).toBe("The report service took too long to answer. Reload to see whether it was saved, then try again.");
    expect(REPORT_REFUSALS.blocked).toBe("Some reports still have open items. Resolve them, then try again.");
    expect(REPORT_REFUSALS.no_review).toBe("The review has not been opened yet. Open it first.");
  });

  it("the browser never receives the job's output folder", async () => {
    answer = () => good({ ...OVERVIEW, job: { ...JOB, state: "done", modelCalls: 4, outputDir: "s-0123456789abcdef-2" } });
    const o = (await json(await handleConsoleReportOverview(get(""), deps))).data as { job: Record<string, unknown> };
    expect(o.job).toEqual({ state: "done", startedAt: null, progress: [], modelCalls: 4 });
    expect(JSON.stringify(o)).not.toContain("0123456789abcdef-2");
    answer = () => good({ ...JOB, state: "running", outputDir: "s-0123456789abcdef-2" });
    const e = (await json(await handleConsoleReportEvaluate(post("/evaluate", { confirmedCalls: 8, by: "priya" }), deps))).data as Record<string, unknown>;
    expect("outputDir" in e).toBe(false);
  });

  it("the job's progress is at most 50 lines of bounded length (fails closed beyond)", async () => {
    answer = () => good({ ...OVERVIEW, job: { ...JOB, progress: Array.from({ length: 50 }, () => "evaluating alice") } });
    expect((await handleConsoleReportOverview(get(""), deps)).status).toBe(200);
    for (const progress of [Array.from({ length: 51 }, () => "evaluating alice"), ["x".repeat(201)]]) {
      answer = () => good({ ...OVERVIEW, job: { ...JOB, progress } });
      expect((await handleConsoleReportOverview(get(""), deps)).status).toBe(502);
    }
  });

  it("subject ids, criterion ids and open criteria must be file-safe ids (fails closed)", async () => {
    const ROW = { id: "alice", state: "draft", version: 1, criteriaTotal: 2, openCriteria: ["clarity"], summaryStale: false, tableStale: false, evaluationOk: false, scoreByHand: ["clarity"], selfRated: 0, openDisputes: [] };
    answer = () => good({ ...OVERVIEW, subjects: [ROW] });
    const res = await handleConsoleReportOverview(get(""), deps);
    expect(res.status).toBe(200);
    // the facts the panel needs to say a subject is still blocked reach the browser
    expect(((await json(res)).data as { subjects: unknown[] }).subjects[0]).toMatchObject({ evaluationOk: false, scoreByHand: ["clarity"] });
    for (const scoreByHand of [["Bad Id"], undefined, "clarity"]) {
      answer = () => good({ ...OVERVIEW, subjects: [{ ...ROW, scoreByHand }] });
      expect((await handleConsoleReportOverview(get(""), deps)).status).toBe(502);
    }
    answer = () => good({ ...OVERVIEW, subjects: [{ ...ROW, openCriteria: ["Bad Id"] }] });
    expect((await handleConsoleReportOverview(get(""), deps)).status).toBe(502);
    for (const v of [{ ...VIEW, id: "../alice" }, { ...VIEW, criteria: [{ ...VIEW.criteria[0]!, id: "<b>" }] }]) {
      answer = () => good(v);
      expect((await handleConsoleReportSubject(get("/subjects/alice"), deps)).status).toBe(502);
    }
  });
});
