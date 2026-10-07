import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RetryingModelProvider } from "@acr/adapters";
import { bootstrap, type Runtime } from "../main.js";
// Whole-demo and real-process/socket tests: a generous explicit limit (a loaded machine or coverage can be several times slower). Nothing here measures elapsed time.
vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const KEY = "sk-TEST-NEVER-LOG-12345";
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../packages/script/src/__tests__/fixtures/minimal");
let tmp: string; let runtime: Runtime | null = null; let server: http.Server; let baseUrl: string; let requests: number; let failFirst: number; let stderr: string[];

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "acr-retry-"));
  requests = 0; failFirst = 2; stderr = [];
  // The loopback "model": the first `failFirst` requests fail with 503 (overloaded), later ones stream a short reply.
  server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      requests++;
      if (requests <= failFirst) { res.writeHead(503, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { message: "Service temporarily overloaded" } })); return; }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "A real generated reply" } }] })}\n\ndata: [DONE]\n\n`);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { stderr.push(a.map(String).join(" ")); });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await runtime?.stop(); runtime = null;
  server.closeAllConnections(); await new Promise((r) => server.close(r));
  await rm(tmp, { recursive: true, force: true });
});

const env = (extra: Record<string, string> = {}) => ({ SCENARIO_DIR: fixture, RUNTIME_PORT: "0", SESSION_ID: "r1", MODEL_PROVIDER: "local", LOCAL_BASE_URL: baseUrl, LOCAL_API_KEY: KEY, NPC_MODEL: "m", GM_MODEL: "m", MODEL_RETRY_BASE_MS: "100", ...extra });
async function boot(extra: Record<string, string> = {}) {
  const r = await bootstrap({ env: env(extra), root: tmp, logDir: tmp, tickMs: 60_000, log: () => {}, warn: () => {} });
  if (r.ok) runtime = r.runtime;
  return r;
}
async function converse(rt: Runtime) {
  const seen: { type: string; text?: string; message?: string; fallback?: boolean }[] = [];
  rt.host.subscribe((e) => seen.push(e as never));
  rt.host.join("host", "p1");
  await rt.host.start();
  await rt.host.onPlayerUtterance("host", "Hi Sam");
  await rt.host.idle();
  return seen;
}

describe("bootstrap: model retries", () => {
  it("wraps BOTH the NPC and the Game Master provider with the retry wrapper, keeping the provider name", async () => {
    const r = await boot();
    expect(r.ok).toBe(true);
    const host = runtime!.host as unknown as { npcs: Map<string, { provider: unknown }>; gm: { provider: { name: string } } };
    for (const a of host.npcs.values()) { expect(a.provider).toBeInstanceOf(RetryingModelProvider); expect((a.provider as { name: string }).name).toBe("local"); }
    expect(host.gm.provider).toBeInstanceOf(RetryingModelProvider);
    expect(host.gm.provider.name).toBe("local");
  });
  it("a server that fails twice with 503 then succeeds yields a generated NPC reply: no fallback, no alert", async () => {
    await boot();
    const seen = await converse(runtime!);
    const says = seen.filter((e) => e.type === "utterance");
    expect(says.map((e) => e.text)).toEqual(["Hi Sam", "A real generated reply"]);
    expect(says[1]!.fallback).toBeUndefined();
    expect(seen.filter((e) => e.type === "facilitator.alert")).toEqual([]);
    expect(requests).toBe(3);
  });
  it("logs the retry once for the call, with no key, URL or message", async () => {
    await boot();
    await converse(runtime!);
    const lines = stderr.filter((l) => /retrying/.test(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^NPC model call: overloaded \(HTTP 503\), retrying in \d+ ms$/);
    expect(stderr.join("\n")).not.toMatch(new RegExp(`${KEY}|127\\.0\\.0\\.1|overloaded\\b.*temporarily`));
  });
  it("MODEL_MAX_RETRIES=0 disables retrying: the first 503 becomes the fallback line with the attempt count in the alert", async () => {
    await boot({ MODEL_MAX_RETRIES: "0" });
    const seen = await converse(runtime!);
    expect(requests).toBe(1);
    const alert = seen.find((e) => e.type === "facilitator.alert");
    expect(alert?.message).toMatch(/^NPC guest: model error after 1 attempt \(overloaded\): .*; used fallback line$/);
    expect(seen.filter((e) => e.type === "utterance").at(-1)?.fallback).toBe(true);
  });
  it("gives up after 1 + MODEL_MAX_RETRIES attempts", async () => {
    failFirst = 99;
    await boot({ MODEL_MAX_RETRIES: "1" });
    const seen = await converse(runtime!);
    expect(requests).toBe(2);
    expect(seen.find((e) => e.type === "facilitator.alert")?.message).toMatch(/after 2 attempts \(overloaded\)/);
  });
  it("real environment wins over <root>/.env for the retry variables", async () => {
    failFirst = 99;
    await writeFile(path.join(tmp, ".env"), "MODEL_MAX_RETRIES=1\n");
    const r = await boot({ MODEL_MAX_RETRIES: "3" });
    expect(r.ok).toBe(true);
    await converse(runtime!);
    expect(requests).toBe(4); // 1 + 3 (the .env value 1 would give 2)
  });
  it("a value that only the .env file sets is used", async () => {
    failFirst = 99;
    await writeFile(path.join(tmp, ".env"), "MODEL_MAX_RETRIES=1\n");
    const base = { ...env() } as Record<string, string>; delete base.MODEL_MAX_RETRIES;
    const r = await bootstrap({ env: base, root: tmp, logDir: tmp, tickMs: 60_000, log: () => {}, warn: () => {} });
    if (r.ok) runtime = r.runtime;
    expect(r.ok).toBe(true);
    await converse(runtime!);
    expect(requests).toBe(2);
  });
  it("Anthropic: only the wrapper retries (the SDK's own retries are off), so a 529 makes exactly 1 + MODEL_MAX_RETRIES requests", async () => {
    failFirst = 99;
    await boot({ MODEL_PROVIDER: "anthropic", ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: baseUrl.replace(/\/v1$/, ""), MODEL_MAX_RETRIES: "1" });
    const seen = await converse(runtime!);
    expect(requests).toBe(2);
    expect(seen.find((e) => e.type === "facilitator.alert")?.message).toMatch(/after 2 attempts \(overloaded\)/);
  });

  const bad: [string, Record<string, string>, RegExp][] = [
    ["negative retries", { MODEL_MAX_RETRIES: "-1" }, /MODEL_MAX_RETRIES.*0 to 5/],
    ["too many retries", { MODEL_MAX_RETRIES: "6" }, /MODEL_MAX_RETRIES.*0 to 5/],
    ["decimal retries", { MODEL_MAX_RETRIES: "1.5" }, /MODEL_MAX_RETRIES/],
    ["base below the minimum", { MODEL_RETRY_BASE_MS: "99" }, /MODEL_RETRY_BASE_MS.*100 to 10000/],
    ["base above the maximum", { MODEL_RETRY_BASE_MS: "10001" }, /MODEL_RETRY_BASE_MS.*100 to 10000/],
    ["unit suffix", { MODEL_RETRY_BASE_MS: "500ms" }, /MODEL_RETRY_BASE_MS/],
  ];
  it.each(bad)("refuses to start on %s, naming the variable and range and starting nothing", async (_n, extra, re) => {
    const r = await boot(extra);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join("\n")).toMatch(re);
    expect(r.errors.join("\n")).not.toContain(KEY);
    expect(requests).toBe(0);
  });
  it("sanitizes a hostile value", async () => {
    const r = await boot({ MODEL_MAX_RETRIES: "9".repeat(200) + "\u001b[2J\nSECRET" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).not.toMatch(/SECRET|\u001b/);
  });
  it("leaves the mock provider unwrapped (offline runs are unchanged)", async () => {
    const r = await boot({ MODEL_PROVIDER: "mock" });
    expect(r.ok).toBe(true);
    const host = runtime!.host as unknown as { gm: { provider: unknown } };
    expect(host.gm.provider).not.toBeInstanceOf(RetryingModelProvider);
  });
});
