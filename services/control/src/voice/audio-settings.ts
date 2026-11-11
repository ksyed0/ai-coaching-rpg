import path from "node:path";

export const DEFAULT_AUDIO_MIN_FREE_MB = 2048;
export const AUDIO_MIN_FREE_RANGE = [512, 1_000_000] as const;
export const DEFAULT_AUDIO_MAX_RETENTION_DAYS = 30;
export const AUDIO_RETENTION_RANGE = [1, 30] as const;

/**
 * US-0073: the audio store's settings. `AUDIO_DIR` is absolute (default `<dataDir>/audio`, the rule of voice-ops/src/settings.ts), the
 * free-space floor is 512 to 1 000 000 MB and retention 1 to 30 days. Every error names the variable only and never echoes a value.
 */
export function parseAudioSettings(env: NodeJS.ProcessEnv, dataDir: string): { ok: true; audioDir: string; minFreeMb: number; maxRetentionDays: number } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const get = (name: string): string | undefined => { const v = env[name]; return v === undefined || v === "" ? undefined : v; };
  const whole = (name: string, dflt: number, [lo, hi]: readonly [number, number]): number => {
    const raw = get(name);
    if (raw === undefined) return dflt;
    const n = /^[0-9]{1,10}$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isSafeInteger(n) || n < lo || n > hi) { errors.push(`${name} must be a whole number from ${lo} to ${hi}`); return dflt; }
    return n;
  };
  const minFreeMb = whole("AUDIO_MIN_FREE_MB", DEFAULT_AUDIO_MIN_FREE_MB, AUDIO_MIN_FREE_RANGE);
  const maxRetentionDays = whole("AUDIO_MAX_RETENTION_DAYS", DEFAULT_AUDIO_MAX_RETENTION_DAYS, AUDIO_RETENTION_RANGE);
  let audioDir = path.join(dataDir, "audio");
  const raw = get("AUDIO_DIR");
  if (raw !== undefined) {
    if (raw.includes("\0") || !path.isAbsolute(raw)) errors.push("AUDIO_DIR must be an absolute path");
    else audioDir = path.resolve(raw);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, audioDir, minFreeMb, maxRetentionDays };
}
