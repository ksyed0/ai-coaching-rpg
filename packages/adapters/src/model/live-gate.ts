/** Live (real API) model tests are opt-in: they need both the flag and a key. */
export function liveTestsEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.RUN_LIVE_MODEL_TESTS === "1" && !!env.ANTHROPIC_API_KEY;
}
