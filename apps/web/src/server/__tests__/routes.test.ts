import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeps, route } from "../routes";
import { RuntimeConnection } from "../runtime-connection";
import { StreamHub } from "../stream-hub";
import { JoinThrottle } from "../throttle";

const KEY = Buffer.alloc(32, 3).toString("base64");
const ENV = { RUNTIME_URL: "ws://127.0.0.1:4100", PUBLIC_ORIGIN: "https://play.example.org", COOKIE_KEYS: `k1:${KEY}` };

afterEach(() => { vi.restoreAllMocks(); });

describe("createDeps", () => {
  it("builds the handlers' dependencies from the environment", () => {
    const d = createDeps(ENV);
    expect(d.config.publicOrigin).toBe(ENV.PUBLIC_ORIGIN);
    expect(d.hub).toBeInstanceOf(StreamHub);
    expect(d.joinThrottle).toBeInstanceOf(JoinThrottle);
    expect(d.connect).toBe(RuntimeConnection.connect);
    expect(typeof d.now()).toBe("number");
  });

  it("the BFF join throttle blocks after more than five failures for one (address, role), like the runtime's", () => {
    const d = createDeps(ENV);
    for (let i = 0; i < 5; i++) d.joinThrottle.fail("198.51.100.1", "r");
    expect(d.joinThrottle.blockedForMs("198.51.100.1", "r")).toBe(0);
    d.joinThrottle.fail("198.51.100.1", "r");
    expect(d.joinThrottle.blockedForMs("198.51.100.1", "r")).toBeGreaterThan(0);
  });
});

describe("route", () => {
  it("answers a configuration error with a 500 envelope that quotes no value, and logs only the rule", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = route(async () => new Response("never"), () => createDeps({ ...ENV, COOKIE_KEYS: "k1:c2VjcmV0LWtleQ==" }));
    const res = await h(new Request("https://play.example.org/api/v1/join", { method: "POST" }));
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(JSON.parse(body)).toMatchObject({ success: false, error: { code: "internal" } });
    expect(body).not.toContain("c2VjcmV0");
    expect(body).not.toContain("COOKIE_KEYS");
    expect(log).toHaveBeenCalled();
    expect(String(log.mock.calls[0]![0])).not.toContain("c2VjcmV0");
  });

  it("answers a handler that throws with a 500 envelope, never the error text", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const h = route(async () => { throw new Error("SECRET-DETAIL"); }, () => createDeps(ENV));
    const res = await h(new Request("https://play.example.org/api/v1/say", { method: "POST" }));
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain("SECRET-DETAIL");
    expect(JSON.stringify(log.mock.calls)).not.toContain("SECRET-DETAIL");
  });

  it("by default every route shares one set of dependencies built from process.env (say must reach the stream's hub)", async () => {
    const SHARED = Symbol.for("scenecoach.web.deps");
    const g = globalThis as Record<symbol, unknown>;
    delete g[SHARED];
    for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
    try {
      const seen: unknown[] = [];
      const a = route(async (_req, d) => { seen.push(d); return new Response("a"); });
      const b = route(async (_req, d) => { seen.push(d); return new Response("b"); });
      await a(new Request("https://x/"));
      await b(new Request("https://x/"));
      expect(seen[0]).toBe(seen[1]);
      expect((seen[0] as ReturnType<typeof createDeps>).hub).toBeInstanceOf(StreamHub);
      expect(g[SHARED]).toBe(seen[0]);
    } finally {
      vi.unstubAllEnvs();
      delete g[SHARED];
    }
  });

  it("passes the request and the dependencies through", async () => {
    const d = createDeps(ENV);
    const h = route(async (req, deps) => new Response(`${req.method} ${deps === d}`), () => d);
    expect(await (await h(new Request("https://x/", { method: "POST" }))).text()).toBe("POST true");
  });
});

describe("route files", () => {
  const FILES = { join: "POST", stream: "GET", say: "POST", consent: "POST", leave: "POST" } as const;
  it("only re-export a handler and declare the Node runtime and dynamic rendering", () => {
    for (const [name, method] of Object.entries(FILES)) {
      const text = readFileSync(fileURLToPath(new URL(`../../app/api/v1/${name}/route.ts`, import.meta.url)), "utf8");
      const code = text.split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("//"));
      expect(code, name).toEqual([
        `export { ${name}${method} as ${method} } from "../../../../server/routes";`,
        `export const runtime = "nodejs";`,
        `export const dynamic = "force-dynamic";`,
      ]);
    }
  });

  it("the re-exported handlers exist", async () => {
    const routes = await import("../routes");
    for (const [name, method] of Object.entries(FILES)) expect(typeof (routes as Record<string, unknown>)[`${name}${method}`], name).toBe("function");
  });
});
