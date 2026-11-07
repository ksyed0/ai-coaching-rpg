import http from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";

import { writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectSecrets } from "@acr/runtime/reports";
import { createApi } from "../api.js";
import type { ControlConfig } from "../config.js";
import { createReportService, NOT_READY, NO_REPORT, REPORTS_UNREADABLE, type ReportService } from "../reports.js";
import type { Supervisor } from "../supervisor.js";
import { makeReportWorld, type ReportWorld } from "./report-fixture.js";

const TOKEN = "t".repeat(40);
let w: ReportWorld;
let svc: ReportService;
let logs: string[];
const servers: http.Server[] = [];

function sup(sessionId: string): Supervisor {
  return { get: (id: string) => (id === sessionId ? { sessionId, scenarioId: "s", status: "running", port: 1, modelLabel: "m" } : undefined) } as unknown as Supervisor;
}
async function boot(reports: ReportService | undefined, sessionId = w.sessionId): Promise<number> {
  const handler = createApi({
    config: { serviceToken: TOKEN } as ControlConfig, supervisor: sup(sessionId), scenarios: () => Promise.resolve([]),
    log: (m) => logs.push(m), ...(reports ? { reports } : {}),
  });
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return (server.address() as AddressInfo).port;
}
type Reply = { status: number; headers: [string, string][]; text: string; json: any };
async function call(port: number, method: string, path: string, o: { token?: string | null; body?: unknown; raw?: string } = {}): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (o.token !== null) headers["x-service-token"] = o.token ?? TOKEN;
  const body = o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  const hs = [...res.headers.entries()].filter(([k]) => k !== "date").sort();
  return { status: res.status, headers: hs, text, json };
}
beforeEach(async () => {
  logs = [];
  w = await makeReportWorld();
  svc = createReportService({ config: w.config, store: w.store, secrets: collectSecrets({}), now: () => w.clock.t, aiRoles: async () => [] });
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); })));
  await w.cleanup();
});
const links = (s = "") => `/sessions/${w.sessionId}/report-links${s}`;
const NEUTRAL = { success: false, data: null, error: { code: "not_found", message: "Not found." } };

describe("without a report service", () => {
  it("every report route answers 404 not_found", async () => {
    const p = await boot(undefined);
    for (const [m, path, body] of [
      ["GET", links()], ["POST", links(), { role: "alice" }], ["POST", links("/alice/reissue"), {}], ["DELETE", links("/alice")],
      ["POST", "/report-access/exchange", { token: "x" }], ["GET", `/sessions/${w.sessionId}/reports/${"A".repeat(11)}`],
    ] as [string, string, unknown?][]) {
      const r = await call(p, m, path, body === undefined ? {} : { body });
      expect(r.status, `${m} ${path}`).toBe(404);
      expect(r.json.error.code).toBe("not_found");
    }
  });
});

describe("authentication", () => {
  it("every report route needs the service token", async () => {
    const p = await boot(svc);
    for (const [m, path] of [["GET", links()], ["POST", links()], ["POST", links("/alice/reissue")], ["DELETE", links("/alice")], ["POST", "/report-access/exchange"], ["GET", `/sessions/${w.sessionId}/reports/${"A".repeat(11)}`]]) {
      expect((await call(p, m!, path!, { token: null })).status).toBe(401);
      expect((await call(p, m!, path!, { token: "wrong" })).status).toBe(401);
    }
  });
});

describe("console routes", () => {
  it("list, issue, conflict, reissue and revoke", async () => {
    const p = await boot(svc);
    let r = await call(p, "GET", links());
    expect(r.status).toBe(200);
    expect(r.json.data).toEqual({ state: "ready", players: { rated: 0, total: 0 }, roles: [{ role: "alice", credential: null, selfRated: null, draft: false }, { role: "bob", credential: null, selfRated: null, draft: false }] });
    r = await call(p, "POST", links(), { body: { role: "alice" } });
    expect(r.status).toBe(200);
    const first = r.json.data.token as string;
    expect(first).toMatch(/^[A-Za-z0-9_-]{11}\.[A-Za-z0-9_-]{22}$/);
    expect(r.json.data.credential.role).toBe("alice");
    expect((await call(p, "POST", links(), { body: { role: "alice" } })).status).toBe(409);
    r = await call(p, "GET", links());
    expect(r.text).not.toContain(first.split(".")[1]);
    r = await call(p, "POST", links("/alice/reissue"), { body: {} });
    expect(r.status).toBe(200);
    expect(r.json.data.token).not.toBe(first);
    r = await call(p, "DELETE", links("/alice"));
    expect(r).toMatchObject({ status: 200 });
    expect(r.json.data).toEqual({ revoked: true });
    expect((await call(p, "DELETE", links("/alice"))).json.data).toEqual({ revoked: false });
  });
  it("refuses an unreleased role and a session with nothing ready, with the fixed sentences", async () => {
    const p = await boot(svc);
    let r = await call(p, "POST", links(), { body: { role: "mallory" } });
    expect([r.status, r.json.error.code, r.json.error.message]).toEqual([409, "conflict", NO_REPORT]);
    expect(r.text).not.toContain("mallory");
    const p2 = await boot(createReportService({ config: { ...w.config, reportsDir: `${w.root}/nowhere` } as ControlConfig, store: w.store, secrets: [], now: () => w.clock.t, aiRoles: async () => [] }));
    r = await call(p2, "POST", links(), { body: { role: "alice" } });
    expect([r.status, r.json.error.message]).toEqual([409, NOT_READY]);
    expect(r.text).not.toContain(w.root);
    expect((await call(p2, "GET", links())).json.data).toEqual({ state: "not_ready", players: null, roles: [] });
  });
  it("says the reports cannot be read (503, not the evaluate hint) when the reader is unavailable", async () => {
    await w.corrupt();
    const p = await boot(svc);
    let r = await call(p, "POST", links(), { body: { role: "alice" } });
    expect([r.status, r.json.error.code, r.json.error.message]).toEqual([503, "unavailable", REPORTS_UNREADABLE]);
    r = await call(p, "POST", links("/alice/reissue"), { body: {} });
    expect([r.status, r.json.error.message]).toEqual([503, REPORTS_UNREADABLE]);
    r = await call(p, "GET", links());
    expect([r.status, r.json.data.state]).toEqual([200, "unavailable"]);
    expect(r.text).not.toContain(w.root);
  });
  it("revoke works for a session that is no longer listed, because the credential exists", async () => {
    const { credential } = await svc.issue(w.sessionId, "alice");
    const p = await boot(svc, "someone-else");
    const r = await call(p, "DELETE", links("/alice"));
    expect([r.status, r.json.data]).toEqual([200, { revoked: true }]);
    expect((await w.store.list(w.sessionId))[0]!.revokedAt).toBeDefined();
    expect(credential.role).toBe("alice");
  });
  it("needs the session to exist (except revoke)", async () => {
    const p = await boot(svc, "someone-else");
    for (const [m, path, body] of [["GET", links()], ["POST", links(), { role: "alice" }], ["POST", links("/alice/reissue"), {}]] as [string, string, unknown?][]) {
      const r = await call(p, m, path, body === undefined ? {} : { body });
      expect([r.status, r.json.error.message], `${m} ${path}`).toEqual([404, "That session does not exist."]);
    }
  });
  it("validates the role before anything runs", async () => {
    const p = await boot(svc);
    for (const bad of ["..", "a%2Fb", "x".repeat(300), "%E0%A4%A"]) {
      expect((await call(p, "DELETE", links(`/${bad}`))).status).toBe(404);
      expect((await call(p, "POST", links(`/${bad}/reissue`), { body: {} })).status).toBe(404);
    }
    for (const body of [{ role: "../x" }, { role: 5 }, {}, { role: "alice", extra: 1 }]) expect((await call(p, "POST", links(), { body })).status).toBe(400);
    expect((await call(p, "POST", links(), { raw: "{" })).status).toBe(400);
    expect(await w.store.list(w.sessionId)).toEqual([]);
  });
});

describe("exchange", () => {
  it("returns the credential for a live token", async () => {
    const p = await boot(svc);
    const { token, credential } = await svc.issue(w.sessionId, "alice");
    const r = await call(p, "POST", "/report-access/exchange", { body: { token } });
    expect(r.status).toBe(200);
    expect(r.json.data).toEqual({ credentialId: credential.id, sessionId: w.sessionId, role: "alice", expiresAt: credential.expiresAt });
  });
  it("answers unknown, wrong-secret, revoked, expired and malformed tokens with identical bytes", async () => {
    const p = await boot(svc);
    const a = await svc.issue(w.sessionId, "alice");
    const b = await svc.issue(w.sessionId, "bob");
    await svc.revoke(w.sessionId, "bob");
    const id = a.token.split(".")[0]!;
    const cases = [`${"B".repeat(11)}.${"C".repeat(22)}`, `${id}.${"A".repeat(22)}`, b.token, "", "x", "a".repeat(64), "a".repeat(65), "../../etc/passwd", `${id}.${"A".repeat(22)}.`];
    const replies = [];
    for (const token of cases) replies.push(await call(p, "POST", "/report-access/exchange", { body: { token } }));
    w.clock.t = a.credential.expiresAt;
    replies.push(await call(p, "POST", "/report-access/exchange", { body: { token: a.token } }));
    replies.push(await call(p, "POST", "/report-access/exchange", { body: { token: 5 } }));
    replies.push(await call(p, "POST", "/report-access/exchange", { body: {} }));
    for (const r of replies) {
      expect(r.status).toBe(404);
      expect(r.json).toEqual(NEUTRAL);
      expect(r.text).toBe(replies[0]!.text);
      expect(r.headers).toEqual(replies[0]!.headers);
    }
  });
  it("caps the body size", async () => {
    const p = await boot(svc);
    const r = await call(p, "POST", "/report-access/exchange", { raw: JSON.stringify({ token: "a".repeat(5000) }) });
    expect(r.status).toBe(413);
  });
});

describe("read", () => {
  it("returns the released report and refuses revoked, wrong-session and malformed ids with the same bytes as a bad exchange", async () => {
    const p = await boot(svc);
    const { credential } = await svc.issue(w.sessionId, "alice");
    const path = `/sessions/${w.sessionId}/reports/${credential.id}`;
    let r = await call(p, "GET", path);
    expect(r.status).toBe(200);
    expect(r.json.data.state).toBe("released");
    expect(r.json.data.view.kind).toBe("released");
    const bad = await call(p, "POST", "/report-access/exchange", { body: { token: "nope" } });
    const refusals = [
      await call(p, "GET", `/sessions/other-session/reports/${credential.id}`),
      await call(p, "GET", `/sessions/${w.sessionId}/reports/${"A".repeat(11)}`),
      await call(p, "GET", `/sessions/${w.sessionId}/reports/..%2F..`),
      await call(p, "GET", `/sessions/${w.sessionId}/reports/${credential.id}x`),
    ];
    await svc.revoke(w.sessionId, "alice");
    refusals.push(await call(p, "GET", path));
    for (const x of refusals) {
      expect(x.status).toBe(404);
      expect(x.text).toBe(bad.text);
      expect(x.headers).toEqual(bad.headers);
    }
  });
  it("reads a live credential's withdrawn report as not_released, and an unreadable one as 503 unavailable", async () => {
    const p = await boot(svc);
    const { credential } = await svc.issue(w.sessionId, "alice");
    const path = `/sessions/${w.sessionId}/reports/${credential.id}`;
    await w.run(["withdraw", w.rel, "alice", "--reason", "wrong", "--by", "kamal"]);
    let r = await call(p, "GET", path);
    expect([r.status, r.json.data]).toEqual([200, { state: "not_released" }]);
    await w.corrupt();
    r = await call(p, "GET", path);
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe("unavailable");
    expect(r.text).not.toContain(w.root);
  });
});

describe("an unreadable store", () => {
  it("answers 503 on exchange and read (never the neutral 404), leaves the file alone, and keeps refusals neutral otherwise", async () => {
    const p = await boot(svc);
    const { token, credential } = await svc.issue(w.sessionId, "alice");
    const neutralBad = await call(p, "POST", "/report-access/exchange", { body: { token: "nope" } });
    await writeFile(w.file, "not json at all");
    const before = readFileSync(w.file);
    const ex = await call(p, "POST", "/report-access/exchange", { body: { token } });
    expect([ex.status, ex.json.error.code, ex.json.error.message]).toEqual([503, "unavailable", "The report is unavailable. Try again."]);
    const rd = await call(p, "GET", `/sessions/${w.sessionId}/reports/${credential.id}`);
    expect([rd.status, rd.json.error.code]).toEqual([503, "unavailable"]);
    // malformed input is refused before the store is touched, so it stays the neutral 404
    expect((await call(p, "POST", "/report-access/exchange", { body: { token: "nope" } })).text).toBe(neutralBad.text);
    expect(readFileSync(w.file).equals(before)).toBe(true);
  });
});

describe("log hygiene", () => {
  it("no log line holds a token, hash, id, role, path or error message, and the store file holds no token", async () => {
    const boom: ReportService = { ...svc, exchange: () => Promise.reject(new Error(`secret-detail ${w.root}`)), read: () => Promise.reject(new Error("secret-detail")) };
    const p = await boot(boom);
    const r = await call(p, "POST", "/report-access/exchange", { body: { token: "abc.def" } });
    expect(r.status).toBe(500);
    expect(r.text).not.toContain("secret-detail");
    await call(p, "GET", `/sessions/${w.sessionId}/reports/${"A".repeat(11)}`);
    const p2 = await boot(svc);
    const { token, credential } = await svc.issue(w.sessionId, "alice");
    await call(p2, "POST", "/report-access/exchange", { body: { token } });
    await call(p2, "GET", `/sessions/${w.sessionId}/reports/${credential.id}`);
    const all = logs.join("\n");
    for (const s of ["secret-detail", w.root, token, credential.id, token.split(".")[1]!, "alice"]) expect(all).not.toContain(s);
    expect(readFileSync(w.file, "utf8")).not.toContain(token);
  });
});
