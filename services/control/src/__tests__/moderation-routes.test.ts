import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { loadScenario } from "@acr/script";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../../../runtime/src/engine/clock.js";
import { JsonlEventLog } from "../../../runtime/src/engine/event-log.js";
import { SessionEngine } from "../../../runtime/src/engine/session-engine.js";
import { createApi } from "../api.js";
import type { ControlConfig } from "../config.js";
import { REPO_ROOT } from "../config.js";
import type { EvalSpawnFn } from "../eval-child.js";
import { startControl, type RunningControl } from "../main.js";
import type { ModerationService } from "../moderation.js";
import type { ReportJobService } from "../report-job.js";
import { SessionList } from "../session-list.js";
import type { Supervisor } from "../supervisor.js";
import { sid } from "./fake-child.js";

const TOKEN = "t".repeat(40);
const ID = sid(7);
const servers: http.Server[] = [];

type Fakes = { jobs: Record<string, ReturnType<typeof vi.fn>>; moderation: Record<string, ReturnType<typeof vi.fn>> };
function fakes(): Fakes {
  const okv = (): ReturnType<typeof vi.fn> => vi.fn(async () => ({ status: 200, value: { fine: true } }));
  return {
    jobs: { start: okv(), cancel: okv() },
    moderation: { overview: okv(), open: okv(), subject: okv(), edit: okv(), accept: okv(), comment: okv(), editSummary: okv() },
  };
}
async function boot(o: { jobs?: boolean; moderation?: boolean; known?: boolean; f?: Fakes } = {}): Promise<{ port: number; f: Fakes }> {
  const f = o.f ?? fakes();
  const supervisor = { get: (id: string) => (o.known !== false && id === ID ? { sessionId: id } : undefined) } as unknown as Supervisor;
  const handler = createApi({
    config: { serviceToken: TOKEN } as ControlConfig, supervisor, scenarios: () => Promise.resolve([]),
    ...(o.jobs !== false ? { jobs: f.jobs as unknown as ReportJobService } : {}),
    ...(o.moderation !== false ? { moderation: f.moderation as unknown as ModerationService } : {}),
  });
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { port: (server.address() as AddressInfo).port, f };
}
type Reply = { status: number; headers: Headers; text: string; json: any };
async function call(port: number, method: string, p: string, o: { body?: unknown; raw?: string } = {}): Promise<Reply> {
  const headers: Record<string, string> = { "x-service-token": TOKEN };
  const body = o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers, body });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, headers: res.headers, text, json };
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); })));
});
const R = (s = ""): string => `/sessions/${ID}/report${s}`;
const EDIT = { criterion: "clarity", level: 2, reason: "Seen.", expect: "3", by: "priya" };
/** Every route with a valid body. */
const ROUTES: { name: string; method: string; path: string; body?: unknown; needs: "jobs" | "moderation" }[] = [
  { name: "overview", method: "GET", path: R(), needs: "moderation" },
  { name: "evaluate", method: "POST", path: R("/evaluate"), body: { confirmedCalls: 8, by: "priya" }, needs: "jobs" },
  { name: "cancel", method: "POST", path: R("/evaluate/cancel"), body: {}, needs: "jobs" },
  { name: "open", method: "POST", path: R("/open"), body: { by: "priya" }, needs: "moderation" },
  { name: "subject", method: "GET", path: R("/subjects/alice"), needs: "moderation" },
  { name: "edit", method: "POST", path: R("/subjects/alice/edit"), body: EDIT, needs: "moderation" },
  { name: "accept", method: "POST", path: R("/subjects/group/accept"), body: { summary: true, by: "priya" }, needs: "moderation" },
  { name: "comment", method: "POST", path: R("/subjects/alice/comment"), body: { text: "Ask about it.", by: "priya" }, needs: "moderation" },
  { name: "edit-summary", method: "POST", path: R("/subjects/alice/edit-summary"), body: { reason: "Tighter.", strengths: ["Calm."], by: "priya" }, needs: "moderation" },
];

describe("report routes", () => {
  it("every route answers 200 with its service present", async () => {
    const { port } = await boot();
    for (const r of ROUTES) {
      const x = await call(port, r.method, r.path, r.body === undefined ? {} : { body: r.body });
      expect([r.name, x.status]).toEqual([r.name, 200]);
      expect(x.json).toEqual({ success: true, data: { fine: true }, error: null });
    }
  });

  it("each route 404s when its service is absent", async () => {
    const noJobs = await boot({ jobs: false });
    const noMod = await boot({ moderation: false });
    for (const r of ROUTES) {
      const { port, f } = r.needs === "jobs" ? noJobs : noMod;
      const x = await call(port, r.method, r.path, r.body === undefined ? {} : { body: r.body });
      expect([r.name, x.status, x.json.error.code]).toEqual([r.name, 404, "not_found"]);
      for (const fn of [...Object.values(f.jobs), ...Object.values(f.moderation)]) expect(fn).not.toHaveBeenCalled();
    }
  });

  it("a bad session id, subject or criterion id is 404 before the body is read", async () => {
    const { port, f } = await boot();
    const junk = { raw: "{ not json" }; // would be a 400 if it were read
    for (const p of [
      `/sessions/..%2Fetc/report`, `/sessions/not%20valid/report/open`, // bad session id
      R("/subjects/..%2Fx/edit"), R("/subjects/Bad%20Id/comment"), R("/subjects/%E0%A4%A/accept"), R("/subjects/ALICE/edit-summary"),
    ]) {
      const x = await call(port, "POST", p, junk);
      expect([p, x.status]).toEqual([p, 404]);
    }
    // an unknown session (not in the registry) is 404 before the body too
    const gone = await boot({ known: false });
    expect((await call(gone.port, "POST", R("/subjects/alice/edit"), junk)).status).toBe(404);
    expect((await call(gone.port, "POST", R("/evaluate"), junk)).status).toBe(404);
    expect((await call(gone.port, "GET", R())).status).toBe(404);
    for (const fn of [...Object.values(f.jobs), ...Object.values(f.moderation), ...Object.values(gone.f.moderation)]) expect(fn).not.toHaveBeenCalled();
    // a criterion id that is not file-safe never reaches the service: 400
    const bad = await call(port, "POST", R("/subjects/alice/edit"), { body: { ...EDIT, criterion: "../x" } });
    expect(bad.status).toBe(400);
    expect((await call(port, "POST", R("/subjects/alice/comment"), { body: { text: "t", criterion: "a/b", by: "p" } })).status).toBe(400);
    expect(f.moderation.edit).not.toHaveBeenCalled();
    expect(f.moderation.comment).not.toHaveBeenCalled();
  });

  it("a body over the cap is 413 with the fixed sentence (4 KB, and 16 KB for edit, comment and edit-summary)", async () => {
    const { port, f } = await boot();
    const big = (n: number): string => "x".repeat(n);
    const cases: [string, string, unknown][] = [
      ["POST", R("/evaluate"), { confirmedCalls: 8, by: "p", pad: big(5000) }],
      ["POST", R("/open"), { by: "p", pad: big(5000) }],
      ["POST", R("/subjects/alice/edit"), { ...EDIT, reason: big(17 * 1024) }],
      ["POST", R("/subjects/alice/accept"), { summary: true, by: "p", pad: big(5000) }],
      ["POST", R("/subjects/alice/comment"), { text: big(17 * 1024), by: "p" }],
      ["POST", R("/subjects/alice/edit-summary"), { reason: big(17 * 1024), by: "p" }],
    ];
    for (const [m, p, body] of cases) {
      const x = await call(port, m, p, { body });
      expect([p, x.status, x.json?.error?.message]).toEqual([p, 413, "That request is too large."]);
    }
    // between 4 KB and 16 KB: the free-text routes accept it, the others do not
    expect((await call(port, "POST", R("/subjects/alice/comment"), { body: { text: big(10 * 1024), by: "p" } })).status).toBe(200);
    expect((await call(port, "POST", R("/subjects/alice/edit-summary"), { body: { reason: big(10 * 1024), by: "p" } })).status).toBe(200);
    // an edit's reason (500) and rationale (1,500 characters) in CJK are about 6 KB: the edit route takes the 16 KB cap too
    const cjk = (n: number): string => "\u8a55".repeat(n);
    expect((await call(port, "POST", R("/subjects/alice/edit"), { body: { ...EDIT, reason: cjk(500), rationale: cjk(1500) } })).status).toBe(200);
    expect((await call(port, "POST", R("/subjects/alice/accept"), { body: { summary: true, by: "p", pad: big(5000) } })).status).toBe(413);
    expect(f.moderation.edit).toHaveBeenCalledTimes(1);
    expect(f.jobs.start).not.toHaveBeenCalled();
  });

  it("an unknown body key is 400, as is a `by` over 64 units, a wrong type and a body that is not JSON", async () => {
    const { port, f } = await boot();
    const bads: [string, string, { body?: unknown; raw?: string }][] = [
      [R("/evaluate"), "POST", { body: { confirmedCalls: 8, by: "p", extra: 1 } }],
      [R("/evaluate"), "POST", { body: { confirmedCalls: "8", by: "p" } }],
      [R("/evaluate"), "POST", { body: { confirmedCalls: 8, by: "p".repeat(65) } }],
      [R("/evaluate"), "POST", { body: { by: "p" } }],
      [R("/evaluate/cancel"), "POST", { body: { x: 1 } }],
      [R("/open"), "POST", { body: { by: "p", x: 1 } }],
      [R("/open"), "POST", { raw: "{ no" }],
      [R("/subjects/alice/edit"), "POST", { body: { ...EDIT, level: 5 } }],
      [R("/subjects/alice/edit"), "POST", { body: { ...EDIT, expect: "5" } }],
      [R("/subjects/alice/edit"), "POST", { body: { ...EDIT, extra: true } }],
      [R("/subjects/alice/accept"), "POST", { body: { summary: false, by: "p" } }],
      [R("/subjects/alice/comment"), "POST", { body: { text: "t", by: "p", extra: 1 } }],
      [R("/subjects/alice/edit-summary"), "POST", { body: { reason: "r", by: "p", actions: [{ lo: "a" }] } }],
    ];
    for (const [p, m, o] of bads) {
      const x = await call(port, m, p, o);
      expect([p, JSON.stringify(o).slice(0, 60), x.status]).toEqual([p, JSON.stringify(o).slice(0, 60), 400]);
    }
    for (const fn of [...Object.values(f.jobs), ...Object.values(f.moderation)]) expect(fn).not.toHaveBeenCalled();
  });

  it("edit without expect is 400 and never reaches the service", async () => {
    const { port, f } = await boot();
    const { expect: _drop, ...noExpect } = EDIT;
    const x = await call(port, "POST", R("/subjects/alice/edit"), { body: noExpect });
    expect(x.status).toBe(400);
    expect(f.moderation.edit).not.toHaveBeenCalled();
    // with it, the typed name is passed through untouched and the body is mapped
    expect((await call(port, "POST", R("/subjects/alice/edit"), { body: { ...EDIT, level: null, rationale: "why" } })).status).toBe(200);
    expect(f.moderation.edit).toHaveBeenCalledWith(ID, "alice", { criterion: "clarity", level: null, reason: "Seen.", expect: "3", rationale: "why" }, "priya");
  });

  it("every 400 from a body that fails the schema or is not JSON carries the one code invalid and the same sentence", async () => {
    const { port } = await boot();
    for (const [p, o] of [[R("/evaluate"), { body: { confirmedCalls: "8", by: "p" } }], [R("/open"), { raw: "{ no" }], [R("/subjects/alice/edit"), { body: { ...EDIT, extra: 1 } }]] as const) {
      const x = await call(port, "POST", p, o);
      expect([x.status, x.json.error.code, x.json.error.message]).toEqual([400, "invalid", "That request is not valid."]);
    }
  });

  it("an invalid name for evaluate is 400 invalid and starts nothing", async () => {
    const { port, f } = await boot();
    const x = await call(port, "POST", R("/evaluate"), { body: { confirmedCalls: 8, by: "two words" } });
    expect([x.status, x.json.error.code]).toEqual([400, "invalid"]);
    expect(f.jobs.start).not.toHaveBeenCalled();
    expect((await call(port, "POST", R("/evaluate"), { body: { confirmedCalls: 8, by: "priya" } })).status).toBe(200);
    expect(f.jobs.start).toHaveBeenCalledWith(ID, { confirmedCalls: 8, by: "priya" });
  });

  it("409 carries only the closed code", async () => {
    const { port, f } = await boot();
    f.moderation.accept!.mockResolvedValueOnce({ status: 409, code: "blocked", detail: ["alice", "group"] });
    let x = await call(port, "POST", R("/subjects/alice/accept"), { body: { summary: true, by: "p" } });
    expect([x.status, x.json]).toEqual([409, { success: false, data: { blocked: ["alice", "group"] }, error: { code: "blocked" } }]);
    f.moderation.edit!.mockResolvedValueOnce({ status: 409, code: "stale", detail: ["/etc/secret is currently 3"] });
    x = await call(port, "POST", R("/subjects/alice/edit"), { body: EDIT });
    expect([x.status, x.json]).toEqual([409, { success: false, data: null, error: { code: "stale" } }]);
    expect(x.text).not.toMatch(/secret|message/);
    f.jobs.start!.mockResolvedValueOnce({ status: 409, code: "already_running" });
    x = await call(port, "POST", R("/evaluate"), { body: { confirmedCalls: 8, by: "p" } });
    expect([x.status, x.json]).toEqual([409, { success: false, data: null, error: { code: "already_running" } }]);
    f.moderation.open!.mockResolvedValueOnce({ status: 409, code: "no_review" });
    expect((await call(port, "POST", R("/open"), { body: { by: "p" } })).json.error).toEqual({ code: "no_review" });
    f.jobs.start!.mockResolvedValueOnce({ status: 409, code: "orphan" });
    x = await call(port, "POST", R("/evaluate"), { body: { confirmedCalls: 8, by: "p" } });
    expect([x.status, x.json]).toEqual([409, { success: false, data: null, error: { code: "orphan" } }]);
  });

  it("503 busy sets Retry-After from retryAfterMs; unavailable has a fixed sentence; 400 invalid and 404 map", async () => {
    const { port, f } = await boot();
    f.moderation.comment!.mockResolvedValueOnce({ status: 503, code: "busy", retryAfterMs: 1500 });
    let x = await call(port, "POST", R("/subjects/alice/comment"), { body: { text: "t", by: "p" } });
    expect([x.status, x.headers.get("retry-after"), x.json.error.code]).toEqual([503, "2", "busy"]);
    f.moderation.comment!.mockResolvedValueOnce({ status: 503, code: "busy", retryAfterMs: 10 });
    x = await call(port, "POST", R("/subjects/alice/comment"), { body: { text: "t", by: "p" } });
    expect(x.headers.get("retry-after")).toBe("1");
    f.moderation.overview!.mockResolvedValueOnce({ status: 503, code: "unavailable" });
    x = await call(port, "GET", R());
    expect([x.status, x.headers.get("retry-after"), x.json.error]).toEqual([503, null, { code: "unavailable", message: "The report is unavailable. Try again." }]);
    f.moderation.subject!.mockResolvedValueOnce({ status: 404 });
    expect((await call(port, "GET", R("/subjects/alice"))).status).toBe(404);
    f.moderation.open!.mockResolvedValueOnce({ status: 400, code: "invalid" });
    x = await call(port, "POST", R("/open"), { body: { by: "p" } });
    expect([x.status, x.json.error.code]).toEqual([400, "invalid"]);
    // a job call that throws is unavailable, never its text
    f.jobs.start!.mockRejectedValueOnce(new Error("/secret/path cannot be read"));
    x = await call(port, "POST", R("/evaluate"), { body: { confirmedCalls: 8, by: "p" } });
    expect([x.status, x.json.error.code]).toEqual([503, "unavailable"]);
    expect(x.text).not.toContain("secret");
  });

  it("GET evaluate is 404, and so are the other wrong methods and unknown paths", async () => {
    const { port } = await boot();
    for (const [m, p] of [
      ["GET", R("/evaluate")], ["GET", R("/evaluate/cancel")], ["PUT", R("/evaluate")], ["GET", R("/open")], ["POST", R()], ["DELETE", R()],
      ["POST", R("/subjects/alice")], ["GET", R("/subjects/alice/edit")], ["POST", R("/subjects/alice/release")], ["GET", R("/subjects")], ["GET", R("/nope")],
    ] as const) {
      expect([m, p, (await call(port, m, p)).status]).toEqual([m, p, 404]);
    }
  });

  it("the token is still checked first", async () => {
    const { port } = await boot();
    const res = await fetch(`http://127.0.0.1:${port}${R()}`);
    expect(res.status).toBe(401);
  });
});

describe("wiring in startControl", () => {
  let root: string;
  let running: RunningControl | undefined;
  let env: NodeJS.ProcessEnv;
  class FakeEvalChild {
    stdout = new PassThrough();
    stderr = new PassThrough();
    signals: NodeJS.Signals[] = [];
    private fns: ((code: number | null, signal: string | null) => void)[] = [];
    private done = false;
    kill(sig: NodeJS.Signals): void { this.signals.push(sig); this.exit(130); }
    onExit(cb: (code: number | null, signal: string | null) => void): void { this.fns.push(cb); }
    exit(code: number): void { if (this.done) return; this.done = true; this.stdout.end(); this.stderr.end(); for (const f of this.fns) f(code, null); }
  }
  let spawned: { child: FakeEvalChild; env: NodeJS.ProcessEnv }[];
  const evalSpawn: EvalSpawnFn = (o) => { const child = new FakeEvalChild(); spawned.push({ child, env: o.env }); return child; };

  beforeEach(async () => {
    spawned = [];
    root = mkdtempSync(path.join(tmpdir(), "ctl-routes-"));
    const data = path.join(root, "data");
    mkdirSync(path.join(data, "sessions"), { recursive: true });
    env = { CONTROL_DATA_DIR: data, LAUNCHER_TOKEN: TOKEN, CONTROL_GRACE_MS: "200", ANTHROPIC_API_KEY: "key-from-dotenv", EVAL_TIMEOUT_MS: "5000" };
    // an ended session: its log, and its entry in the session list
    const scenario = await loadScenario(path.join(REPO_ROOT, "scenarios", "friday-escalation"));
    const log = new JsonlEventLog(ID, path.join(data, "sessions"), { sync: false });
    const engine = new SessionEngine({ scenario, log, clock: new FakeClock(1_000_000) });
    await engine.start(Object.fromEntries(Object.values(scenario.roles).filter((r) => r.type === "player").map((r) => [r.id, `p_${r.id}`])), {});
    await engine.endNow({ actor: "facilitator" });
    await log.close?.();
    new SessionList(path.join(data, "sessions.json")).upsert({ sessionId: ID, scenarioId: "friday-escalation", status: "ended" });
  });
  afterEach(async () => {
    await running?.close();
    running = undefined;
    rmSync(root, { recursive: true, force: true });
  });
  const post = (port: number, p: string, body: unknown): Promise<Response> =>
    fetch(`http://127.0.0.1:${port}${p}`, { method: "POST", headers: { "x-service-token": TOKEN, "content-type": "application/json" }, body: JSON.stringify(body) });

  it("the report routes are wired, and the evaluate child gets the merged environment", async () => {
    running = await startControl(env, { port: 0, evalSpawn });
    const o = await fetch(`http://127.0.0.1:${running.port}${R()}`, { headers: { "x-service-token": TOKEN } });
    expect(o.status).toBe(200);
    expect((await o.json()).data).toMatchObject({ stage: "not_evaluated", confirm: { upTo: 8 } });
    const s = await post(running.port, R("/evaluate"), { confirmedCalls: 8, by: "priya" });
    expect(s.status).toBe(200);
    expect((await s.json()).data).toMatchObject({ state: "running" });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.env).toMatchObject({ ANTHROPIC_API_KEY: "key-from-dotenv", NO_DOTENV: "1" });
  });

  it("close() stops a running job", async () => {
    running = await startControl(env, { port: 0, evalSpawn });
    expect((await post(running.port, R("/evaluate"), { confirmedCalls: 8, by: "priya" })).status).toBe(200);
    expect(spawned[0]!.child.signals).toEqual([]);
    await running.close();
    running = undefined;
    expect(spawned[0]!.child.signals).toEqual(["SIGTERM"]);
  });
});

describe("report routes, part B (release, resolve, export, amend, withdraw)", () => {
  const BY = { by: "priya" };
  const withB = (): Fakes => {
    const f = fakes();
    for (const m of ["release", "resolve", "export", "amend", "withdraw"]) f.moderation[m] = vi.fn(async () => ({ status: 200, value: { fine: true } }));
    return f;
  };
  const PART_B: { name: string; path: string; body: unknown; fn: string }[] = [
    { name: "release", path: R("/release"), body: { subjects: ["alice", "group"], ...BY }, fn: "release" },
    { name: "resolve", path: R("/resolve"), body: { seq: 4, outcome: "declined", reason: "Stands.", ...BY }, fn: "resolve" },
    { name: "export", path: R("/export"), body: { subject: "alice", audience: "participant:alice", ...BY }, fn: "export" },
    { name: "amend", path: R("/subjects/alice/amend"), body: { reason: "Fix.", ...BY }, fn: "amend" },
    { name: "withdraw", path: R("/subjects/alice/withdraw"), body: { reason: "Gone.", ...BY }, fn: "withdraw" },
  ];

  it("every part B route answers 200 and passes the typed fields to the service", async () => {
    const { port, f } = await boot({ f: withB() });
    for (const r of PART_B) {
      const x = await call(port, "POST", r.path, { body: r.body });
      expect([r.name, x.status, x.json.success]).toEqual([r.name, 200, true]);
      expect(f.moderation[r.fn]).toHaveBeenCalledTimes(1);
    }
    expect(f.moderation.release).toHaveBeenCalledWith(ID, { subjects: ["alice", "group"] }, "priya");
    expect(f.moderation.resolve).toHaveBeenCalledWith(ID, { seq: 4, outcome: "declined", reason: "Stands." }, "priya");
    expect(f.moderation.export).toHaveBeenCalledWith(ID, { subject: "alice", audience: "participant:alice" }, "priya");
    expect(f.moderation.amend).toHaveBeenCalledWith(ID, "alice", { reason: "Fix." }, "priya");
    expect(f.moderation.withdraw).toHaveBeenCalledWith(ID, "alice", { reason: "Gone." }, "priya");
  });

  it("release with {subjects: []} and with {all: true} are 400 before the service is called", async () => {
    const { port, f } = await boot({ f: withB() });
    for (const body of [{ subjects: [], ...BY }, { all: true, ...BY }, { subjects: ["alice"], all: true, ...BY }, { subjects: ["../x"], ...BY },
      { subjects: Array.from({ length: 51 }, (_, i) => `s${i}`), ...BY }, { subjects: "alice", ...BY }, { subjects: ["alice"] }]) {
      const x = await call(port, "POST", R("/release"), { body });
      expect([JSON.stringify(body).slice(0, 40), x.status, x.json.error.code]).toEqual([JSON.stringify(body).slice(0, 40), 400, "invalid"]);
    }
    expect(f.moderation.release).not.toHaveBeenCalled();
  });

  it("the other part B bodies are strict: an unknown key, a bad enum, seq or audience, a missing reason are 400", async () => {
    const { port, f } = await boot({ f: withB() });
    const bad: [string, unknown][] = [
      [R("/resolve"), { seq: 0, outcome: "upheld", reason: "r", ...BY }], [R("/resolve"), { seq: 1.5, outcome: "upheld", reason: "r", ...BY }],
      [R("/resolve"), { seq: 1, outcome: "maybe", reason: "r", ...BY }], [R("/resolve"), { seq: 1, outcome: "upheld", ...BY }],
      [R("/export"), { subject: "alice", audience: "hr", ...BY }], [R("/export"), { subject: "../x", audience: "facilitator", ...BY }],
      [R("/export"), { subject: "alice", audience: "facilitator", download: true, ...BY }],
      [R("/subjects/alice/amend"), { ...BY }], [R("/subjects/alice/withdraw"), { reason: "r", extra: 1, ...BY }],
    ];
    for (const [p, body] of bad) expect([p, (await call(port, "POST", p, { body })).status]).toEqual([p, 400]);
    for (const fn of ["resolve", "export", "amend", "withdraw"]) expect(f.moderation[fn]).not.toHaveBeenCalled();
  });

  it("ids are checked and the session looked up before the body is read; wrong methods and unknown paths are 404", async () => {
    const { port, f } = await boot({ f: withB() });
    const junk = { raw: "{ not json" };
    for (const p of [R("/subjects/..%2Fx/amend"), R("/subjects/Bad%20Id/withdraw"), `/sessions/..%2Fetc/report/release`, `/sessions/not%20valid/report/export`])
      expect([p, (await call(port, "POST", p, junk)).status]).toEqual([p, 404]);
    const gone = await boot({ known: false, f: withB() });
    for (const p of [R("/release"), R("/resolve"), R("/export"), R("/subjects/alice/amend")])
      expect([p, (await call(gone.port, "POST", p, junk)).status]).toEqual([p, 404]);
    for (const p of [R("/release"), R("/resolve"), R("/export"), R("/subjects/alice/amend"), R("/subjects/alice/withdraw")])
      expect([p, (await call(port, "GET", p)).status]).toEqual([p, 404]);
    expect((await call(port, "POST", R("/release/all"), { body: {} })).status).toBe(404);
    for (const fn of Object.values(f.moderation)) expect(fn).not.toHaveBeenCalled();
  });

  it("export audience: participant: with an empty, slashed or 65-character id is 400; a 64-character id is accepted", async () => {
    const { port, f } = await boot({ f: withB() });
    for (const audience of ["participant:", "participant:a/b", `participant:${"a".repeat(65)}`]) {
      const x = await call(port, "POST", R("/export"), { body: { subject: "alice", audience, ...BY } });
      expect([audience.slice(0, 20), x.status, x.json.error.code]).toEqual([audience.slice(0, 20), 400, "invalid"]);
    }
    expect(f.moderation.export).not.toHaveBeenCalled();
    const long = `participant:${"a".repeat(64)}`;
    const x = await call(port, "POST", R("/export"), { body: { subject: "alice", audience: long, ...BY } });
    expect(x.status).toBe(200);
    expect(f.moderation.export).toHaveBeenCalledWith(ID, { subject: "alice", audience: long }, "priya");
  });

  it("an unknown subject is 404 with the code unknown_subject; an unknown session stays a plain not_found", async () => {
    const { port, f } = await boot({ f: withB() });
    f.moderation.amend!.mockResolvedValueOnce({ status: 404, code: "unknown_subject" });
    let x = await call(port, "POST", R("/subjects/alice/amend"), { body: { reason: "Fix.", ...BY } });
    expect([x.status, x.json.error]).toEqual([404, { code: "unknown_subject" }]);
    f.moderation.amend!.mockResolvedValueOnce({ status: 404 });
    x = await call(port, "POST", R("/subjects/alice/amend"), { body: { reason: "Fix.", ...BY } });
    expect([x.status, x.json.error.code]).toEqual([404, "not_found"]);
  });

  it("without a moderation service every part B route is 404", async () => {
    const { port } = await boot({ moderation: false });
    for (const r of PART_B) expect([r.name, (await call(port, "POST", r.path, { body: r.body })).status]).toEqual([r.name, 404]);
  });

  it("body caps: 4 KB for release and export, 16 KB for amend, withdraw and resolve; over is 413", async () => {
    const { port, f } = await boot({ f: withB() });
    const big = (n: number): string => "x".repeat(n);
    for (const [p, body] of [
      [R("/release"), { subjects: ["alice"], ...BY, pad: big(5000) }], [R("/export"), { subject: "alice", audience: "facilitator", ...BY, pad: big(5000) }],
      [R("/resolve"), { seq: 1, outcome: "upheld", reason: big(17 * 1024), ...BY }],
      [R("/subjects/alice/amend"), { reason: big(17 * 1024), ...BY }], [R("/subjects/alice/withdraw"), { reason: big(17 * 1024), ...BY }],
    ] as [string, unknown][]) {
      const x = await call(port, "POST", p, { body });
      expect([p, x.status, x.json?.error?.message]).toEqual([p, 413, "That request is too large."]);
    }
    for (const [p, body] of [
      [R("/resolve"), { seq: 1, outcome: "upheld", reason: big(10 * 1024), ...BY }],
      [R("/subjects/alice/amend"), { reason: big(10 * 1024), ...BY }], [R("/subjects/alice/withdraw"), { reason: big(10 * 1024), ...BY }],
    ] as [string, unknown][]) expect([p, (await call(port, "POST", p, { body })).status]).toEqual([p, 200]);
    expect(f.moderation.release).not.toHaveBeenCalled();
    expect(f.moderation.export).not.toHaveBeenCalled();
  });

  it("release with an open item is 409 blocked with data.blocked ids (safe ids only) and no text", async () => {
    const { port, f } = await boot({ f: withB() });
    f.moderation.release!.mockResolvedValueOnce({ status: 409, code: "blocked", detail: ["alice", "/etc/passwd", "group", "has space"] });
    const x = await call(port, "POST", R("/release"), { body: { subjects: ["alice", "group"], ...BY } });
    expect([x.status, x.json]).toEqual([409, { success: false, data: { blocked: ["alice", "group"] }, error: { code: "blocked" } }]);
    f.moderation.amend!.mockResolvedValueOnce({ status: 409, code: "superseded" });
    expect((await call(port, "POST", R("/subjects/alice/amend"), { body: { reason: "r", ...BY } })).json.error).toEqual({ code: "superseded" });
    f.moderation.resolve!.mockResolvedValueOnce({ status: 409, code: "needs_amend", detail: ["alice"] });
    const y = await call(port, "POST", R("/resolve"), { body: { seq: 1, outcome: "amended", reason: "r", ...BY } });
    expect([y.status, y.json]).toEqual([409, { success: false, data: null, error: { code: "needs_amend" } }]);
  });

  it("export is POST only (GET is 404) and answers JSON {fileName, markdown} with no attachment headers", async () => {
    const { port, f } = await boot({ f: withB() });
    f.moderation.export!.mockResolvedValueOnce({ status: 200, value: { fileName: "report-alice.md", markdown: "# Report\n" } });
    expect((await call(port, "GET", R("/export"))).status).toBe(404);
    const x = await call(port, "POST", R("/export"), { body: { subject: "alice", audience: "facilitator", ...BY } });
    expect(x.status).toBe(200);
    expect(x.json).toEqual({ success: true, data: { fileName: "report-alice.md", markdown: "# Report\n" }, error: null });
    expect(x.headers.get("content-type")).toMatch(/application\/json/);
    expect(x.headers.get("content-disposition")).toBeNull();
  });
});

