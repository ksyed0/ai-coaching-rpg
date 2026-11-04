import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApi } from "../api.js";
import type { ControlConfig } from "../config.js";
import { ControlError, type ControlErrorCode, type Supervisor } from "../supervisor.js";

const TOKEN = "t".repeat(40);
const FAC_TOKEN = "f".repeat(64);
const ID = "a".repeat(32);
const CODE = "plum-otter-1234";
const config = { serviceToken: TOKEN } as ControlConfig;

type Calls = { name: string; args: unknown[] }[];

function stub(over: Partial<Record<string, (...a: any[]) => unknown>> = {}): { sup: Supervisor; calls: Calls } {
  const calls: Calls = [];
  const rec = (name: string, fn: (...a: any[]) => unknown) => (...args: any[]) => { calls.push({ name, args }); return fn(...args); };
  const info = { sessionId: ID, scenarioId: "friday-escalation", status: "running", port: 4321, modelLabel: "mock" };
  const impl: Record<string, (...a: any[]) => unknown> = {
    create: () => Promise.resolve({ ...info, codes: [{ roleId: "cfo", code: CODE }] }),
    get: (id: string) => (id === ID ? info : undefined),
    list: () => [info],
    facilitator: (id: string) => (id === ID ? { port: 4321, token: FAC_TOKEN } : undefined),
    reissue: () => Promise.resolve(CODE),
    reissueAll: () => Promise.resolve([{ roleId: "cfo", code: CODE }]),
    restart: () => Promise.resolve(info),
    ...over,
  };
  const sup: Record<string, unknown> = {};
  for (const [k, fn] of Object.entries(impl)) sup[k] = rec(k, fn);
  return { sup: sup as unknown as Supervisor, calls };
}

const servers: http.Server[] = [];
async function boot(sup: Supervisor, extra: { log?: (m: string) => void; scenarios?: () => Promise<{ id: string; title: string }[]> } = {}): Promise<number> {
  const handler = createApi({ config, supervisor: sup, scenarios: extra.scenarios ?? (() => Promise.resolve([{ id: "friday-escalation", title: "Friday" }])), log: extra.log });
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  servers.push(server);
  return (server.address() as AddressInfo).port;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); })));
});

type Reply = { status: number; headers: Headers; text: string; json: any };
async function call(port: number, method: string, path: string, o: { token?: string | null; body?: string; type?: string | null } = {}): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (o.token !== null) headers["x-service-token"] = o.token ?? TOKEN;
  if (o.body !== undefined && o.type !== null) headers["content-type"] = o.type ?? "application/json";
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body: o.body });
  const text = await res.text();
  let json: unknown = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, headers: res.headers, text, json };
}

describe("authentication", () => {
  it("missing or wrong token returns 401 with no detail, also for unknown routes", async () => {
    const { sup, calls } = stub();
    const port = await boot(sup);
    const paths: [string, string][] = [
      ["GET", "/scenarios"], ["POST", "/sessions"], ["GET", "/sessions"], ["GET", `/sessions/${ID}`], ["GET", `/sessions/${ID}/facilitator`],
      ["POST", `/sessions/${ID}/codes/reissue`], ["POST", `/sessions/${ID}/restart`], ["GET", "/nope"], ["DELETE", "/sessions"], ["GET", "/sessions/not-an-id"],
    ];
    const bodies = new Set<string>();
    for (const [m, p] of paths) {
      for (const token of [null, "wrong", TOKEN.slice(0, -1), TOKEN + "x", ""]) {
        const r = await call(port, m, p, { token, ...(m === "POST" ? { body: "{}" } : {}) });
        expect(r.status, `${m} ${p} ${String(token)}`).toBe(401);
        expect(r.json).toEqual({ success: false, data: null, error: { code: "unauthorized", message: "Unauthorized." } });
        bodies.add(r.text);
      }
    }
    expect(bodies.size).toBe(1); // the same body for every route and every kind of failure
    expect(calls).toEqual([]); // the supervisor was never reached
  });

  it("an authenticated unknown route is a plain 404", async () => {
    const port = await boot(stub().sup);
    const r = await call(port, "GET", "/nope");
    expect(r.status).toBe(404);
    expect(r.json.error.code).toBe("not_found");
  });

  it("POST /sessions/:id/ai-roles is 404 (method not routed) and nothing is called", async () => {
    const { sup, calls } = stub();
    const port = await boot(sup);
    const r = await call(port, "POST", `/sessions/${ID}/ai-roles`, { body: JSON.stringify({ roles: ["cfo"] }) });
    expect(r.status).toBe(404);
    expect(calls).toEqual([]);
  });

  describe("AI roles and intents routes", () => {
    const AI_CODE = "ai-secret-code-1";
    const aiStub = (over: Partial<Record<string, (...a: any[]) => unknown>> = {}) => stub({
      setAiRoles: (_id: string, roles: string[]) => Promise.resolve({ roles, codes: [] }),
      intents: () => [{ at: 1, kind: "spoke", text: "hello" }],
      ...over,
    });
    const put = (port: number, body: unknown, o: { token?: string | null; path?: string } = {}) =>
      call(port, "PUT", o.path ?? `/sessions/${ID}/ai-roles`, { body: typeof body === "string" ? body : JSON.stringify(body), ...(o.token !== undefined ? { token: o.token } : {}) });

    it("PUT without the service token is 401 and calls nothing; GET intents too", async () => {
      const { sup, calls } = aiStub();
      const port = await boot(sup);
      expect((await put(port, { roles: ["tech_lead"] }, { token: null })).status).toBe(401);
      expect((await call(port, "GET", `/sessions/${ID}/ai-roles/tech_lead/intents`, { token: "x".repeat(40) })).status).toBe(401);
      expect(calls).toEqual([]);
    });

    it("PUT with {roles:[tech_lead]} answers roles and an empty codes list", async () => {
      const { sup, calls } = aiStub();
      const port = await boot(sup);
      const r = await put(port, { roles: ["tech_lead"] });
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ success: true, data: { roles: ["tech_lead"], codes: [] }, error: null });
      expect(calls).toEqual([{ name: "setAiRoles", args: [ID, ["tech_lead"]] }]);
    });

    it("PUT passes the supervisor's human codes through and never an AI code", async () => {
      const { sup } = aiStub({ setAiRoles: () => Promise.resolve({ roles: ["tech_lead"], codes: [{ roleId: "cfo", code: CODE }] }) });
      const port = await boot(sup);
      const r = await put(port, { roles: ["tech_lead"] });
      expect(r.json.data).toEqual({ roles: ["tech_lead"], codes: [{ roleId: "cfo", code: CODE }] });
      expect(r.text).not.toContain(AI_CODE);
    });

    it("PUT with an extra key, 13 roles, a non-array or a bad body is 400 and calls nothing", async () => {
      const { sup, calls } = aiStub();
      const port = await boot(sup);
      for (const body of [{ roles: [], x: 1 }, { roles: Array.from({ length: 13 }, (_, i) => `r${i}`) }, { roles: "tech_lead" }, { roles: [""] }, { roles: ["a".repeat(201)] }, "{nope", {}]) {
        expect((await put(port, body)).status, JSON.stringify(body).slice(0, 40)).toBe(400);
      }
      expect(calls).toEqual([]);
    });

    it("the AI refusals answer with their own code and status", async () => {
      const cases: [ControlErrorCode, number][] = [["ai_too_many", 409], ["ai_notice", 409], ["ai_started", 409], ["ai_no_human", 409], ["ai_invalid", 400], ["ai_role", 409]];
      for (const [code, status] of cases) {
        const { sup } = aiStub({ setAiRoles: () => Promise.reject(new ControlError(code, "fixed text")) });
        const port = await boot(sup);
        const r = await put(port, { roles: ["tech_lead"] });
        expect([r.status, r.json.error.code, r.json.error.message]).toEqual([status, code, "fixed text"]);
      }
    });

    it("reissue and remove of an AI role answer 409 ai_role through the routes", async () => {
      const { sup } = aiStub({ reissue: () => Promise.reject(new ControlError("ai_role", "switch the role back to human first")) });
      const port = await boot(sup);
      for (const body of [{ roleId: "tech_lead" }, { roleId: "tech_lead", reason: "removed" }]) {
        const r = await call(port, "POST", `/sessions/${ID}/codes/reissue`, { body: JSON.stringify(body) });
        expect([r.status, r.json.error.code, r.json.error.message]).toEqual([409, "ai_role", "switch the role back to human first"]);
      }
    });

    it("create, restart and reissueAll answer exactly what the supervisor returned (the route reconstructs no AI code)", async () => {
      const human = [{ roleId: "cfo", code: CODE }];
      const info = { sessionId: ID, scenarioId: "friday-escalation", status: "running", port: 4321, modelLabel: "mock" };
      const { sup } = aiStub({
        create: () => Promise.resolve({ ...info, codes: human }), restart: () => Promise.resolve({ ...info, codes: human }), reissueAll: () => Promise.resolve(human),
        get: () => ({ ...info, aiRoles: ["tech_lead"] }),
      });
      const port = await boot(sup);
      const texts = [
        (await call(port, "POST", "/sessions", { body: JSON.stringify({ scenarioId: "friday-escalation" }) })).text,
        (await call(port, "POST", `/sessions/${ID}/restart`)).text,
        (await call(port, "POST", `/sessions/${ID}/codes/reissue`, { body: JSON.stringify({ all: true }) })).text,
      ];
      for (const t of texts) { expect(t).toContain(CODE); expect(t).not.toContain(AI_CODE); }
    });

    describe("prompted turns", () => {
      const RES = "a1".repeat(16);
      const turnStub = (over: Partial<Record<string, (...a: any[]) => unknown>> = {}) => aiStub({
        reserveTurn: () => RES, runTurn: () => undefined, releaseTurn: () => undefined, ...over,
      });
      const post = (port: number, role: string, verb: string, body: unknown = {}, token?: string | null) =>
        call(port, "POST", `/sessions/${ID}/ai-roles/${role}/${verb}`, { body: typeof body === "string" ? body : JSON.stringify(body), ...(token !== undefined ? { token } : {}) });

      it("reserve, run and release answer their shapes and pass the hint on", async () => {
        const { sup, calls } = turnStub();
        const port = await boot(sup);
        expect((await post(port, "tech_lead", "reserve")).json.data).toEqual({ reservation: RES });
        expect((await post(port, "tech_lead", "run", { reservation: RES, hint: "steer" })).json.data).toEqual({ started: true });
        expect((await post(port, "tech_lead", "run", { reservation: RES })).json.data).toEqual({ started: true });
        expect((await post(port, "tech_lead", "release", { reservation: RES })).json.data).toEqual({});
        expect(calls.map((c) => c.name)).toEqual(["reserveTurn", "runTurn", "runTurn", "releaseTurn"]);
        expect(calls[1]!.args).toEqual([ID, "tech_lead", RES, "steer"]);
      });

      it("they need the service token (401, nothing called)", async () => {
        const { sup, calls } = turnStub();
        const port = await boot(sup);
        for (const v of ["reserve", "run", "release"]) expect((await post(port, "tech_lead", v, { reservation: RES }, null)).status).toBe(401);
        expect(calls).toEqual([]);
      });

      it("a bad roleId or path trick is 404 before anything is called", async () => {
        const { sup, calls } = turnStub();
        const port = await boot(sup);
        for (const v of ["reserve", "run", "release"]) {
          for (const r of ["..%2Fx", "Tech_Lead", "a%00b", "%zz", "%2e%2e", "a".repeat(300), "facilitator"]) {
            const res = await call(port, "POST", `/sessions/${ID}/ai-roles/${r}/${v}`, { body: JSON.stringify({ reservation: RES }) });
            expect(res.status, `${v} ${r}`).toBe(404);
          }
          for (const p of [`/sessions/${ID}/ai-roles//${v}`, `/sessions/${ID}/ai-roles/./${v}`, `/sessions/${ID}/ai-roles/../${v}`, `/sessions/${ID}//ai-roles/tech_lead/${v}`]) {
            expect((await call(port, "POST", p, { body: JSON.stringify({ reservation: RES }) })).status, p).toBe(404);
          }
        }
        expect(calls).toEqual([]);
      });

      it("strict bodies: extra keys, a bad reservation, a 1201-unit hint and a non-string hint are 400", async () => {
        const { sup, calls } = turnStub();
        const port = await boot(sup);
        expect((await post(port, "tech_lead", "reserve", { x: 1 })).status).toBe(400);
        for (const body of [{ reservation: RES, x: 1 }, { reservation: "short" }, { reservation: RES.toUpperCase() }, { reservation: RES, hint: "a".repeat(1201) }, { reservation: RES, hint: 5 }, {}]) {
          expect((await post(port, "tech_lead", "run", body)).status, JSON.stringify(body).slice(0, 40)).toBe(400);
        }
        expect((await post(port, "tech_lead", "release", { reservation: RES, y: 1 })).status).toBe(400);
        expect((await post(port, "tech_lead", "run", { reservation: RES, hint: "a".repeat(1200) })).status).toBe(200);
        expect(calls.map((c) => c.name)).toEqual(["runTurn"]);
      });

      it("the four prompt codes answer 409 with their code", async () => {
        for (const code of ["ai_busy", "ai_budget", "ai_absent", "ai_expired"] as const) {
          const { sup } = turnStub({ reserveTurn: () => { throw new ControlError(code, "fixed"); }, runTurn: () => { throw new ControlError(code, "fixed"); } });
          const port = await boot(sup);
          for (const r of [await post(port, "tech_lead", "reserve"), await post(port, "tech_lead", "run", { reservation: RES, hint: "HINT-SECRET-91" })]) {
            expect([r.status, r.json.error.code, r.json.error.message]).toEqual([409, code, "fixed"]);
            expect(r.text).not.toContain("HINT-SECRET-91");
          }
        }
      });

      it("the hint is not logged when a run fails unexpectedly", async () => {
        const logs: string[] = [];
        const { sup } = turnStub({ runTurn: () => { throw new Error("boom HINT-SECRET-91"); } });
        const port = await boot(sup, { log: (m) => logs.push(m) });
        const r = await post(port, "tech_lead", "run", { reservation: RES, hint: "HINT-SECRET-91" });
        expect(r.status).toBe(500);
        expect(r.text + logs.join("\n")).not.toContain("HINT-SECRET-91");
      });
    });

    it("GET intents returns the host's entries", async () => {
      const { sup, calls } = aiStub();
      const port = await boot(sup);
      const r = await call(port, "GET", `/sessions/${ID}/ai-roles/tech_lead/intents`);
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ success: true, data: { entries: [{ at: 1, kind: "spoke", text: "hello" }] }, error: null });
      expect(calls).toEqual([{ name: "intents", args: [ID, "tech_lead"] }]);
    });

    it("GET intents for a bad role segment or path trick is 404 and the host is never asked", async () => {
      const { sup, calls } = aiStub();
      const port = await boot(sup);
      const paths = [
        "..%2Fx", "Tech_Lead", "a%00b", "%zz", "%E0%A4%A", "%2e%2e", "a".repeat(300), "facilitator", "tech lead", "tech_lead%2F..%2Fx", "",
      ].map((r) => `/sessions/${ID}/ai-roles/${r}/intents`);
      paths.push(`/sessions/${ID}/ai-roles//intents`, `/sessions/${ID}/ai-roles/./intents`, `/sessions/${ID}/ai-roles/../intents`, `/sessions/${ID}//ai-roles/tech_lead/intents`);
      for (const p of paths) {
        const r = await call(port, "GET", p);
        expect(r.status, p).toBe(404);
        expect(r.json.error.code, p).toBe("not_found");
      }
      expect(calls.filter((c) => c.name === "intents")).toEqual([]);
    });

    it("GET intents of an unknown session is 404", async () => {
      const { sup } = aiStub({ intents: () => { throw new ControlError("not_found", "that session does not exist"); } });
      const port = await boot(sup);
      expect((await call(port, "GET", `/sessions/${ID}/ai-roles/tech_lead/intents`)).status).toBe(404);
      expect((await call(port, "GET", `/sessions/${"b".repeat(32)}/ai-roles/tech_lead/intents`)).status).toBe(404);
    });

    it("no log line of the new routes carries a code or a secret", async () => {
      const logs: string[] = [];
      const { sup } = aiStub({ setAiRoles: () => Promise.reject(new Error(`boom ${AI_CODE}`)) });
      const port = await boot(sup, { log: (m) => logs.push(m) });
      const r = await put(port, { roles: ["tech_lead"] });
      expect(r.status).toBe(500);
      expect(r.text).not.toContain(AI_CODE);
      expect(logs.join("\n")).not.toContain(AI_CODE);
    });
  });

  it("every response is JSON, uncacheable and uses the envelope", async () => {
    const port = await boot(stub().sup);
    for (const r of [await call(port, "GET", "/scenarios"), await call(port, "GET", "/nope"), await call(port, "GET", "/scenarios", { token: null })]) {
      expect(r.headers.get("content-type")).toBe("application/json");
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(Object.keys(r.json).sort()).toEqual(["data", "error", "success"]);
    }
  });
});

describe("routes", () => {
  it("GET /scenarios lists id and title", async () => {
    const port = await boot(stub().sup);
    const r = await call(port, "GET", "/scenarios");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ success: true, data: [{ id: "friday-escalation", title: "Friday" }], error: null });
  });

  it("POST /sessions creates and returns the codes in the response body only", async () => {
    const logs: string[] = [];
    const { sup, calls } = stub();
    const port = await boot(sup, { log: (m) => logs.push(m) });
    const r = await call(port, "POST", "/sessions", { body: JSON.stringify({ scenarioId: "friday-escalation" }) });
    expect(r.status).toBe(200);
    expect(r.json.data.codes).toEqual([{ roleId: "cfo", code: CODE }]);
    expect(calls).toEqual([{ name: "create", args: ["friday-escalation"] }]);
    expect(logs.join("\n")).not.toContain(CODE);
  });

  it('scenarioId "../x" returns 400 (the supervisor refuses it as unknown_scenario)', async () => {
    const { sup, calls } = stub({ create: () => Promise.reject(new ControlError("unknown_scenario", "that scenario is not available")) });
    const port = await boot(sup);
    const r = await call(port, "POST", "/sessions", { body: JSON.stringify({ scenarioId: "../x" }) });
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ success: false, data: null, error: { code: "unknown_scenario", message: "that scenario is not available" } });
    expect(calls).toHaveLength(1);
    expect(r.text).not.toContain("..");
  });

  it("GET /sessions and GET /sessions/:id return the session info (port and modelLabel only when known)", async () => {
    const stopped = { sessionId: ID, scenarioId: "friday-escalation", status: "stopped" };
    const { sup } = stub({ get: () => stopped, list: () => [stopped] });
    const port = await boot(sup);
    expect((await call(port, "GET", "/sessions")).json.data).toEqual([stopped]);
    expect((await call(port, "GET", `/sessions/${ID}`)).json.data).toEqual(stopped);
    const running = await boot(stub().sup);
    expect((await call(running, "GET", `/sessions/${ID}`)).json.data).toEqual({ sessionId: ID, scenarioId: "friday-escalation", status: "running", port: 4321, modelLabel: "mock" });
  });

  it("an unknown session id is a plain 404 and a malformed one never reaches the supervisor", async () => {
    const { sup, calls } = stub();
    const port = await boot(sup);
    const other = "b".repeat(32);
    for (const [m, p] of [["GET", `/sessions/${other}`], ["GET", `/sessions/${other}/facilitator`]] as const) {
      const r = await call(port, m, p);
      expect(r.status).toBe(404);
      expect(r.json.error.code).toBe("not_found");
    }
    calls.length = 0;
    for (const bad of ["..", "%2e%2e", "a".repeat(65), `${ID}%00`, "a%2Fb", "a%20b", "%ZZ", "a.b"]) {
      for (const [m, tail] of [["GET", ""], ["GET", "/facilitator"], ["POST", "/restart"], ["POST", "/codes/reissue"]] as const) {
        const r = await call(port, m, `/sessions/${bad}${tail}`, m === "POST" ? { body: "{}" } : {});
        expect([400, 404], `${m} ${bad}${tail}`).toContain(r.status);
        expect(r.json.success).toBe(false);
      }
    }
    expect(calls).toEqual([]);
  });

  it("GET /sessions/:id/facilitator returns port and token together and is never logged", async () => {
    const logs: string[] = [];
    const port = await boot(stub().sup, { log: (m) => logs.push(m) });
    const r = await call(port, "GET", `/sessions/${ID}/facilitator`);
    expect(r.status).toBe(200);
    expect(r.json.data).toEqual({ port: 4321, token: FAC_TOKEN });
    expect(logs.join("\n")).not.toContain(FAC_TOKEN);
    expect(logs.join("\n")).not.toContain("4321");
  });

  it("the facilitator route is 404 unless the session is running", async () => {
    const port = await boot(stub({ facilitator: () => undefined }).sup);
    const r = await call(port, "GET", `/sessions/${ID}/facilitator`);
    expect(r.status).toBe(404);
    expect(r.text).not.toContain(FAC_TOKEN);
  });

  it("reissue with roleId vs all:true routes to reissue vs reissueAll; neither (or both) is a 400", async () => {
    const { sup, calls } = stub();
    const port = await boot(sup);
    const one = await call(port, "POST", `/sessions/${ID}/codes/reissue`, { body: JSON.stringify({ roleId: "cfo", by: "Ana" }) });
    expect(one.json).toEqual({ success: true, data: { code: CODE }, error: null });
    const all1 = await call(port, "POST", `/sessions/${ID}/codes/reissue`, { body: JSON.stringify({ all: true }) });
    const all2 = await call(port, "POST", `/sessions/${ID}/codes/reissue`, { body: JSON.stringify({ all: true, by: "Ana" }) });
    for (const r of [all1, all2]) expect(r.json).toEqual({ success: true, data: { codes: [{ roleId: "cfo", code: CODE }] }, error: null });
    const bodies = [undefined, "{}", JSON.stringify({ by: "Ana" }), JSON.stringify({ all: false }), JSON.stringify({ all: true, roleId: "cfo" })];
    for (const body of bodies) expect((await call(port, "POST", `/sessions/${ID}/codes/reissue`, body === undefined ? {} : { body })).status).toBe(400);
    expect(calls).toEqual([
      { name: "reissue", args: [ID, "cfo", "Ana", undefined] },
      { name: "reissueAll", args: [ID, undefined] },
      { name: "reissueAll", args: [ID, "Ana"] },
    ]);
  });

  it("POST /sessions/:id/codes/reissue { roleId, reason: \"removed\" } returns the code and sends reason removed", async () => {
    const { sup, calls } = stub();
    const port = await boot(sup);
    const r = await call(port, "POST", `/sessions/${ID}/codes/reissue`, { body: JSON.stringify({ roleId: "cfo", by: "Ana", reason: "removed" }) });
    expect(r.json).toEqual({ success: true, data: { code: CODE }, error: null });
    expect(calls).toEqual([{ name: "reissue", args: [ID, "cfo", "Ana", "removed"] }]);
  });

  it("{ reason: \"removed\" } without roleId is 400, and so is any other reason", async () => {
    const { sup, calls } = stub();
    const port = await boot(sup);
    for (const body of [{ reason: "removed" }, { all: true, reason: "removed" }, { roleId: "cfo", reason: "other" }])
      expect((await call(port, "POST", `/sessions/${ID}/codes/reissue`, { body: JSON.stringify(body) })).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("POST /sessions/:id/restart returns the info and the codes when the supervisor returned them", async () => {
    const port = await boot(stub().sup);
    const plain = await call(port, "POST", `/sessions/${ID}/restart`);
    expect(plain.status).toBe(200);
    expect(plain.json.data).toEqual({ sessionId: ID, scenarioId: "friday-escalation", status: "running", port: 4321, modelLabel: "mock" });
    const withCodes = await boot(stub({ restart: () => Promise.resolve({ sessionId: ID, scenarioId: "s", status: "running", codes: [{ roleId: "cfo", code: CODE }] }) }).sup);
    expect((await call(withCodes, "POST", `/sessions/${ID}/restart`, { body: "{}" })).json.data.codes).toEqual([{ roleId: "cfo", code: CODE }]);
  });
});

describe("request bodies", () => {
  it("a body over 4 KB is refused with 413 before it is fully read", async () => {
    const { sup, calls } = stub();
    const port = await boot(sup);
    // Declared size over the cap, only a few bytes actually sent: the answer must arrive without the rest.
    const reply = await new Promise<string>((resolve, reject) => {
      const s = net.connect(port, "127.0.0.1");
      let data = "";
      s.on("data", (d) => { data += d.toString(); if (data.includes("\r\n\r\n") && data.includes("}")) { s.destroy(); resolve(data); } });
      s.on("error", reject);
      s.on("close", () => resolve(data));
      s.write(`POST /sessions HTTP/1.1\r\nHost: x\r\nx-service-token: ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: 1000000\r\n\r\n{"scenarioId":"`);
    });
    expect(reply.startsWith("HTTP/1.1 413")).toBe(true);
    expect(reply).toContain("payload_too_large");
    expect(calls).toEqual([]);
  });

  it("an over-cap body with no declared length (chunked) is refused with 413 once it passes 4096 bytes", async () => {
    const { sup, calls } = stub();
    const port = await boot(sup);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ port, host: "127.0.0.1", method: "POST", path: "/sessions", headers: { "x-service-token": TOKEN, "content-type": "application/json" } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on("error", (e) => { if ((e as NodeJS.ErrnoException).code !== "ECONNRESET") reject(e); });
      req.write(`{"scenarioId":"${"a".repeat(5000)}`);
    });
    expect(status).toBe(413);
    expect(calls).toEqual([]);
  });

  it("a body of exactly 4096 bytes is accepted for reading", async () => {
    const { sup } = stub({ create: () => Promise.reject(new ControlError("unknown_scenario", "that scenario is not available")) });
    const port = await boot(sup);
    const json = JSON.stringify({ scenarioId: "x" });
    const r = await call(port, "POST", "/sessions", { body: json + " ".repeat(4096 - json.length) });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe("unknown_scenario");
  });

  it("invalid JSON, unknown keys, wrong types and a wrong content-type are 400 bad_request with a fixed message", async () => {
    const { sup, calls } = stub();
    const port = await boot(sup);
    const cases: [string, string, { body: string; type?: string | null }][] = [
      ["POST", "/sessions", { body: "{not json" }],
      ["POST", "/sessions", { body: "" }],
      ["POST", "/sessions", { body: "[]" }],
      ["POST", "/sessions", { body: "null" }],
      ["POST", "/sessions", { body: JSON.stringify({ scenarioId: 5 }) }],
      ["POST", "/sessions", { body: JSON.stringify({ scenarioId: "" }) }],
      ["POST", "/sessions", { body: JSON.stringify({}) }],
      ["POST", "/sessions", { body: JSON.stringify({ scenarioId: "x", extra: 1 }) }],
      ["POST", "/sessions", { body: JSON.stringify({ scenarioId: "x" }), type: "text/plain" }],
      ["POST", "/sessions", { body: JSON.stringify({ scenarioId: "x" }), type: null }],
      ["POST", `/sessions/${ID}/codes/reissue`, { body: JSON.stringify({ roleId: 5 }) }],
      ["POST", `/sessions/${ID}/codes/reissue`, { body: JSON.stringify({ roleId: "cfo", by: 3 }) }],
      ["POST", `/sessions/${ID}/codes/reissue`, { body: JSON.stringify({ roleId: "cfo", nope: true }) }],
      ["POST", `/sessions/${ID}/codes/reissue`, { body: "{{" }],
      ["POST", `/sessions/${ID}/restart`, { body: JSON.stringify({ x: 1 }) }],
    ];
    const messages = new Set<string>();
    for (const [m, p, o] of cases) {
      const r = await call(port, m, p, o);
      expect(r.status, `${p} ${o.body}`).toBe(400);
      expect(r.json.error.code).toBe("bad_request");
      messages.add(r.json.error.message);
      expect(r.text).not.toContain("not json");
    }
    expect(messages.size).toBe(1);
    expect(calls).toEqual([]);
  });
});

describe("errors", () => {
  const table: [ControlErrorCode, number][] = [
    ["bad_request", 400], ["unknown_scenario", 400], ["not_found", 404], ["conflict", 409], ["capacity", 429], ["timeout", 504], ["start_failed", 502], ["unavailable", 503],
  ];
  it.each(table)("a ControlError %s maps to HTTP %i", async (code, status) => {
    const port = await boot(stub({ restart: () => Promise.reject(new ControlError(code, "plain words")) }).sup);
    const r = await call(port, "POST", `/sessions/${ID}/restart`);
    expect(r.status).toBe(status);
    expect(r.json).toEqual({ success: false, data: null, error: { code, message: "plain words" } });
  });

  it("an unexpected Error becomes 500 with the fixed message and logs only the error name", async () => {
    const logs: string[] = [];
    class Weird extends Error { constructor(m: string) { super(m); this.name = "WeirdError"; } }
    const secretPath = `/Users/x/secret/${FAC_TOKEN}/${CODE}`;
    const port = await boot(stub({ restart: () => Promise.reject(new Weird(`ENOENT ${secretPath}`)) }).sup, { log: (m) => logs.push(m) });
    const r = await call(port, "POST", `/sessions/${ID}/restart`);
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ success: false, data: null, error: { code: "internal", message: "Something went wrong." } });
    expect(logs).toEqual(["request failed (WeirdError)"]);
    expect(r.text + logs.join("")).not.toContain("secret");
  });

  it("a synchronous throw and a thrown non-Error are also 500 with a fixed log line", async () => {
    const logs: string[] = [];
    const port = await boot(stub({ list: () => { throw "boom /secret/path"; }, get: () => { throw new TypeError("x /secret"); } }).sup, { log: (m) => logs.push(m) });
    expect((await call(port, "GET", "/sessions")).status).toBe(500);
    expect((await call(port, "GET", `/sessions/${ID}`)).status).toBe(500);
    expect(logs).toEqual(["request failed (unknown)", "request failed (TypeError)"]);
  });

  it("a failing scenario listing is a 500, not a crash", async () => {
    const port = await boot(stub().sup, { scenarios: () => Promise.reject(new Error("cannot read /srv/scenarios")) });
    const r = await call(port, "GET", "/scenarios");
    expect(r.status).toBe(500);
    expect(r.text).not.toContain("/srv");
  });

  it("status text and error bodies never contain a token or code", async () => {
    const logs: string[] = [];
    const nasty = new ControlError("conflict", "the session is not running");
    const { sup } = stub({ restart: () => Promise.reject(nasty), reissue: () => Promise.reject(new Error(`bad ${CODE} ${FAC_TOKEN}`)) });
    const port = await boot(sup, { log: (m) => logs.push(m) });
    const replies = [
      await call(port, "POST", `/sessions/${ID}/restart`),
      await call(port, "POST", `/sessions/${ID}/codes/reissue`, { body: JSON.stringify({ roleId: "cfo" }) }),
      await call(port, "GET", "/nope", { token: "wrong" }),
      await call(port, "POST", "/sessions", { body: "{bad" }),
    ];
    const everything = replies.map((r) => r.text + r.headers.get("content-type")).join("\n") + logs.join("\n");
    for (const secret of [TOKEN, FAC_TOKEN, CODE]) expect(everything).not.toContain(secret);
  });
});
