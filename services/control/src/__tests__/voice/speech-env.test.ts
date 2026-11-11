import { describe, expect, it } from "vitest";
import { CHILD_ENV_ALLOWLIST } from "../../child-env.js";
import { SPEECH_ENV_ALLOWLIST, buildSpeechEnv, isAllowedSpeechVar } from "../../voice/speech-env.js";

const parent: NodeJS.ProcessEnv = {
  PATH: "/usr/bin", NODE_OPTIONS: "--max-old-space-size=512", VOICE_HANGOVER_MS: "450", VOICE_MAX_SEGMENT_MS: "3000",
  STT_URL: "http://127.0.0.1:9123/abc", STT_MODEL: "small.en", STT_PROVIDER: "whisper", STT_FAKE_SCRIPT: "/x/s.json", SPEECH_INGEST: "file",
  SPEECH_INGEST_DIR: "/x/in", STT_COLD_TIMEOUT_MS: "20000", STT_IDLE_COLD_MS: "60000",
  // never copied:
  LIVEKIT_API_SECRET: "s1", LIVEKIT_API_KEY: "k1", LIVEKIT_HOST: "http://127.0.0.1:7880", RUST_LOG: "trace", LIVEKIT_DEBUG_LOG_ROOM_EVENTS: "1", ANTHROPIC_API_KEY: "sk-ant", OPENROUTER_API_KEY: "or", LOCAL_API_KEY: "l", LAUNCHER_TOKEN: "lt",
  FACILITATOR_SECRET: "fs", HOME: "/home/x", VOICE_ENABLED: "1", TURN_END_MS: "800", CONSENT_NOTICE_VERSION: "v3", SPEECH_INGEST_ROLES: "evil", MODEL_PROVIDER: "mock",
};

describe("the speech worker's environment (US-0070)", () => {
  it("copies only the allowlisted names and NODE_*", () => {
    const env = buildSpeechEnv(parent, ["tech_lead", "pm"]);
    expect(Object.keys(env).sort()).toEqual([
      "NODE_OPTIONS", "PATH", "SPEECH_INGEST", "SPEECH_INGEST_DIR", "SPEECH_INGEST_ROLES", "STT_COLD_TIMEOUT_MS", "STT_FAKE_SCRIPT", "STT_IDLE_COLD_MS",
      "STT_MODEL", "STT_PROVIDER", "STT_URL", "VOICE_HANGOVER_MS", "VOICE_MAX_SEGMENT_MS",
    ]);
  });

  it("US-0073 (R10): AUDIO_DIR, AUDIO_MIN_FREE_MB, SPEECH_LOG_IDENTITY and SPEECH_SESSIONS_DIR come from `extra` only, never the parent", () => {
    const id = "0123456789abcdef0123456789abcdef";
    const p = { ...parent, AUDIO_DIR: "/inherited", AUDIO_MIN_FREE_MB: "999", AUDIO_MAX_RETENTION_DAYS: "5", SPEECH_LOG_IDENTITY: "evil", SPEECH_SESSIONS_DIR: "/evil" };
    const env = buildSpeechEnv(p, ["pm"], { logIdentity: id, sessionsDir: "/s", audioDir: "/cfg/audio", minFreeMb: 1024 });
    expect(env).toMatchObject({ AUDIO_DIR: "/cfg/audio", AUDIO_MIN_FREE_MB: "1024", SPEECH_LOG_IDENTITY: id, SPEECH_SESSIONS_DIR: "/s" });
    expect(env).not.toHaveProperty("AUDIO_MAX_RETENTION_DAYS");
    // no AUDIO_DIR in the parent: the config's value still reaches the worker (the documented default records)
    expect(buildSpeechEnv(parent, ["pm"], { logIdentity: id, sessionsDir: "/s", audioDir: "/cfg/audio", minFreeMb: 2048 })).toMatchObject({ AUDIO_DIR: "/cfg/audio", AUDIO_MIN_FREE_MB: "2048" });
    // no identity: none of the audio variables, inherited or not
    const none = buildSpeechEnv(p, ["pm"]);
    for (const k of ["SPEECH_LOG_IDENTITY", "SPEECH_SESSIONS_DIR", "AUDIO_DIR", "AUDIO_MIN_FREE_MB"]) expect(none, k).not.toHaveProperty(k);
    for (const k of ["SPEECH_LOG_IDENTITY", "SPEECH_SESSIONS_DIR", "AUDIO_DIR", "AUDIO_MIN_FREE_MB"]) expect(isAllowedSpeechVar(k), k).toBe(false);
  });

  it("LIVEKIT_*, provider keys, LAUNCHER_TOKEN, FACILITATOR_SECRET and HOME are never copied", () => {
    const env = buildSpeechEnv(parent, []);
    // US-0071 (R26): LIVEKIT_HOST, RUST_LOG (rtc-node's native log filter) and LIVEKIT_DEBUG_LOG_ROOM_EVENTS (rtc-node prints every room
    // event, identities included) stay out too.
    for (const k of ["LIVEKIT_API_SECRET", "LIVEKIT_API_KEY", "LIVEKIT_HOST", "RUST_LOG", "LIVEKIT_DEBUG_LOG_ROOM_EVENTS", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "LOCAL_API_KEY", "LAUNCHER_TOKEN", "FACILITATOR_SECRET", "HOME", "VOICE_ENABLED", "MODEL_PROVIDER"]) {
      expect(env, k).not.toHaveProperty(k);
    }
    expect(JSON.stringify(env)).not.toMatch(/sk-ant|"s1"|"lt"|"fs"/);
  });

  it("SPEECH_INGEST_ROLES is set from the roles, never from the parent", () => {
    expect(buildSpeechEnv(parent, ["tech_lead", "pm"]).SPEECH_INGEST_ROLES).toBe("tech_lead,pm");
    expect(buildSpeechEnv(parent, []).SPEECH_INGEST_ROLES).toBe("");
  });

  it("the worker's settings never reach a runtime, and the runtime's voice settings never reach the worker", () => {
    for (const n of SPEECH_ENV_ALLOWLIST.names) if (n !== "PATH") expect(CHILD_ENV_ALLOWLIST.names as readonly string[], n).not.toContain(n);
    expect(SPEECH_ENV_ALLOWLIST.names as readonly string[]).not.toContain("VOICE_ENABLED");
    expect(SPEECH_ENV_ALLOWLIST.prefixes).toEqual(["NODE_"]);
  });
});
