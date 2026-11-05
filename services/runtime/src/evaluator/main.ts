import { REPO_ROOT } from "../main.js";
import { loadLiveEnv } from "../demo/runner.js";
import { runEvaluate } from "./cli.js";

// Thin entry point (`pnpm evaluate`): everything testable lives in cli.ts.
const ac = new AbortController();
process.once("SIGINT", () => ac.abort());
process.once("SIGTERM", () => ac.abort());
const env = loadLiveEnv(REPO_ROOT, process.env);
const { exitCode } = await runEvaluate({ argv: process.argv.slice(2), stdout: process.stdout, stderr: process.stderr, env, repoRoot: REPO_ROOT, signal: ac.signal });
process.exitCode = ac.signal.aborted ? 130 : exitCode;
setTimeout(() => process.exit(process.exitCode ?? 0), 3_000).unref();
