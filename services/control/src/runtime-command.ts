import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The single place that says how to start services/runtime/src/main.ts. */
export function runtimeCommand(): { execPath: string; execArgv: string[]; entry: string } {
  return {
    execPath: process.execPath,
    execArgv: ["--import", "tsx"],
    entry: resolve(here, "../../runtime/src/main.ts"),
  };
}

/** Directory a child is forked in: `--import tsx` resolves from the cwd, and this package has tsx installed. */
export function runtimeCwd(): string {
  return resolve(here, "..");
}
