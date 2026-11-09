import path from "node:path";
import { DEFAULT_STT_COLD_TIMEOUT_MS, DEFAULT_STT_IDLE_COLD_MS, parseSttUrl } from "@acr/adapters";
import { isFileSafeId, isReservedRoleId, isSafeId, isScenarioId } from "@acr/events";
import { MAX_HOLDERS } from "./protocol.js";
import { DEFAULT_SEGMENTER, HANGOVER_RANGE, MAX_SEGMENT_RANGE, type SegmenterSettings } from "./segmenter.js";

export type WorkerConfig = {
  segmenter: SegmenterSettings;
  stt: { kind: "whisper"; url: URL; coldTimeoutMs: number; idleColdMs: number } | { kind: "fake"; scriptFile: string };
  /** US-0071: `livekit` listens to the seat rooms (control sends a token per connect); `roles` still names the session's player roles. */
  ingest: { kind: "file"; dir: string; roles: string[] } | { kind: "livekit"; roles: string[] };
};

const COLD_RANGE = [1000, 300_000] as const;
/** US-0071 (R25): STT_MODEL is 1 to 64 characters, every `.`-separated part a safe id ("small.en", "large-v3-turbo-q5_0"). */
export const MAX_STT_MODEL_CHARS = 64;
const isModelName = (v: string): boolean => v.length >= 1 && v.length <= MAX_STT_MODEL_CHARS && v.split(".").every((part) => isSafeId(part));
const IDLE_RANGE = [1000, 86_400_000] as const;

/**
 * US-0070: the speech worker's settings, from the environment control gives it (an allowlist, services/control/src/voice/speech-env.ts).
 * Every error names the variable only and never echoes a value (CodeQL js/clear-text-logging). US-0071 adds the LiveKit ingest.
 */
export function parseWorkerConfig(env: NodeJS.ProcessEnv): { ok: true; cfg: WorkerConfig } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const whole = (name: string, [lo, hi]: readonly [number, number], dflt: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return dflt;
    const n = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(n) || n < lo || n > hi) { errors.push(`${name} must be a whole number from ${lo} to ${hi}`); return dflt; }
    return n;
  };
  const hangoverMs = whole("VOICE_HANGOVER_MS", HANGOVER_RANGE, DEFAULT_SEGMENTER.hangoverMs);
  const maxSegmentMs = whole("VOICE_MAX_SEGMENT_MS", MAX_SEGMENT_RANGE, DEFAULT_SEGMENTER.maxSegmentMs);
  const coldTimeoutMs = whole("STT_COLD_TIMEOUT_MS", COLD_RANGE, DEFAULT_STT_COLD_TIMEOUT_MS);
  const idleColdMs = whole("STT_IDLE_COLD_MS", IDLE_RANGE, DEFAULT_STT_IDLE_COLD_MS);

  let stt: WorkerConfig["stt"] | undefined;
  const provider = env.STT_PROVIDER ?? "whisper";
  if (provider === "whisper") {
    const u = parseSttUrl(env.STT_URL);
    if (u.ok) stt = { kind: "whisper", url: u.url, coldTimeoutMs, idleColdMs };
    else errors.push(u.error);
  } else if (provider === "fake") {
    const f = env.STT_FAKE_SCRIPT;
    if (f && path.isAbsolute(f)) stt = { kind: "fake", scriptFile: f };
    else errors.push("STT_FAKE_SCRIPT must be the absolute path of the fake script when STT_PROVIDER=fake");
  } else errors.push("STT_PROVIDER must be whisper or fake");

  // US-0071 (R25): checked so a typo fails at start; what the model name selects is slice A1c (`pnpm voice:up`).
  const model = env.STT_MODEL;
  if (model !== undefined && model !== "" && !isModelName(model)) errors.push(`STT_MODEL must be 1 to ${MAX_STT_MODEL_CHARS} characters, dot-separated parts of letters, digits, _ or -`);

  const ingestKind = env.SPEECH_INGEST ?? "file";
  if (ingestKind !== "file" && ingestKind !== "livekit") errors.push("SPEECH_INGEST must be file or livekit");
  const dir = env.SPEECH_INGEST_DIR;
  // A LiveKit ingest reads no file: control sends a token per seat room over IPC.
  if (ingestKind === "file" && (!dir || !path.isAbsolute(dir))) errors.push("SPEECH_INGEST_DIR must be an absolute directory");
  const rawRoles = env.SPEECH_INGEST_ROLES ?? "";
  const roles = rawRoles === "" ? [] : rawRoles.split(",");
  const roleOk = (r: string): boolean => isFileSafeId(r) && isScenarioId(r) && !isReservedRoleId(r);
  if (roles.length > MAX_HOLDERS || !roles.every(roleOk) || new Set(roles).size !== roles.length) errors.push("SPEECH_INGEST_ROLES must be a comma-separated list of distinct role ids");

  if (errors.length > 0 || !stt) return { ok: false, errors };
  const ingest: WorkerConfig["ingest"] = ingestKind === "livekit" ? { kind: "livekit", roles } : { kind: "file", dir: dir!, roles };
  return { ok: true, cfg: { segmenter: { ...DEFAULT_SEGMENTER, hangoverMs, maxSegmentMs }, stt, ingest } };
}
