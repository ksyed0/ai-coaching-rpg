import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadReview } from "../../../runtime/src/review/store.js";
import { createApi, MAX_BODY_BYTES } from "../api.js";
import type { ControlConfig } from "../config.js";
import { createParticipantWriteService, type ParticipantWriteService, type WriteOutcome } from "../participant-writes.js";
import { makeReportWorld, type ReportWorld } from "./report-fixture.js";

const TOKEN = "t".repeat(40);
const CAP_SELF = 64 * 1024;
const CAP_RESPONSE = 16 * 1024;
const FIXED_413 = { success: false, data: null, error: { code: "payload_too_large", message: "That request is too large." } };
let w: ReportWorld;
const servers: http.Server[] = [];

async function boot(participantWrites: ParticipantWriteService | undefined, extra: { reports?: unknown } = {}): Promise<number> {
  const handler = createApi({
    config: { serviceToken: TOKEN } as ControlConfig,
    supervisor: { get: () => ({ sessionId: w.sessionId }) } as never,
    scenarios: () => Promise.resolve([]),
    ...(participantWrites ? { participantWrites } : {}),
    ...(extra.reports ? { reports: extra.reports as never } : {}),
  });
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return (server.address() as AddressInfo).port;
}
type Reply = { status: number; headers: [string, string][]; text: string; json: any };
async function call(port: number, method: string, path: string, o: { body?: unknown; raw?: string; type?: string | null } = {}): Promise<Reply> {
  const headers: Record<string, string> = { "x-service-token": TOKEN };
  const body = o.raw ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
  if (body !== undefined && o.type !== null) headers["content-type"] = o.type ?? "application/json";
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, headers: [...res.headers.entries()].filter(([k]) => k !== "date").sort(), text, json };
}
const stub = (outcome: WriteOutcome) => {
  const rate = vi.fn(async () => outcome);
  const respond = vi.fn(async () => outcome);
  return { svc: { rate, respond } as ParticipantWriteService, rate, respond };
};
const CRED = "A".repeat(11);
const ratingsPath = (id = CRED) => `/sessions/${w.sessionId}/reports/${id}/self-ratings`;
const responsesPath = (id = CRED) => `/sessions/${w.sessionId}/reports/${id}/responses`;

beforeEach(async () => { w = await makeReportWorld({ release: false }); });
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); })));
  await w.cleanup();
});

describe("participant write routes", () => {
  it("answer 404 not_found when no write service is wired", async () => {
    const p = await boot(undefined);
    expect((await call(p, "PUT", ratingsPath(), { body: { ratings: [] } })).status).toBe(404);
    expect((await call(p, "POST", responsesPath(), { body: { text: "x" } })).status).toBe(404);
  });

  it("success is { wrote } and the service gets the ids and the parsed body", async () => {
    const { svc, rate, respond } = stub({ status: 200, wrote: 2 });
    const p = await boot(svc);
    let r = await call(p, "PUT", ratingsPath(), { body: { ratings: [{ criterion: "a", level: 3, note: "n" }, { criterion: "b", level: null }] } });
    expect([r.status, r.json]).toEqual([200, { success: true, data: { wrote: 2 }, error: null }]);
    expect(rate).toHaveBeenCalledWith(w.sessionId, CRED, [{ criterion: "a", level: 3, note: "n" }, { criterion: "b", level: null }]);
    r = await call(p, "POST", responsesPath(), { body: { criterion: "a", text: "hello", dispute: true } });
    expect(r.json.data).toEqual({ wrote: 2 });
    expect(respond).toHaveBeenCalledWith(w.sessionId, CRED, { criterion: "a", text: "hello", dispute: true });
  });

  it("a body with a role field is 400", async () => {
    const { svc, rate, respond } = stub({ status: 200, wrote: 1 });
    const p = await boot(svc);
    const bad: [string, string, unknown][] = [
      ["PUT", ratingsPath(), { role: "bob", ratings: [] }],
      ["PUT", ratingsPath(), { ratings: [{ criterion: "a", level: 1, role: "bob" }] }],
      ["PUT", ratingsPath(), { ratings: [{ criterion: "a", level: 1, extra: 1 }] }],
      ["POST", responsesPath(), { role: "bob", text: "x" }],
      ["POST", responsesPath(), { text: "x", unknown: 1 }],
      ["PUT", ratingsPath(), { ratings: [{ criterion: "A B", level: 1 }] }],
      ["PUT", ratingsPath(), { ratings: [{ criterion: "a".repeat(65), level: 1 }] }],
      ["PUT", ratingsPath(), { ratings: [{ criterion: "a", level: 5 }] }],
      ["PUT", ratingsPath(), { ratings: Array.from({ length: 51 }, (_, i) => ({ criterion: `c${i}`, level: 1 })) }],
      ["PUT", ratingsPath(), { ratings: [{ criterion: "a", level: 1, note: "x".repeat(3001) }] }],
      ["POST", responsesPath(), { text: "x".repeat(3001) }],
      ["POST", responsesPath(), { text: "x", dispute: "yes" }],
      ["POST", responsesPath(), {}],
    ];
    for (const [m, path, body] of bad) {
      const r = await call(p, m, path, { body });
      expect([r.status, r.json.error.code], JSON.stringify(body).slice(0, 80)).toEqual([400, "bad_request"]);
    }
    expect(rate).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });

  it("non-JSON content type is 400", async () => {
    const { svc, rate } = stub({ status: 200, wrote: 1 });
    const p = await boot(svc);
    const body = JSON.stringify({ ratings: [] });
    for (const type of ["text/plain", "application/x-www-form-urlencoded"]) {
      expect((await call(p, "PUT", ratingsPath(), { raw: body, type })).status).toBe(400);
    }
    expect((await call(p, "PUT", ratingsPath(), { raw: "{not json" })).status).toBe(400);
    expect((await call(p, "PUT", ratingsPath())).status).toBe(400); // no body: ratings required
    expect(rate).not.toHaveBeenCalled();
  });

  it("credential id checked with isCredentialId before any lookup", async () => {
    const { svc, rate, respond } = stub({ status: 200, wrote: 1 });
    const p = await boot(svc);
    const cases = ["short", "A".repeat(12), "%ZZ", "..%2F..", "A".repeat(10) + "!"];
    const replies: Reply[] = [];
    for (const id of cases) {
      replies.push(await call(p, "PUT", ratingsPath(id), { body: { ratings: [] } }));
      replies.push(await call(p, "POST", responsesPath(id), { body: { text: "x" } }));
    }
    for (const r of replies) expect([r.status, r.json.error.code]).toEqual([404, "not_found"]);
    expect(rate).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
    // The same neutral response the 2c-1 GET gives for a malformed id.
    const get = await call(p, "GET", `/sessions/${w.sessionId}/reports/short`);
    expect(get.status).toBe(404);
  });

  it("neutral 404 identical for every refusal", async () => {
    const real = createParticipantWriteService({ config: w.config, store: w.store, secrets: [], now: () => w.clock.t, sleep: async () => {}, random: () => 0.5 });
    const p = await boot(real);
    const good = (await w.store.issue(w.sessionId, "alice")).credential;
    const revoked = (await w.store.issue(w.sessionId, "bob")).credential;
    await w.store.revoke(w.sessionId, "bob");
    const body = { ratings: [{ criterion: "a", level: 1 }] };
    const refusals: Reply[] = [];
    for (const id of ["short", "BBBBBBBBBBB", revoked.id]) {
      refusals.push(await call(p, "PUT", ratingsPath(id), { body }));
      refusals.push(await call(p, "POST", responsesPath(id), { body: { text: "x" } }));
    }
    refusals.push(await call(p, "PUT", `/sessions/other-session/reports/${good.id}/self-ratings`, { body }));
    const [first, ...rest] = refusals;
    expect(first!.status).toBe(404);
    for (const r of rest) { expect(r.status).toBe(404); expect(r.text).toBe(first!.text); expect(r.headers).toEqual(first!.headers); }
    expect(first!.json).toEqual({ success: false, data: null, error: { code: "not_found", message: "Not found." } });
    const get = await call(p, "GET", `/sessions/${w.sessionId}/reports/short`);
    expect(get.text).toBe(first!.text);
  });

  it("maps outcomes: 409 and 400 keep code and message; 503 busy has code busy", async () => {
    for (const [status, code, message] of [[409, "closed", "m1"], [400, "invalid", "m2"], [409, "old_schema", "m3"], [503, "busy", "The review is busy right now. Try again in a moment."], [503, "unavailable", "m5"]] as const) {
      const { svc } = stub({ status, code, message });
      const p = await boot(svc);
      const r = await call(p, "POST", responsesPath(), { body: { text: "x" } });
      expect([r.status, r.json.error]).toEqual([status, { code, message }]);
      expect(r.headers.find(([k]) => k === "retry-after")).toBeUndefined();
    }
  });

  it("429 carries Retry-After (seconds, rounded up)", async () => {
    const { svc } = stub({ status: 429, code: "throttled", message: "slow down", retryAfterMs: 1_500 });
    const p = await boot(svc);
    const r = await call(p, "PUT", ratingsPath(), { body: { ratings: [] } });
    expect([r.status, r.json.error.code]).toEqual([429, "throttled"]);
    expect(r.headers.find(([k]) => k === "retry-after")![1]).toBe("2");
  });

  it("a 7-criterion body fits the 64 KB cap; the real service writes every fixture criterion with full-length CJK notes; 1,500 emoji pass a released review (Review Focus 3)", async () => {
    const real = createParticipantWriteService({ config: w.config, store: w.store, secrets: [], now: () => w.clock.t, sleep: async () => {}, random: () => 0.5 });
    const p = await boot(real);
    const cred = (await w.store.issue(w.sessionId, "alice")).credential;
    const ids = (await loadReview(w.dir)).view.subjects.get("alice")!.criteria.map((c) => c.id);
    const note = "漢".repeat(1500);
    // Seven distinct criteria (today's rubrics have 7) reach the service intact through the 64 KB cap.
    const seven = Array.from({ length: 7 }, (_, i) => ({ criterion: `crit_${i}`, level: 3 as const, note }));
    const size = Buffer.byteLength(JSON.stringify({ ratings: seven }));
    expect(size).toBeGreaterThan(MAX_BODY_BYTES);
    expect(size).toBeLessThan(CAP_SELF);
    const seen = stub({ status: 200, wrote: 7 });
    const viaStub = await call(await boot(seen.svc), "PUT", ratingsPath(), { body: { ratings: seven } });
    expect([viaStub.status, viaStub.json.data]).toEqual([200, { wrote: 7 }]);
    expect(seen.rate).toHaveBeenCalledWith(w.sessionId, CRED, seven);
    // And the real service writes every criterion the review has (the fixture has 3), each with a 1,500-character CJK note.
    const r = await call(p, "PUT", ratingsPath(cred.id), { body: { ratings: ids.map((c) => ({ criterion: c, level: 3, note })) } });
    expect([r.status, r.json.success, r.json.data]).toEqual([200, true, { wrote: ids.length }]);
    // 1,500 emoji are 3,000 UTF-16 units: inside the schema bound. A response needs a released review, so run it against one.
    const saved = w;
    const released = await makeReportWorld();
    w = released;
    try {
      const rp = await boot(createParticipantWriteService({ config: released.config, store: released.store, secrets: [], now: () => released.clock.t, sleep: async () => {}, random: () => 0.5 }));
      const rc = (await released.store.issue(released.sessionId, "alice")).credential;
      const e = await call(rp, "POST", responsesPath(rc.id), { body: { text: "\u{1F600}".repeat(1500) } });
      expect([e.status, e.json.success, e.json.data]).toEqual([200, true, { wrote: true }]);
    } finally { w = saved; await released.cleanup(); }
  });

  it("one byte over either cap is 413 with the fixed sentence; other routes still cap at 4 KB", async () => {
    const { svc, rate, respond } = stub({ status: 200, wrote: 1 });
    const p = await boot(svc);
    const padded = (total: number, key: string): string => {
      const base = JSON.stringify({ [key]: "" }).length;
      return JSON.stringify({ [key]: "x".repeat(total - base) });
    };
    // Exactly at the cap: read fine (a 400 from the schema, never a 413).
    const atSelf = padded(CAP_SELF, "ratings");
    expect(Buffer.byteLength(atSelf)).toBe(CAP_SELF);
    expect((await call(p, "PUT", ratingsPath(), { raw: atSelf })).status).toBe(400);
    const overSelf = await call(p, "PUT", ratingsPath(), { raw: padded(CAP_SELF + 1, "ratings") });
    expect([overSelf.status, overSelf.json]).toEqual([413, FIXED_413]);
    const atResp = padded(CAP_RESPONSE, "text");
    expect((await call(p, "POST", responsesPath(), { raw: atResp })).status).toBe(400); // text over 3000 units: schema, not size
    const overResp = await call(p, "POST", responsesPath(), { raw: padded(CAP_RESPONSE + 1, "text") });
    expect([overResp.status, overResp.json]).toEqual([413, FIXED_413]);
    // A 16 KB+1 body to the self-ratings route is under its own cap (400 from the schema, not 413).
    expect((await call(p, "PUT", ratingsPath(), { raw: padded(CAP_RESPONSE + 1, "ratings") })).status).toBe(400);
    // Other routes keep 4 KB.
    const overOther = await call(p, "POST", `/sessions/${w.sessionId}/restart`, { raw: padded(MAX_BODY_BYTES + 1, "x") });
    expect(overOther.status).toBe(413);
    const atOther = await call(p, "POST", `/sessions/${w.sessionId}/restart`, { raw: padded(MAX_BODY_BYTES, "x") });
    expect(atOther.status).not.toBe(413);
    expect(rate).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });

  it("the 2c-1 GET and link routes are unchanged", async () => {
    const reports = {
      read: vi.fn(async () => ({ status: 200, body: { hello: 1 } })),
      links: vi.fn(async () => ({ state: "ready", roles: [] })),
    };
    const { svc } = stub({ status: 200, wrote: 1 });
    const p = await boot(svc, { reports });
    const g = await call(p, "GET", `/sessions/${w.sessionId}/reports/${CRED}`);
    expect([g.status, g.json.data]).toEqual([200, { hello: 1 }]);
    const l = await call(p, "GET", `/sessions/${w.sessionId}/report-links`);
    expect([l.status, l.json.data]).toEqual([200, { state: "ready", roles: [] }]);
    expect((await call(p, "PUT", `/sessions/${w.sessionId}/reports/${CRED}`, { body: {} })).status).toBe(404);
    expect((await call(p, "GET", ratingsPath())).status).toBe(404); // wrong method
  });
});
