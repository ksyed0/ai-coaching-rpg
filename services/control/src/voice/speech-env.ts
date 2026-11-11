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

/**
 * The worker's environment: the allowlisted names of `parentEnv`, plus SPEECH_INGEST_ROLES set from `roles`, and (US-0073)
 * SPEECH_LOG_IDENTITY, SPEECH_SESSIONS_DIR, AUDIO_DIR and AUDIO_MIN_FREE_MB set from `extra` only, never from the parent. Ruling R10:
 * the audio settings come from control's parsed config (so the default `<dataDir>/audio` that control audits and sweeps is the one the
 * worker records into) and are set only together with a log identity: without one the worker gets none of them and records no audio.
 */
export function buildSpeechEnv(
  parentEnv: NodeJS.ProcessEnv, roles: readonly string[],
  extra: { logIdentity?: string; sessionsDir?: string; audioDir?: string; minFreeMb?: number } = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(parentEnv)) if (v !== undefined && isAllowedSpeechVar(k)) env[k] = v;
  env.SPEECH_INGEST_ROLES = roles.join(",");
  if (extra.logIdentity === undefined) return env;
  env.SPEECH_LOG_IDENTITY = extra.logIdentity;
  if (extra.sessionsDir !== undefined) env.SPEECH_SESSIONS_DIR = extra.sessionsDir;
  if (extra.audioDir !== undefined) env.AUDIO_DIR = extra.audioDir;
  if (extra.minFreeMb !== undefined) env.AUDIO_MIN_FREE_MB = String(extra.minFreeMb);
  return env;
}
