import { parseTimeoutEnv, gmDeadlineMs } from "./timeouts.js";
import { parseRetryEnv } from "./retry-config.js";

/** The Game Master judges each gm_detects condition after this many NEW utterances in a scene (GM_EVERY_N_UTTERANCES). */
export const DEFAULT_GM_EVERY_N_UTTERANCES = 3;
export const MIN_GM_EVERY_N = 1;
export const MAX_GM_EVERY_N = 20;

/**
 * US-0019, GM_TRANSCRIPT_WINDOW: the least number of the current scene's latest utterances a Game Master prompt holds, instead of the whole
 * scene. Generous on purpose: the shipped showcase scenes run 6 to 12 lines (mock) and about 10 to 25 live, so the window only cuts a scene that
 * runs long, where the cost of every evaluation would otherwise keep growing. Never smaller than GM_EVERY_N_UTTERANCES. What is guaranteed (see
 * GameMaster.windowFor and selectGmLines): each prompt of a condition also holds every line that arrived since the last answered prompt of that
 * condition, up to MAX_GM_TRANSCRIPT_WINDOW (beyond it the facilitator gets an alert with the number left out), plus the scene's first 2 lines and
 * each AI character's last 2 lines; left-out runs are marked {"omitted": n} in place. It is not guaranteed that a line older than the window
 * stays in view: a player's line that later lines push out is gone for the next prompts (docs/THREAT_MODEL.md, US-0019).
 */
export const DEFAULT_GM_TRANSCRIPT_WINDOW = 40;
export const MIN_GM_TRANSCRIPT_WINDOW = 10;
export const MAX_GM_TRANSCRIPT_WINDOW = 500;

export type GmConfig = { timeoutMs: number; reask: boolean; everyNUtterances: number;
  /** US-0034, GM_AUTO_RELEASE: the Game Master releases a hidden fact itself when it judges its earned_when condition true. Off (suggest only) unless set. */
  autoRelease?: boolean;
  /** US-0019, GM_TRANSCRIPT_WINDOW: how many of the scene's latest utterances a Game Master prompt holds (default DEFAULT_GM_TRANSCRIPT_WINDOW). */
  transcriptWindow?: number };
export type GmConfigParse = ({ ok: true } & GmConfig) | { ok: false; errors: string[] };

/**
 * Reads GM_TIMEOUT_MS (500..600000 ms; unset keeps max(NPC_REPLY_TIMEOUT_MS, 60 s), the deadline of one Game Master call with its
 * retries and re-ask), GM_REASK (0 or 1, default 1: one re-ask after a reply with no usable verdict) and GM_EVERY_N_UTTERANCES
 * (1..20, default 3), GM_AUTO_RELEASE (0 or 1, default 0: the Game Master only suggests a hidden-fact release; 1 lets it release the fact itself) and
 * GM_TRANSCRIPT_WINDOW (10..500 utterances, default 40, and at least GM_EVERY_N_UTTERANCES).
 * Errors name the variable, never a value beyond a short quote of the bad input.
 */
export function parseGmConfig(env: NodeJS.ProcessEnv, replyTimeoutMs: number): GmConfigParse {
  const timeout = parseTimeoutEnv("GM_TIMEOUT_MS", env.GM_TIMEOUT_MS, gmDeadlineMs(replyTimeoutMs));
  const reask = parseRetryEnv({ name: "GM_REASK", min: 0, max: 1, fallback: 1 }, env.GM_REASK);
  const every = parseRetryEnv({ name: "GM_EVERY_N_UTTERANCES", min: MIN_GM_EVERY_N, max: MAX_GM_EVERY_N, fallback: DEFAULT_GM_EVERY_N_UTTERANCES }, env.GM_EVERY_N_UTTERANCES);
  const auto = parseRetryEnv({ name: "GM_AUTO_RELEASE", min: 0, max: 1, fallback: 0 }, env.GM_AUTO_RELEASE);
  const window = parseRetryEnv({ name: "GM_TRANSCRIPT_WINDOW", min: MIN_GM_TRANSCRIPT_WINDOW, max: MAX_GM_TRANSCRIPT_WINDOW, fallback: DEFAULT_GM_TRANSCRIPT_WINDOW }, env.GM_TRANSCRIPT_WINDOW);
  const errors = [timeout, reask, every, auto, window].flatMap((r) => (r.ok ? [] : [r.error]));
  if (!timeout.ok || !reask.ok || !every.ok || !auto.ok || !window.ok) return { ok: false, errors };
  if (window.value < every.value) return { ok: false, errors: ["GM_TRANSCRIPT_WINDOW must be at least GM_EVERY_N_UTTERANCES: a smaller window would skip lines between two evaluations"] };
  return { ok: true, timeoutMs: timeout.value, reask: reask.value === 1, everyNUtterances: every.value, autoRelease: auto.value === 1, transcriptWindow: window.value };
}
