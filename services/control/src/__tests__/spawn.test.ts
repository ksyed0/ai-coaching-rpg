import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runtimeCommand } from "../runtime-command.js";
import { forkSpawn } from "../spawn.js";
import type { ChildHandle } from "../supervisor.js";

const fixture = fileURLToPath(new URL("./fixtures/spawn-child.ts", import.meta.url));
const command = { ...runtimeCommand(), entry: fixture };
const DEADLINE_MS = 20_000;

/** Polls until `fn` returns a truthy value or the deadline passes (never a fixed sleep). */
async function until<T>(what: string, fn: () => T | undefined | false): Promise<T> {
  const end = Date.now() + DEADLINE_MS;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

type Started = { child: ChildHandle; messages: unknown[]; exit: { code?: number | null; count: number } };
let dir: string;
const live: ChildHandle[] = [];

function start(env: NodeJS.ProcessEnv = {}, cmd = command, logFile = path.join(dir, "logs", "s.log")): Started {
  const child = forkSpawn(cmd)({ env, logFile });
  live.push(child);
  const s: Started = { child, messages: [], exit: { count: 0 } };
  child.onMessage((m) => s.messages.push(m));
  child.onExit((c) => { s.exit.code = c; s.exit.count++; });
  return s;
}

beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "acr-spawn-")); });
afterEach(() => {
  for (const c of live.splice(0)) { try { c.forceKill(); } catch { /* gone */ } }
  rmSync(dir, { recursive: true, force: true });
});

describe("forkSpawn", () => {
  it("round-trips messages and exits 0 when the parent disconnects", async () => {
    const s = start();
    await until("up", () => s.messages.some((m) => (m as { type?: string }).type === "up"));
    expect(s.child.send({ type: "ping" } as never)).toBe(true);
    await until("pong", () => s.messages.some((m) => (m as { type?: string }).type === "pong"));
    s.child.disconnect();
    await until("exit", () => s.exit.count > 0);
    expect(s.exit.code).toBe(0);
    expect(s.exit.count).toBe(1);
  });

  it("gives the child exactly the environment it was handed, nothing from the parent", async () => {
    process.env.PARENT_SECRET_FOR_TEST = "leak";
    try {
      const s = start({ FOO: "1" });
      await until("up", () => s.messages.length > 0);
      s.child.send({ type: "env" } as never);
      const reply = await until("env", () => s.messages.find((m) => (m as { type?: string }).type === "env")) as { env: Record<string, string> };
      expect(reply.env.FOO).toBe("1");
      expect(reply.env.PARENT_SECRET_FOR_TEST).toBeUndefined();
      expect(reply.env.HOME).toBeUndefined();
    } finally { delete process.env.PARENT_SECRET_FOR_TEST; }
  });

  it("kill sends SIGTERM and a child that ignores it is stopped by forceKill (SIGKILL)", async () => {
    const polite = start();
    await until("up", () => polite.messages.length > 0);
    polite.child.kill();
    await until("polite exit", () => polite.exit.count > 0);
    expect(polite.exit.code).toBeNull(); // a signal death reports a null code

    const stubborn = start({ IGNORE_TERM: "1" }, command, path.join(dir, "logs", "stubborn.log"));
    await until("up", () => stubborn.messages.length > 0);
    stubborn.child.kill();
    stubborn.child.send({ type: "ping" } as never);
    await until("still answering after SIGTERM", () => stubborn.messages.some((m) => (m as { type?: string }).type === "pong"));
    expect(stubborn.exit.count).toBe(0);
    stubborn.child.forceKill();
    await until("stubborn exit", () => stubborn.exit.count > 0);
    expect(stubborn.exit.code).toBeNull();
  });

  it("send returns false (and does not throw) once the channel is closed; disconnect twice is harmless", async () => {
    const s = start();
    await until("up", () => s.messages.length > 0);
    s.child.disconnect();
    expect(() => s.child.disconnect()).not.toThrow();
    expect(s.child.send({ type: "ping" } as never)).toBe(false);
    await until("exit", () => s.exit.count > 0);
    expect(() => s.child.kill()).not.toThrow();
    expect(() => s.child.forceKill()).not.toThrow();
    expect(s.child.send({ type: "ping" } as never)).toBe(false);
  });

  it("a failed spawn reports an exit with null, once, and never an unhandled error event", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => { unhandled.push(e); };
    process.on("uncaughtException", onUnhandled);
    try {
      const s = start({}, { ...command, execPath: path.join(dir, "no-such-node") });
      await until("exit", () => s.exit.count > 0);
      expect(s.exit.code).toBeNull();
      await new Promise((r) => setTimeout(r, 100)); // let any late event surface
      expect(s.exit.count).toBe(1);
      expect(unhandled).toEqual([]);
      expect(s.child.send({ type: "ping" } as never)).toBe(false);
    } finally { process.off("uncaughtException", onUnhandled); }
  });

  it("an exit listener added after the child has already exited is still called", async () => {
    const s = start({}, { ...command, execPath: path.join(dir, "no-such-node") });
    await until("exit", () => s.exit.count > 0);
    let late: number | null | undefined;
    s.child.onExit((c) => { late = c; });
    expect(late).toBeNull();
  });

  it("writes stdout to the log file (mode 0600) in a log directory created with mode 0700", async () => {
    const logFile = path.join(dir, "fresh", "logs", "s.log");
    const s = start({}, command, logFile);
    await until("up", () => s.messages.length > 0);
    await until("log line", () => readFileSync(logFile, "utf8").includes("child-log-line"));
    expect(statSync(logFile).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(logFile)).mode & 0o777).toBe(0o700);
    s.child.disconnect();
    await until("exit", () => s.exit.count > 0);
    // a second start appends rather than truncating
    const again = start({}, command, logFile);
    await until("up", () => again.messages.length > 0);
    again.child.disconnect();
    await until("exit", () => again.exit.count > 0);
    expect(readFileSync(logFile, "utf8").split("child-log-line").length - 1).toBe(2);
  });

  it("an existing log file with a loose mode is tightened to 0600", async () => {
    const logFile = path.join(dir, "logs", "loose.log");
    mkdirSync(path.dirname(logFile), { recursive: true });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(logFile, "old\n", { mode: 0o644 });
    const s = start({}, command, logFile);
    await until("up", () => s.messages.length > 0);
    expect(statSync(logFile).mode & 0o777).toBe(0o600);
    s.child.disconnect();
    await until("exit", () => s.exit.count > 0);
  });

  it("does not leak the parent's copy of the log file descriptor across 20 spawns", async () => {
    const fds = (): number => readdirSync("/dev/fd").length;
    const run = async (): Promise<void> => {
      const s = start({}, command, path.join(dir, "logs", "leak.log"));
      await until("up", () => s.messages.length > 0);
      s.child.disconnect();
      await until("exit", () => s.exit.count > 0);
    };
    await run(); // warm up lazy handles
    const before = fds();
    for (let i = 0; i < 20; i++) await run();
    expect(fds() - before).toBeLessThan(5); // a leaked log fd would add 20
  });
});
