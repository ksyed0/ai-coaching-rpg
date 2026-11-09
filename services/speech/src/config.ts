import path from "node:path";
import { DEFAULT_STT_COLD_TIMEOUT_MS, DEFAULT_STT_IDLE_COLD_MS, parseSttUrl } from "@acr/adapters";
import { isFileSafeId, isReservedRoleId, isScenarioId } from "@acr/events";
import { MAX_HOLDERS } from "./protocol.js";
import { DEFAULT_SEGMENTER, HANGOVER_RANGE, MAX_SEGMENT_RANGE, type SegmenterSettings } from "./segmenter.js";

export type WorkerConfig = {
  segmenter: SegmenterSettings;
  stt: { kind: "whisper"; url: URL; coldTimeoutMs: number; idleColdMs: number } | { kind: "fake"; scriptFile: string };
  ingest: { kind: "file"; dir: string; roles: string[] };
};

const COLD_RANGE = [1000, 300_000] as const;
const IDLE_RANGE = [1000, 86_400_000] as const;

/**
 * US-0070: the speech worker's settings, from the environment control gives it (an allowlist, services/control/src/voice/speech-env.ts).
 * Every error names the variable only and never echoes a value (CodeQL js/clear-text-logging). A1a supports file ingest only.
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

  if ((env.SPEECH_INGEST ?? "file") !== "file") errors.push("SPEECH_INGEST must be file (this build supports file ingest only)");
  const dir = env.SPEECH_INGEST_DIR;
  if (!dir || !path.isAbsolute(dir)) errors.push("SPEECH_INGEST_DIR must be an absolute directory");
  const rawRoles = env.SPEECH_INGEST_ROLES ?? "";
  const roles = rawRoles === "" ? [] : rawRoles.split(",");
  const roleOk = (r: string): boolean => isFileSafeId(r) && isScenarioId(r) && !isReservedRoleId(r);
  if (roles.length > MAX_HOLDERS || !roles.every(roleOk) || new Set(roles).size !== roles.length) errors.push("SPEECH_INGEST_ROLES must be a comma-separated list of distinct role ids");

  if (errors.length > 0 || !stt || !dir) return { ok: false, errors };
  return { ok: true, cfg: { segmenter: { ...DEFAULT_SEGMENTER, hangoverMs, maxSegmentMs }, stt, ingest: { kind: "file", dir, roles } } };
}
