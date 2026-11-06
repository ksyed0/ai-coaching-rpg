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

  it("a body over the cap is 413 with the fixed sentence (4 KB, and 16 KB for comment and edit-summary)", async () => {
    const { port, f } = await boot();
    const big = (n: number): string => "x".repeat(n);
    const cases: [string, string, unknown][] = [
      ["POST", R("/evaluate"), { confirmedCalls: 8, by: "p", pad: big(5000) }],
      ["POST", R("/open"), { by: "p", pad: big(5000) }],
      ["POST", R("/subjects/alice/edit"), { ...EDIT, reason: big(5000) }],
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
    expect((await call(port, "POST", R("/subjects/alice/edit"), { body: { ...EDIT, reason: big(10 * 1024) } })).status).toBe(413);
    expect(f.moderation.edit).not.toHaveBeenCalled();
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
