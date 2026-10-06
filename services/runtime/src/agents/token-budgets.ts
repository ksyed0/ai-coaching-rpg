import { parseRetryEnv } from "./retry-config.js";

/**
 * The model's max_tokens for one AI character reply and one Game Master verdict (NPC_MAX_TOKENS, GM_MAX_TOKENS). A reasoning
 * model spends part of this on thinking before it answers, so the old fixed 300 / 200 could end in an empty reply.
 */
export const DEFAULT_NPC_MAX_TOKENS = 600;
export const DEFAULT_GM_MAX_TOKENS = 400;
export const MIN_TOKENS_LIMIT = 50;
export const MAX_TOKENS_LIMIT = 4000;

export type TokenBudgetsParse = { ok: true; npcMaxTokens: number; gmMaxTokens: number } | { ok: false; errors: string[] };

/** Reads NPC_MAX_TOKENS and GM_MAX_TOKENS: whole numbers 50..4000, digits only; unset or blank gives the default. */
export function parseTokenBudgets(env: NodeJS.ProcessEnv): TokenBudgetsParse {
  const npc = parseRetryEnv({ name: "NPC_MAX_TOKENS", min: MIN_TOKENS_LIMIT, max: MAX_TOKENS_LIMIT, fallback: DEFAULT_NPC_MAX_TOKENS }, env.NPC_MAX_TOKENS);
  const gm = parseRetryEnv({ name: "GM_MAX_TOKENS", min: MIN_TOKENS_LIMIT, max: MAX_TOKENS_LIMIT, fallback: DEFAULT_GM_MAX_TOKENS }, env.GM_MAX_TOKENS);
  if (!npc.ok || !gm.ok) return { ok: false, errors: [npc, gm].flatMap((r) => (r.ok ? [] : [r.error])) };
  return { ok: true, npcMaxTokens: npc.value, gmMaxTokens: gm.value };
}
