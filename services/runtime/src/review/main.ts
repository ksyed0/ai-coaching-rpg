import { REPO_ROOT } from "../main.js";
import { loadLiveEnv } from "../demo/runner.js";
import { runModerate } from "./cli.js";

// Thin entry point (`pnpm moderate`): everything testable lives in cli.ts.
const env = loadLiveEnv(REPO_ROOT, process.env);
const { exitCode } = await runModerate({
  argv: process.argv.slice(2),
  stdout: process.stdout,
  stderr: process.stderr,
  env,
});
process.exitCode = exitCode;
