import http from "node:http";
import type { AddressInfo } from "node:net";
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

  it("sends a GET with redirect manual and cancels the body", async () => {
    let cancelled = false;
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    const fetchFn = (async (u: string | URL | Request, init?: RequestInit) => { calls.push({ url: String(u), init }); return new Response(body, { status: 500 }); }) as typeof fetch;
    expect(await httpAnswers("http://127.0.0.1:9/", { fetchFn })).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.method).toBe("GET");
    expect(calls[0]!.init?.redirect).toBe("manual");
    expect(calls[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    expect(cancelled).toBe(true);
  });

  it("an answer whose body cannot be cancelled still counts", async () => {
    const res = { status: 200, body: { cancel: () => Promise.reject(new Error("boom")) } } as unknown as Response;
    expect(await httpAnswers("http://127.0.0.1:9/", { fetchFn: (async () => res) as typeof fetch })).toBe(true);
  });

  it("never throws for a malformed URL, a throwing fetch or a throwing timeout", async () => {
    expect(await httpAnswers("not a url")).toBe(false);
    expect(await httpAnswers("http://127.0.0.1:9/", { fetchFn: (() => { throw new Error("sync"); }) as unknown as typeof fetch })).toBe(false);
    expect(await httpAnswers("http://127.0.0.1:9/", { timeout: () => { throw new RangeError("bad"); } })).toBe(false);
  });

  it("never logs", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    try {
      await httpAnswers("not a url");
      await httpAnswers("http://127.0.0.1:9/", { fetchFn: (async () => { throw new Error("x"); }) as typeof fetch });
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally { for (const s of spies) s.mockRestore(); }
  });
});
