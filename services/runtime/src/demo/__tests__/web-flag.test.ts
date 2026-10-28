import { describe, expect, it, vi } from "vitest";
import { DEMO_USAGE, parseDemoArgs } from "../args.js";
import { runDemo, spawnWebDemo, type RunDeps } from "../runner.js";
// The --web flag only hands over to the web package's demo (apps/web, `pnpm --filter @acr/web demo`): the runtime package never imports
// from apps/web. Real-process test below: a generous explicit limit; nothing measures elapsed time.
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

describe("parseDemoArgs --web", () => {
  it("sets web and leaves every other default as it was", () => {
    expect(parseDemoArgs(["--web"])).toEqual({ ok: true, opts: { fast: false, speed: 1, json: undefined, live: false, url: undefined, session: undefined, noColor: false, help: false, showcase: undefined, scenario: undefined, maxLines: undefined, maxFallbacks: undefined, watchdog: undefined, transcript: undefined, players: undefined, playerModel: undefined, noIntents: undefined, evaluate: undefined, evalOut: undefined, gmTrace: undefined, minGmExits: undefined, maxFalseExits: undefined, web: true } });
    expect(parseDemoArgs(["--web", "--no-color"])).toMatchObject({ ok: true, opts: { web: true, noColor: true } });
  });
  it("a run without --web has no web key at all", () => {
    const r = parseDemoArgs(["--fast"]);
    expect(r.ok && "web" in r.opts).toBe(false);
  });
  it.each([["--fast"], ["--live"], ["--security"], ["--resume"], ["--showcase"], ["--json", "-"], ["--url", "ws://127.0.0.1:1"], ["--session", "s1"], ["--transcript", "t.md"], ["--speed", "2"]])("refuses --web with %s", (...extra) => {
    expect(parseDemoArgs(["--web", ...extra])).toEqual({ ok: false, error: "error: --web runs on its own (only --no-color may go with it): it starts the web stack's own demo", usage: DEMO_USAGE });
  });
  it("refuses a duplicated --web", () => {
    expect(parseDemoArgs(["--web", "--web"])).toMatchObject({ ok: false, error: "error: --web was given more than once" });
  });
  it("is in the usage text", () => {
    expect(DEMO_USAGE).toMatch(/--web +.*W-01 to W-08/);
  });
});

describe("pnpm demo --web", () => {
  it("hands over to the web demo and returns its exit code; nothing of the runtime demo runs", async () => {
    const spawnWeb = vi.fn(async () => 0);
    const { c, d } = deps(["--web"], { spawnWeb });
    expect(await runDemo(d)).toEqual({ exitCode: 0 });
    expect(spawnWeb).toHaveBeenCalledTimes(1);
    expect(c.out.join("")).not.toContain("F-01");
    const failing = deps(["--web", "--no-color"], { spawnWeb: async () => 1 });
    expect(await runDemo(failing.d)).toEqual({ exitCode: 1 });
  });
  it("passes --no-color on as NO_COLOR and keeps the rest of the environment", async () => {
    const spawnWeb = vi.fn(async (_o: { env: NodeJS.ProcessEnv }) => 0);
    await runDemo(deps(["--web", "--no-color"], { spawnWeb, env: { PATH: "/usr/bin", KEEP: "1" } }).d);
    expect(spawnWeb.mock.calls[0]![0].env).toMatchObject({ PATH: "/usr/bin", KEEP: "1", NO_COLOR: "1" });
    await runDemo(deps(["--web"], { spawnWeb, env: { PATH: "/usr/bin" } }).d);
    expect(spawnWeb.mock.calls[1]![0].env.NO_COLOR).toBeUndefined();
  });
  it("a spawner that throws is exit 1 with one line, not a crash", async () => {
    const { c, d } = deps(["--web"], { spawnWeb: async () => { throw new Error("spawn pnpm ENOENT"); } });
    expect(await runDemo(d)).toEqual({ exitCode: 1 });
    expect(c.err.join("")).toBe("error: could not start the web demo (pnpm --filter @acr/web demo): spawn pnpm ENOENT\n");
  });
});

describe("spawnWebDemo (the real process)", () => {
  it("runs the command in the repo root with the given environment and resolves with its exit code", async () => {
    const code = await spawnWebDemo({ cwd: process.cwd(), env: { ...process.env, WEB_DEMO_PROBE: "7" }, command: [process.execPath, ["-e", "process.exit(Number(process.env.WEB_DEMO_PROBE))"]] });
    expect(code).toBe(7);
  });
  it("a child killed by a signal is exit 1", async () => {
    const code = await spawnWebDemo({ cwd: process.cwd(), env: process.env, command: [process.execPath, ["-e", "process.kill(process.pid, 'SIGKILL')"]] });
    expect(code).toBe(1);
  });
  it("a command that cannot start rejects", async () => {
    await expect(spawnWebDemo({ cwd: process.cwd(), env: process.env, command: ["/nonexistent/acr-no-such-binary", []] })).rejects.toThrow(/ENOENT/);
  });
  it("defaults to pnpm --filter @acr/web demo", () => {
    expect(spawnWebDemo.defaultCommand).toEqual(["pnpm", ["--filter", "@acr/web", "demo"]]);
  });
});
