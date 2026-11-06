import { loadLiveEnv } from "../demo/runner.js";

/**
 * The environment the evaluator runs with. The terminal merges the repo `.env` under the real environment; the control service
 * sets NO_DOTENV=1 (as for the session process) so a stray `.env` is never read. The flag is read from the REAL environment only.
 */
export function resolveEvaluatorEnv(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return env.NO_DOTENV === "1" ? { ...env } : loadLiveEnv(repoRoot, env);
}
