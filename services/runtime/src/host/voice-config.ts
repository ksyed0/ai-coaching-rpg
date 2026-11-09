import { parseRetryEnv } from "../agents/retry-config.js";
import { noticeNamesVoice } from "./limits.js";

/**
 * US-0070 (EPIC-0003 voice A1a): the runtime's voice settings. Voice is off unless VOICE_ENABLED=1, and with 1 the runtime refuses to
 * start unless it was forked by the control service (CONTROL_MANAGED=1: the speech worker is control's child and its lines arrive over the
 * parent channel only) and the consent notice describes voice recording (v3 or later). TURN_END_MS is how long the host waits, from a
 * voice turn's last speech frame, before the NPC round runs.
 */
export type VoiceConfig = { enabled: false } | { enabled: true; turnEndMs: number };
export type VoiceConfigParse = ({ ok: true } & VoiceConfig) | { ok: false; errors: string[] };

export const DEFAULT_TURN_END_MS = 800;
export const MIN_TURN_END_MS = 300;
export const MAX_TURN_END_MS = 3000;
export const VOICE_NEEDS_MANAGED = "VOICE_ENABLED=1 needs a session started by the control service (CONTROL_MANAGED=1)";
export const VOICE_NEEDS_NOTICE_V3 = "VOICE_ENABLED=1 needs a consent notice that describes voice recording (CONSENT_NOTICE_VERSION v3 or later)";
/** Fixed sentences: an error names the variable and the rule, never the value it was given (no environment-derived string is echoed). */
const VOICE_ENABLED_RULE = "VOICE_ENABLED is invalid: use 0 or 1";
const TURN_END_MS_RULE = `TURN_END_MS is invalid: use a whole number of milliseconds from ${MIN_TURN_END_MS} to ${MAX_TURN_END_MS}`;

/**
 * Reads VOICE_ENABLED (exactly 0 or 1, default 0; anything else, "true" included, is refused) and, only with VOICE_ENABLED=1, TURN_END_MS
 * (300..3000, default 800). F6 (review fix wave): TURN_END_MS reaches every control-managed runtime, so it is not read while voice is off;
 * a stray value cannot stop a text-only session from starting.
 */
export function parseVoiceConfig(env: NodeJS.ProcessEnv, o: { managed: boolean; noticeVersion: string }): VoiceConfigParse {
  const enabled = parseRetryEnv({ name: "VOICE_ENABLED", min: 0, max: 1, fallback: 0 }, env.VOICE_ENABLED);
  if (!enabled.ok) return { ok: false, errors: [VOICE_ENABLED_RULE] };
  if (enabled.value === 0) return { ok: true, enabled: false };
  const turnEnd = parseRetryEnv({ name: "TURN_END_MS", min: MIN_TURN_END_MS, max: MAX_TURN_END_MS, fallback: DEFAULT_TURN_END_MS }, env.TURN_END_MS);
  if (!turnEnd.ok) return { ok: false, errors: [TURN_END_MS_RULE] };
  if (!o.managed) return { ok: false, errors: [VOICE_NEEDS_MANAGED] };
  if (!noticeNamesVoice(o.noticeVersion)) return { ok: false, errors: [VOICE_NEEDS_NOTICE_V3] };
  return { ok: true, enabled: true, turnEndMs: turnEnd.value };
}
