import { describe, expect, it, vi } from "vitest";
import { DEMO_USAGE, parseDemoArgs } from "../args.js";
import { runDemo, spawnVoiceDemo, type RunDeps } from "../runner.js";
// US-0070: --voice only hands over to the control service's voice demo (`pnpm --filter @acr/control demo:voice`): the voice path needs
// control (the relay and the speech worker), and the runtime package never imports control. Like --web (web-flag.test.ts).
vi.setConfig({ testTimeout: 60_000 });

const capture = () => {
  const out: string[] = []; const err: string[] = [];
  return { out, err, stdout: { write: (s: string) => { out.push(s); }, isTTY: false }, stderr: { write: (s: string) => { err.push(s); }, isTTY: false } };
};
const deps = (argv: string[], over: Partial<RunDeps> = {}) => {
  const c = capture();
  const d: RunDeps = { argv, stdout: c.stdout, stderr: c.stderr, env: { PATH: "/usr/bin" }, sleep: async () => {}, version: "0.0.0-test", resolveLiveEnv: () => { throw new Error("not here"); }, ...over };
  return { c, d };
};

describe("parseDemoArgs --voice", () => {
  it("--voice parses, alone or with --no-color", () => {
    expect(parseDemoArgs(["--voice"])).toMatchObject({ ok: true, opts: { voice: true, noColor: false } });
    expect(parseDemoArgs(["--voice", "--no-color"])).toMatchObject({ ok: true, opts: { voice: true, noColor: true } });
  });
  it("a run without --voice has no voice key at all", () => {
    const r = parseDemoArgs(["--fast"]);
    expect(r.ok && "voice" in r.opts).toBe(false);
  });
  it.each([["--fast"], ["--web"], ["--live"], ["--security"], ["--resume"], ["--showcase"], ["--json", "-"], ["--url", "ws://127.0.0.1:1"], ["--session", "s1"], ["--speed", "2"]])("--voice with %s is refused with the fixed sentence", (...extra) => {
    expect(parseDemoArgs(["--voice", ...extra])).toEqual({ ok: false, error: "error: --voice runs on its own (only --no-color may go with it): it starts the control service's voice demo", usage: DEMO_USAGE });
  });
  it("refuses a duplicated --voice", () => {
    expect(parseDemoArgs(["--voice", "--voice"])).toMatchObject({ ok: false, error: "error: --voice was given more than once" });
  });
  it("is in the usage text", () => {
    expect(DEMO_USAGE).toMatch(/--voice +.*V-01 to V-08/);
  });
});

describe("pnpm demo --voice", () => {
  it("--voice hands over and returns the child's exit code; nothing of the runtime demo runs", async () => {
    const spawnVoice = vi.fn(async () => 0);
    const { c, d } = deps(["--voice"], { spawnVoice });
    expect(await runDemo(d)).toEqual({ exitCode: 0 });
    expect(spawnVoice).toHaveBeenCalledTimes(1);
    expect(c.out.join("")).not.toContain("F-01");
    expect(await runDemo(deps(["--voice"], { spawnVoice: async () => 1 }).d)).toEqual({ exitCode: 1 });
  });
  it("passes --no-color on as NO_COLOR and keeps the rest of the environment", async () => {
    const spawnVoice = vi.fn(async (_o: { env: NodeJS.ProcessEnv }) => 0);
    await runDemo(deps(["--voice", "--no-color"], { spawnVoice, env: { PATH: "/usr/bin", KEEP: "1" } }).d);
    expect(spawnVoice.mock.calls[0]![0].env).toMatchObject({ PATH: "/usr/bin", KEEP: "1", NO_COLOR: "1" });
  });
  it("a spawner that throws is exit 1 with one line, not a crash", async () => {
    const { c, d } = deps(["--voice"], { spawnVoice: async () => { throw new Error("spawn pnpm ENOENT"); } });
    expect(await runDemo(d)).toEqual({ exitCode: 1 });
    expect(c.err.join("")).toBe("error: could not start the voice demo (pnpm --filter @acr/control demo:voice): spawn pnpm ENOENT\n");
  });
  it("defaults to pnpm --filter @acr/control demo:voice, run like the web demo's command", async () => {
    expect(spawnVoiceDemo.defaultCommand).toEqual(["pnpm", ["--filter", "@acr/control", "demo:voice"]]);
    expect(await spawnVoiceDemo({ cwd: process.cwd(), env: { ...process.env, VOICE_DEMO_PROBE: "5" }, command: [process.execPath, ["-e", "process.exit(Number(process.env.VOICE_DEMO_PROBE))"]] })).toBe(5);
  });
});
