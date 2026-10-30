import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runtimeCommand, runtimeCwd } from "../runtime-command.js";

const DEADLINE_MS = 5_000;

function within<T>(p: Promise<T>, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), DEADLINE_MS);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

describe("fork spike", () => {
  it("a forked tsx child exchanges one IPC message with the parent and the child exits when the parent disconnects", async () => {
    const { execPath, execArgv } = runtimeCommand();
    const fixture = fileURLToPath(new URL("./fixtures/echo-child.ts", import.meta.url));
    const child = fork(fixture, [], { execPath, execArgv, cwd: runtimeCwd(), stdio: ["ignore", "inherit", "inherit", "ipc"] });
    try {
      const reply = within(new Promise<unknown>((r) => child.once("message", r)), "pong");
      const exited = within(new Promise<number | null>((r) => child.once("exit", (code) => r(code))), "child exit");
      await within(new Promise<void>((r, j) => child.once("spawn", () => r()).once("error", j)), "spawn");
      child.send({ type: "ping" });
      expect(await reply).toEqual({ type: "pong" });
      child.disconnect();
      expect(await exited).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });
});
