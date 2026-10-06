import { REPO_ROOT } from "../main.js";
import { loadLiveEnv } from "../demo/runner.js";
import { runGmEval } from "./cli.js";

// Thin entry point (`pnpm gm-eval`): everything testable lives in cli.ts.
const live = process.argv.includes("--live");
const env = live ? loadLiveEnv(REPO_ROOT, process.env) : process.env; // the .env (API keys) is read only for --live
const { exitCode } = await runGmEval({ argv: process.argv.slice(2), stdout: process.stdout, stderr: process.stderr, env, repoRoot: REPO_ROOT });
process.exitCode = exitCode;
setTimeout(() => process.exit(exitCode), 3_000).unref();
