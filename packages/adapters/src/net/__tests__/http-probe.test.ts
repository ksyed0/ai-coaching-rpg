import { execFile } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { httpAnswers, HTTP_PROBE_TIMEOUT_MS } from "../http-probe.js";
import * as root from "../../index.js";
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 }); // real loopback sockets; nothing here measures elapsed time

// US-0072 (EPIC-0003 voice A1c, Task 1): "does anything answer HTTP here?" for voice:up, voice:check and control's LiveKit probe.
const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise<void>((r) => s.close(() => r())); }
});

async function serve(handler: http.RequestListener): Promise<string> {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}/`;
}

describe("httpAnswers (US-0072, A1c Task 1)", () => {
  it("is exported from the root index with a 2 s default", () => {
    expect(root.httpAnswers).toBe(httpAnswers);
    expect(HTTP_PROBE_TIMEOUT_MS).toBe(2000);
  });

  it("true for a 404 answer (any HTTP answer counts)", async () => {
    const url = await serve((_req, res) => { res.statusCode = 404; res.end("not here"); });
    expect(await httpAnswers(url)).toBe(true);
  });

  it("true for a redirect, which is not followed", async () => {
    let hits = 0;
    const url = await serve((req, res) => { hits += 1; res.statusCode = 302; res.setHeader("location", "/elsewhere"); res.end(); void req; });
    expect(await httpAnswers(url)).toBe(true);
    expect(hits).toBe(1);
  });

  it("false for a closed port", async () => {
    const s = http.createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    const port = (s.address() as AddressInfo).port;
    await new Promise<void>((r) => s.close(() => r()));
    expect(await httpAnswers(`http://127.0.0.1:${port}/`)).toBe(false);
  });

  it("false when the request is aborted by its timeout (no real-time wait)", async () => {
    let arrived!: () => void;
    const held = new Promise<void>((r) => { arrived = r; });
    const url = await serve(() => { arrived(); }); // never answers
    const controller = new AbortController();
    let askedMs = -1;
    const probe = httpAnswers(url, { timeoutMs: 1234, timeout: (ms) => { askedMs = ms; return controller.signal; } });
    await held;
    controller.abort();
    expect(await probe).toBe(false);
    expect(askedMs).toBe(1234);
  });

  it("uses the default timeout when none is given", async () => {
    let askedMs = -1;
    const url = await serve((_req, res) => { res.end(); });
    expect(await httpAnswers(url, { timeout: (ms) => { askedMs = ms; return new AbortController().signal; } })).toBe(true);
    expect(askedMs).toBe(HTTP_PROBE_TIMEOUT_MS);
  });

  it("sends one GET and does not read or wait for the body", async () => {
    const seen: string[] = [];
    let release!: () => void;
    const url = await serve((req, res) => {
      seen.push(req.method ?? "");
      res.writeHead(500);
      res.write("partial"); // the body never ends until the test releases it: the probe must not wait for it
      release = () => res.end();
    });
    expect(await httpAnswers(url)).toBe(true);
    expect(seen).toEqual(["GET"]);
    release();
  });

  it("never throws for a malformed URL or a throwing timeout", async () => {
    expect(await httpAnswers("not a url")).toBe(false);
    expect(await httpAnswers("http://127.0.0.1:9/", { timeout: () => { throw new RangeError("bad"); } })).toBe(false);
  });

  // Review A F10: only loopback http is probed; anything else is false WITHOUT a request (a data: URL used to answer true through fetch).
  it.each([
    "data:,x", "data:text/plain,hello", "https://127.0.0.1:9/", "file:///etc/hosts", "ws://127.0.0.1:9/", "http://localhost:9/",
    "http://192.168.1.20:9/", "http://10.0.0.5:9/", "http://0.0.0.0:9/", "http://voice.invalid/", "http://user:pw@127.0.0.1:9/", "http://u@127.0.0.1:9/",
  ])("false for %s without a request", async (u) => {
    let asked = 0;
    expect(await httpAnswers(u, { timeout: (ms) => { asked += 1; return AbortSignal.timeout(ms); } })).toBe(false);
    expect(asked).toBe(0); // refused before a request (or a timer) was made
  });

  it("probes [::1] when the machine has IPv6 loopback", async () => {
    const s = http.createServer((_req, res) => { res.end(); });
    servers.push(s);
    const ok = await new Promise<boolean>((r) => { s.once("error", () => r(false)); s.listen(0, "::1", () => r(true)); });
    if (!ok) return; // no IPv6 loopback here (some containers): nothing to probe
    expect(await httpAnswers(`http://[::1]:${(s.address() as AddressInfo).port}/`)).toBe(true);
  });

  // Review A F10: with NODE_USE_ENV_PROXY=1 Node's fetch and the global http agent send the request, full URL included, to HTTP_PROXY.
  // A child Node (env proxy on, pointing at a loopback stand-in proxy) runs the real probe: the proxy must never see its request. The
  // child's own default-agent request is the self-check that the env proxy is active on this Node (22.21 and later).
  it("never goes through an environment proxy (NODE_USE_ENV_PROXY + HTTP_PROXY), so the path never reaches it", async () => {
    const proxied: string[] = [];
    const direct: string[] = [];
    const proxy = await serve((req, res) => { proxied.push(req.url ?? ""); res.end("proxy"); });
    const target = await serve((req, res) => { direct.push(req.url ?? ""); res.end("target"); });
    const probeFile = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "../http-probe.ts")).href;
    const script = `
      import http from "node:http";
      const { httpAnswers } = await import(${JSON.stringify(probeFile)});
      const probed = await httpAnswers(${JSON.stringify(target + "secret-probe-path")});
      await new Promise((r) => { const q = http.get(${JSON.stringify(target + "selfcheck")}, (res) => { res.resume(); res.on("end", r); }); q.on("error", r); });
      process.stdout.write(JSON.stringify({ probed }));
      process.exit(0);`;
    const env = { PATH: process.env.PATH ?? "", NODE_USE_ENV_PROXY: "1", HTTP_PROXY: proxy, http_proxy: proxy, NO_PROXY: "", no_proxy: "" };
    const out = await new Promise<string>((resolve, reject) => {
      execFile(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script], { env, timeout: 60_000 }, (err, stdout) => {
        if (err) reject(err); else resolve(String(stdout));
      });
    });
    expect(JSON.parse(out)).toEqual({ probed: true });
    expect(direct).toContain("/secret-probe-path");
    expect(proxied.some((u) => u.includes("secret-probe-path"))).toBe(false);
    const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
    if (major > 22 || (major === 22 && minor >= 21)) expect(proxied.some((u) => u.includes("selfcheck"))).toBe(true); // the env proxy was live
  });

  it("never logs", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    try {
      await httpAnswers("not a url");
      await httpAnswers("data:,x");
      await httpAnswers("http://127.0.0.1:9/", { timeout: () => AbortSignal.abort() });
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally { for (const s of spies) s.mockRestore(); }
  });
});
