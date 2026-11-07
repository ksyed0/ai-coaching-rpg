import { spawn } from "node:child_process";
import path from "node:path";
import type { Readable } from "node:stream";
import { isAllowedChildVar } from "./child-env.js";
import { REPO_ROOT, type ControlConfig } from "./config.js";

/** One evaluate child: its output streams, a signal and its end (after its streams have closed, so stdout is complete). */
export type EvalChild = {
  stdout: Readable;
  stderr: Readable;
  kill(sig: NodeJS.Signals): void;
  onExit(cb: (code: number | null, signal: string | null) => void): void;
};
/** `argv[0]` is the program; the rest are its arguments. */
export type EvalSpawnFn = (o: { argv: string[]; cwd: string; env: NodeJS.ProcessEnv }) => EvalChild;

/** The evaluate CLI's entry point (`pnpm evaluate`), absolute. */
export const EVALUATOR_ENTRY = path.join(REPO_ROOT, "services", "runtime", "src", "evaluator", "main.ts");

/**
 * The evaluate child's environment: only what `isAllowedChildVar` lets a runtime child inherit (the model settings and keys go to the
 * child only), never `NODE_OPTIONS` (it would let the parent's environment load code into the child), plus `NO_DOTENV=1` so the repo
 * `.env` is never read. Nothing of the control service's own (LAUNCHER_TOKEN, FACILITATOR_SECRET, HOME, INIT_CWD) is copied.
 */
export function buildEvalChildEnv(parentEnv: NodeJS.ProcessEnv, _config: ControlConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(parentEnv)) {
    if (v === undefined || k === "NODE_OPTIONS" || !isAllowedChildVar(k)) continue;
    env[k] = v;
  }
  env.NO_DOTENV = "1";
  return env;
}

/**
 * The real EvalSpawnFn: runs `argv` with EXACTLY the given environment (no copy of this process's), stdin closed, stdout and stderr
 * piped. `onExit` fires once, on 'close' (the streams are drained), or with `(null, null)` when the spawn itself failed.
 */
export const nodeEvalSpawn: EvalSpawnFn = ({ argv, cwd, env }) => {
  const [cmd, ...args] = argv;
  if (cmd === undefined) throw new Error("no program to run");
  const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const fns: ((code: number | null, signal: string | null) => void)[] = [];
  const done: { yes: boolean; code: number | null; signal: string | null } = { yes: false, code: null, signal: null };
  const finish = (code: number | null, signal: string | null): void => {
    if (done.yes) return;
    Object.assign(done, { yes: true, code, signal });
    for (const f of fns) f(code, signal);
  };
  child.on("close", (code, signal) => finish(code, signal));
  // A failed spawn emits 'error' and may never 'close'; any other 'error' (a failed kill) leaves the process running.
  child.on("error", () => { if (child.pid === undefined) finish(null, null); });
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    kill(sig) { try { child.kill(sig); } catch { /* already gone */ } },
    onExit(cb) { if (done.yes) cb(done.code, done.signal); else fns.push(cb); },
  };
};
