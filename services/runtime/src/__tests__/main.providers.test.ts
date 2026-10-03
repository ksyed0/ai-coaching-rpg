import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrap, type Runtime } from "../main.js";

const KEY = "sk-TEST-NEVER-LOG-12345";
const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../packages/script/src/__tests__/fixtures/minimal");
let tmp: string; let runtime: Runtime | null = null; let server: http.Server; let localUrl: string; let localHost: string;
let captured: string[];

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "acr-prov-"));
  server = http.createServer((_req, res) => res.end("{}"));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  localHost = `127.0.0.1:${port}`;
  localUrl = `http://${localHost}/v1/private-path`;
  captured = [];
  const sink = (...a: unknown[]) => { captured.push(a.map(String).join(" ")); };
  for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation(sink);
  vi.spyOn(process.stdout, "write").mockImplementation(((c: unknown) => { captured.push(String(c)); return true; }) as never);
  vi.spyOn(process.stderr, "write").mockImplementation(((c: unknown) => { captured.push(String(c)); return true; }) as never);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await runtime?.stop(); runtime = null;
  await new Promise((r) => server.close(r));
  await rm(tmp, { recursive: true, force: true });
});

const base = () => ({ SCENARIO_DIR: fixture, RUNTIME_PORT: "0", SESSION_ID: "p1" });
async function boot(env: Record<string, string>) {
  const logs: string[] = [];
  const r = await bootstrap({ env: { ...base(), ...env }, root: tmp, logDir: tmp, tickMs: 1_000, log: (m) => logs.push(m), warn: (m) => logs.push(m) });
  if (r.ok) runtime = r.runtime;
  return { r, logs, all: () => [...logs, ...captured].join("\n") };
}

describe("bootstrap with each provider kind", () => {
  const cases: [string, () => Record<string, string>, () => string][] = [
    ["mock", () => ({ MODEL_PROVIDER: "mock", ANTHROPIC_API_KEY: KEY, OPENROUTER_API_KEY: KEY, LOCAL_API_KEY: KEY }), () => "model provider: mock"],
    ["anthropic", () => ({ MODEL_PROVIDER: "anthropic", ANTHROPIC_API_KEY: KEY }), () => "model provider: Anthropic (custom endpoint: no)"],
    ["anthropic with a base URL", () => ({ MODEL_PROVIDER: "anthropic", ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: localUrl }), () => "model provider: Anthropic (custom endpoint: yes)"],
    ["openrouter", () => ({ MODEL_PROVIDER: "openrouter", OPENROUTER_API_KEY: KEY, OPENROUTER_BASE_URL: localUrl }), () => "model provider: OpenRouter (custom endpoint: yes)"],
    ["local", () => ({ MODEL_PROVIDER: "local", LOCAL_BASE_URL: localUrl, LOCAL_API_KEY: KEY, NPC_MODEL: "llama3.1", GM_MODEL: "qwen2.5" }), () => "model provider: local OpenAI-compatible server (custom endpoint: yes)"],
  ];
  for (const [label, env, expected] of cases) {
    it(`${label}: starts, logs a fixed label only, and never the key, host or URL path`, async () => {
      const { r, logs, all } = await boot(env());
      if (!r.ok) throw new Error(r.errors.join("; "));
      expect(logs).toContain(expected());
      expect(all()).not.toContain(KEY);
      expect(all()).not.toContain("private-path");
      expect(all()).not.toContain("127.0.0.1");
      expect(all()).not.toContain("scenario dir");
    });
  }

  it("local without a key starts too (key is optional)", async () => {
    const { r } = await boot({ MODEL_PROVIDER: "local", LOCAL_BASE_URL: localUrl, NPC_MODEL: "m", GM_MODEL: "m" });
    expect(r.ok).toBe(true);
  });

  const failures: [string, Record<string, string>, RegExp][] = [
    ["anthropic without a key", { MODEL_PROVIDER: "anthropic", OPENROUTER_API_KEY: KEY }, /ANTHROPIC_API_KEY/],
    ["openrouter without a key", { MODEL_PROVIDER: "openrouter", ANTHROPIC_API_KEY: KEY }, /OPENROUTER_API_KEY/],
    ["local without a base URL", { MODEL_PROVIDER: "local", LOCAL_API_KEY: KEY, NPC_MODEL: "m", GM_MODEL: "m" }, /LOCAL_BASE_URL/],
    ["local without NPC_MODEL", { MODEL_PROVIDER: "local", LOCAL_BASE_URL: "http://localhost:1/v1", LOCAL_API_KEY: KEY, GM_MODEL: "m" }, /NPC_MODEL/],
    ["local with userinfo carrying the key", { MODEL_PROVIDER: "local", LOCAL_BASE_URL: `http://user:${KEY}@localhost:1/v1`, NPC_MODEL: "m", GM_MODEL: "m" }, /LOCAL_BASE_URL.*credentials/],
    ["openrouter over plain http to a remote host", { MODEL_PROVIDER: "openrouter", OPENROUTER_API_KEY: KEY, OPENROUTER_BASE_URL: `http://example.com/v1?k=${KEY}` }, /OPENROUTER_BASE_URL/],
    ["anthropic with a bad base URL", { MODEL_PROVIDER: "anthropic", ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: `://${KEY}` }, /ANTHROPIC_BASE_URL/],
    ["unknown provider", { MODEL_PROVIDER: "gpt-5", ANTHROPIC_API_KEY: KEY }, /unknown MODEL_PROVIDER/],
  ];
  for (const [label, env, re] of failures) {
    it(`fails clearly and leaks nothing: ${label}`, async () => {
      const { r, all } = await boot(env);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.errors.join("\n")).toMatch(re);
      expect(r.errors.join("\n")).not.toContain(KEY);
      expect(all()).not.toContain(KEY);
    });
  }
});

describe("bootstrap NPC timeouts", () => {
  const timeoutsOf = (rt: Runtime) => [...(rt.host as unknown as { npcs: Map<string, { timeouts: { firstTokenMs: number; replyMs: number } }> }).npcs.values()].map((a) => a.timeouts);

  it("defaults to 10 s / 20 s", async () => {
    const { r } = await boot({});
    expect(r.ok).toBe(true);
    const t = timeoutsOf(runtime!);
    expect(t.length).toBeGreaterThan(0);
    for (const x of t) expect(x).toEqual({ firstTokenMs: 10_000, replyMs: 20_000 });
  });
  it("applies the environment overrides to every NPC", async () => {
    const { r } = await boot({ NPC_FIRST_TOKEN_TIMEOUT_MS: " 3000 ", NPC_REPLY_TIMEOUT_MS: "9000" });
    expect(r.ok).toBe(true);
    for (const x of timeoutsOf(runtime!)) expect(x).toEqual({ firstTokenMs: 3000, replyMs: 9000 });
  });
  it("treats an empty value as the default", async () => {
    const { r } = await boot({ NPC_FIRST_TOKEN_TIMEOUT_MS: "  ", NPC_REPLY_TIMEOUT_MS: "" });
    expect(r.ok).toBe(true);
    for (const x of timeoutsOf(runtime!)) expect(x).toEqual({ firstTokenMs: 10_000, replyMs: 20_000 });
  });
  it("real environment wins over <root>/.env", async () => {
    await writeFile(path.join(tmp, ".env"), "NPC_FIRST_TOKEN_TIMEOUT_MS=4000\nNPC_REPLY_TIMEOUT_MS=8000\n");
    const { r } = await boot({ NPC_FIRST_TOKEN_TIMEOUT_MS: "6000" });
    expect(r.ok).toBe(true);
    for (const x of timeoutsOf(runtime!)) expect(x).toEqual({ firstTokenMs: 6000, replyMs: 8000 });
  });

  const bad: [string, Record<string, string>, string][] = [
    ["exponent", { NPC_FIRST_TOKEN_TIMEOUT_MS: "1e3" }, "NPC_FIRST_TOKEN_TIMEOUT_MS"],
    ["unit suffix", { NPC_FIRST_TOKEN_TIMEOUT_MS: "10s" }, "NPC_FIRST_TOKEN_TIMEOUT_MS"],
    ["hex", { NPC_REPLY_TIMEOUT_MS: "0x10" }, "NPC_REPLY_TIMEOUT_MS"],
    ["negative", { NPC_REPLY_TIMEOUT_MS: "-5" }, "NPC_REPLY_TIMEOUT_MS"],
    ["decimal", { NPC_FIRST_TOKEN_TIMEOUT_MS: "1000.5" }, "NPC_FIRST_TOKEN_TIMEOUT_MS"],
    ["below minimum", { NPC_FIRST_TOKEN_TIMEOUT_MS: "499" }, "NPC_FIRST_TOKEN_TIMEOUT_MS"],
    ["above maximum", { NPC_REPLY_TIMEOUT_MS: "600001" }, "NPC_REPLY_TIMEOUT_MS"],
    ["reply below first token", { NPC_FIRST_TOKEN_TIMEOUT_MS: "5000", NPC_REPLY_TIMEOUT_MS: "4999" }, "NPC_REPLY_TIMEOUT_MS"],
    ["raised first token over default reply", { NPC_FIRST_TOKEN_TIMEOUT_MS: "30000" }, "NPC_REPLY_TIMEOUT_MS"],
  ];
  it.each(bad)("refuses to start on %s and names the variable without leaking anything else", async (_n, env, name) => {
    const { r, all } = await boot({ ...env, MODEL_PROVIDER: "anthropic", ANTHROPIC_API_KEY: KEY });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join("\n")).toContain(name);
    expect(r.errors.join("\n")).toMatch(/500/);
    expect(r.errors.join("\n")).not.toMatch(/\n\s+at /);
    expect(all()).not.toContain(KEY);
    expect(all()).not.toContain("model provider:"); // nothing was started or logged
  });
  it("sanitizes and truncates a hostile value", async () => {
    const { r } = await boot({ NPC_FIRST_TOKEN_TIMEOUT_MS: "9".repeat(300) + "\u001b[2J" });
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.errors[0]!.length).toBeLessThan(250); expect(r.errors[0]).not.toContain("\u001b"); }
  });
});
