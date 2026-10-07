import { REPO_ROOT } from "../main.js";
import { loadLiveEnv } from "../demo/runner.js";
import { runCalibrate } from "./cli.js";

// Thin entry point (`pnpm calibrate`): everything testable lives in cli.ts. Ctrl-C stops the run; probes finished so far are written.
const ac = new AbortController();
process.once("SIGINT", () => ac.abort());
process.once("SIGTERM", () => ac.abort());
const env = loadLiveEnv(REPO_ROOT, process.env);
const { exitCode } = await runCalibrate({ argv: process.argv.slice(2), stdout: process.stdout, stderr: process.stderr, env, repoRoot: REPO_ROOT, signal: ac.signal });
process.exitCode = ac.signal.aborted ? 130 : exitCode;
setTimeout(() => process.exit(process.exitCode ?? 0), 3_000).unref();
