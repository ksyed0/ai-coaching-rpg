import { readVersion, runDemo } from "./runner.js";

// Thin entry point (`pnpm demo`): everything testable lives in runner.ts and its modules.
const { exitCode } = await runDemo({ argv: process.argv.slice(2), stdout: process.stdout, stderr: process.stderr, env: process.env, version: readVersion() });
process.exitCode = exitCode;
// Safety net: everything is closed by now, but never let a stray handle keep the process alive.
setTimeout(() => process.exit(exitCode), 3_000).unref();
