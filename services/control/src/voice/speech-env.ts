/**
 * US-0070 (EPIC-0003 voice A1a): what the speech worker may inherit from the control service's environment. Nothing else is copied: no
 * HOME, no LAUNCHER_TOKEN or FACILITATOR_SECRET, no model-provider keys and never a LIVEKIT_* secret (from A1b the worker gets its own
 * LiveKit token over IPC, never through its environment). The runtime's settings (VOICE_ENABLED, TURN_END_MS) are not the worker's.
 */
export const SPEECH_ENV_ALLOWLIST = {
  names: [
    "PATH", "VOICE_HANGOVER_MS", "VOICE_MAX_SEGMENT_MS", "STT_URL", "STT_MODEL", "STT_PROVIDER", "STT_FAKE_SCRIPT", "STT_COLD_TIMEOUT_MS",
    "STT_IDLE_COLD_MS", "SPEECH_INGEST", "SPEECH_INGEST_DIR",
  ],
  prefixes: ["NODE_"],
} as const;

export function isAllowedSpeechVar(name: string): boolean {
  return (SPEECH_ENV_ALLOWLIST.names as readonly string[]).includes(name) || SPEECH_ENV_ALLOWLIST.prefixes.some((p) => name.startsWith(p));
}

/** The worker's environment: the allowlisted names of `parentEnv`, plus SPEECH_INGEST_ROLES set from `roles` (never from the parent). */
export function buildSpeechEnv(parentEnv: NodeJS.ProcessEnv, roles: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(parentEnv)) if (v !== undefined && isAllowedSpeechVar(k)) env[k] = v;
  env.SPEECH_INGEST_ROLES = roles.join(",");
  return env;
}
