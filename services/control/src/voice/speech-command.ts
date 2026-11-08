import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The single place that says how to start services/speech/src/main.ts (the runtime's twin: runtime-command.ts). */
export function speechCommand(): { execPath: string; execArgv: string[]; entry: string } {
  return { execPath: process.execPath, execArgv: ["--import", "tsx"], entry: resolve(here, "../../../speech/src/main.ts") };
}

/** Directory the worker is forked in: `--import tsx` and the worker's own imports resolve from the speech package. */
export function speechCwd(): string {
  return resolve(here, "../../../speech");
}
