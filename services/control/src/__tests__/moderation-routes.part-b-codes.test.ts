import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../api.js";
import type { ControlConfig } from "../config.js";
import type { ModerationService } from "../moderation.js";
import type { Supervisor } from "../supervisor.js";
import { sid } from "./fake-child.js";

/**
 * Route-level pins (AC-0384, TC-0152) for every 409 and 503 code the five part B routes (release, resolve, export, amend, withdraw)
 * can answer that `moderation-routes.test.ts` does not already reach. The moderation service is stubbed with the closed outcome (as
 * in the neighbouring route tests); `moderation-b.test.ts` shows the real service producing the same codes. Already covered there:
 * release/blocked, amend/superseded, resolve/needs_amend.
 */
const TOKEN = "t".repeat(40);
const ID = sid(7);
const BY = { by: "priya" };
const servers: http.Server[] = [];

type Route = { name: string; path: string; body: unknown };
const R = (s: string): string => `/sessions/${ID}/report${s}`;
const ROUTES: Record<string, Route> = {
  release: { name: "release", path: R("/release"), body: { subjects: ["alice"], ...BY } },
  resolve: { name: "resolve", path: R("/resolve"), body: { seq: 4, outcome: "declined", reason: "Stands.", ...BY } },
  export: { name: "export", path: R("/export"), body: { subject: "alice", audience: "facilitator", ...BY } },
  amend: { name: "amend", path: R("/subjects/alice/amend"), body: { reason: "Fix.", ...BY } },
  withdraw: { name: "withdraw", path: R("/subjects/alice/withdraw"), body: { reason: "Gone.", ...BY } },
};

async function boot(outcome: unknown, fn: string): Promise<{ port: number; stub: ReturnType<typeof vi.fn> }> {
  const stub = vi.fn(async () => outcome);
  const moderation = { [fn]: stub } as unknown as ModerationService;
  const supervisor = { get: (id: string) => (id === ID ? { sessionId: id } : undefined) } as unknown as Supervisor;
  const server = http.createServer(
    createApi({ config: { serviceToken: TOKEN } as ControlConfig, supervisor, scenarios: () => Promise.resolve([]), moderation }),
  );
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return { port: (server.address() as AddressInfo).port, stub };
}
async function post(port: number, r: Route): Promise<{ status: number; headers: Headers; text: string; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${r.path}`, {
    method: "POST", headers: { "x-service-token": TOKEN, "content-type": "application/json" }, body: JSON.stringify(r.body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: JSON.parse(text) };
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); })));
});

// route, code (the pairs `moderation-routes.test.ts` leaves out)
const REFUSALS: [string, string][] = [
  ["release", "no_review"], ["release", "not_editable"], ["release", "superseded"], ["release", "refused"],
  ["resolve", "no_review"], ["resolve", "refused"], ["resolve", "superseded"],
  ["export", "no_review"], ["export", "not_released"], ["export", "refused"], ["export", "superseded"],
  ["amend", "no_review"], ["amend", "not_editable"], ["amend", "refused"],
  ["withdraw", "no_review"], ["withdraw", "not_editable"], ["withdraw", "superseded"], ["withdraw", "refused"],
];
const ALL = ["release", "resolve", "export", "amend", "withdraw"];

// What each route must hand its service call: the session id, then (for the two subject routes) the path subject, then the parsed body, then `by`.
// Distinctive values, so a dropped or renamed field, or a swapped argument, fails the exact match.
const FORWARDED: Record<string, { body: unknown; call: unknown[] }> = {
  release: { body: { subjects: ["alice", "bob"], by: "priya" }, call: [ID, { subjects: ["alice", "bob"] }, "priya"] },
  resolve: { body: { seq: 4, outcome: "amended", reason: "Because.", by: "dana" }, call: [ID, { seq: 4, outcome: "amended", reason: "Because." }, "dana"] },
  export: { body: { subject: "bob", audience: "participant:alice", by: "eli" }, call: [ID, { subject: "bob", audience: "participant:alice" }, "eli"] },
  amend: { body: { reason: "Fix it.", by: "fran" }, call: [ID, "bob", { reason: "Fix it." }, "fran"] },
  withdraw: { body: { reason: "Gone now.", by: "gus" }, call: [ID, "bob", { reason: "Gone now." }, "gus"] },
};

describe("part B routes: 409 and 503 codes not reached by the neighbouring route tests", () => {
  it.each(REFUSALS)("%s answers 409 %s with only the closed code (detail text is dropped)", async (name, code) => {
    const { port, stub } = await boot({ status: 409, code, detail: ["/etc/secret is currently 3"] }, name);
    const x = await post(port, ROUTES[name]!);
    expect(stub).toHaveBeenCalledTimes(1);
    expect([x.status, x.json]).toEqual([409, { success: false, data: null, error: { code } }]);
    expect(x.text).not.toMatch(/secret|message/);
  });

  it.each(ALL)("%s answers 503 busy with the fixed sentence and Retry-After rounded up from retryAfterMs", async (name) => {
    const { port } = await boot({ status: 503, code: "busy", retryAfterMs: 1000 }, name);
    const x = await post(port, ROUTES[name]!);
    expect([x.status, x.headers.get("retry-after"), x.json]).toEqual([
      503, "1", { success: false, data: null, error: { code: "busy", message: "The report is busy. Try again." } },
    ]);
    const y = await boot({ status: 503, code: "busy", retryAfterMs: 1001 }, name);
    expect((await post(y.port, ROUTES[name]!)).headers.get("retry-after")).toBe("2");
  });

  it.each(ALL)("%s answers 503 unavailable with the fixed sentence and no Retry-After", async (name) => {
    const { port } = await boot({ status: 503, code: "unavailable" }, name);
    const x = await post(port, ROUTES[name]!);
    expect([x.status, x.headers.get("retry-after"), x.json]).toEqual([
      503, null, { success: false, data: null, error: { code: "unavailable", message: "The report is unavailable. Try again." } },
    ]);
  });

  it.each(ALL)("%s forwards the session id, the path subject, the parsed body and the typed name to the service", async (name) => {
    const { port, stub } = await boot({ status: 200, value: {} }, name);
    const f = FORWARDED[name]!;
    const route = ROUTES[name]!;
    const x = await post(port, { ...route, path: route.path.replace("/alice/", "/bob/"), body: f.body });
    expect(x.status).toBe(200);
    expect(stub).toHaveBeenCalledTimes(1);
    expect(stub.mock.calls[0]).toEqual(f.call);
  });
});
