import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrap, type Runtime } from "../main.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../packages/script/src/__tests__/fixtures/minimal");
let tmp: string; let runtime: Runtime | null = null;
afterEach(async () => { await runtime?.stop(); runtime = null; if (tmp) await rm(tmp, { recursive: true, force: true }); });

const boot = async (extra: Record<string, string> = {}) => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "acr-main-gm-"));
  const r = await bootstrap({ env: { SCENARIO_DIR: fixture, RUNTIME_PORT: "0", SESSION_ID: "g1", MODEL_PROVIDER: "mock", ...extra }, root: tmp, logDir: tmp, tickMs: 60_000, log: () => {}, warn: () => {} });
  if (r.ok) runtime = r.runtime;
  return r;
};
const gmOf = (rt: Runtime) => (rt.host as unknown as { gm: { everyN: number; reask: boolean; evaluationTimeoutMs: number } }).gm;

describe("bootstrap: Game Master settings (US-0025)", () => {
  it("defaults: every 3 utterances, one re-ask, a 60 s deadline (max of the NPC reply timeout and 60 s)", async () => {
    const r = await boot();
    expect(r.ok).toBe(true);
    expect(gmOf(runtime!)).toMatchObject({ everyN: 3, reask: true, evaluationTimeoutMs: 60_000 });
  });
  it("GM_TIMEOUT_MS, GM_REASK and GM_EVERY_N_UTTERANCES reach the Game Master", async () => {
    const r = await boot({ GM_TIMEOUT_MS: "15000", GM_REASK: "0", GM_EVERY_N_UTTERANCES: "2" });
    expect(r.ok).toBe(true);
    expect(gmOf(runtime!)).toMatchObject({ everyN: 2, reask: false, evaluationTimeoutMs: 15_000 });
  });
  it.each([["GM_TIMEOUT_MS", "100"], ["GM_REASK", "2"], ["GM_EVERY_N_UTTERANCES", "0"], ["GM_EVERY_N_UTTERANCES", "x"]])("refuses to start on %s=%s and names the variable", async (name, value) => {
    const r = await boot({ [name]: value });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join("\n")).toContain(name);
  });
  it("GM_TRACE_FILE records the raw replies in an owner-only file under the data directory (off by default)", async () => {
    const off = await boot();
    expect(off.ok).toBe(true);
    await runtime!.stop(); runtime = null; await rm(tmp, { recursive: true, force: true });
    const r = await boot({ GM_TRACE_FILE: "gm-trace.log", GM_EVERY_N_UTTERANCES: "1" });
    expect(r.ok).toBe(true);
    const file = path.join(tmp, "gm-trace.log");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const host = runtime!.host;
    host.join("host", "p1"); await host.start();
    await host.onPlayerUtterance("host", "hello"); await host.idle();
    // the mock model answers "[mock reply]": no verdict, asked twice
    const recs = (await readFile(file, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as { attempt: number; raw: string; parse: { ok: boolean; reason?: string } });
    expect(recs.map((x) => x.attempt)).toEqual([1, 2]);
    expect(recs[0]).toMatchObject({ raw: "[mock reply]", parse: { ok: false, reason: "no_json" } });
  });
  it("a GM_TRACE_FILE equal to the session log is refused", async () => {
    const r = await boot({ GM_TRACE_FILE: "g1.jsonl" }); // SESSION_ID g1 under the data directory
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/session log/);
  });
  it("any *.jsonl in the data directory is refused as a trace file (not only the current session's log)", async () => {
    const r = await boot({ GM_TRACE_FILE: "other-session.jsonl" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toMatch(/session log/);
  });
  it("a GM_TRACE_FILE that cannot be created refuses to start", async () => {
    const r = await boot({ GM_TRACE_FILE: "/proc/nope/trace.jsonl" });
    expect(r.ok).toBe(false);
  });
});
