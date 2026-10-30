import { fork } from "node:child_process";
import { closeSync, fchmodSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import type { ChildMessage } from "./protocol.js";
import { runtimeCommand, runtimeCwd } from "./runtime-command.js";
import type { ChildHandle, SpawnFn } from "./supervisor.js";

const noop = (): void => {};

/**
 * The real SpawnFn: forks the runtime (`runtimeCommand()`, in `runtimeCwd()`) with EXACTLY the environment it is given (no copy of this
 * process's environment: `buildChildEnv` is the allowlist), stdout and stderr appended to `logFile` (mode 0600, in a 0700 directory)
 * and one two-way IPC channel. The parent's copy of the log descriptor is closed as soon as the fork is done.
 *
 * `command` exists for tests (a fixture child, a bad `execPath`); the service always uses the default.
 */
export function forkSpawn(command: ReturnType<typeof runtimeCommand> = runtimeCommand()): SpawnFn {
  return ({ env, logFile }) => {
    mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
    const fd = openSync(logFile, "a", 0o600);
    let child;
    try {
      fchmodSync(fd, 0o600); // the mode argument only applies to a new file
      child = fork(command.entry, [], {
        execPath: command.execPath, execArgv: command.execArgv, cwd: runtimeCwd(), env, stdio: ["ignore", fd, fd, "ipc"],
      });
    } finally {
      closeSync(fd); // the child holds its own copy
    }

    const exitFns: ((code: number | null) => void)[] = [];
    const exited: { done: boolean; code: number | null } = { done: false, code: null };
    const finish = (code: number | null): void => {
      if (exited.done) return;
      exited.done = true;
      exited.code = code;
      for (const fn of exitFns) fn(code);
    };
    child.on("exit", (code) => finish(code));
    // A failed spawn (bad execPath, EAGAIN) emits 'error' and never 'exit'; without a listener it would crash the service. Any other
    // 'error' (a failed kill or send) leaves the process running, so it is not an exit.
    child.on("error", () => { if (child.pid === undefined) finish(null); });

    const handle: ChildHandle & { readonly pid: number | undefined } = {
      /** For tests and diagnostics; the supervisor does not use it. */
      get pid() { return child.pid; },
      send(m) {
        if (exited.done || !child.connected) return false;
        try { return child.send(m, noop); } catch { return false; }
      },
      onMessage(fn: (m: ChildMessage) => void) { child.on("message", (m) => fn(m as ChildMessage)); },
      onExit(fn) {
        if (exited.done) fn(exited.code);
        else exitFns.push(fn);
      },
      kill() { try { child.kill("SIGTERM"); } catch { /* already gone */ } },
      forceKill() { try { child.kill("SIGKILL"); } catch { /* already gone */ } },
      disconnect() { try { if (child.connected) child.disconnect(); } catch { /* channel already closed */ } },
    };
    return handle;
  };
}
