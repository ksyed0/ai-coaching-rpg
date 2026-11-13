/**
 * US-0082: how an addressed line ("@Role") changes one round of AI character replies. Pure.
 *
 * - The latest line of the current scene is addressed to an AI character of the round: that character answers FIRST (and must speak);
 *   the others follow in their usual order and keep their usual choice to stay silent.
 * - It is addressed to someone else (a human or an AI player): it is theirs to answer, so `elsewhere` is true: every character may stay
 *   silent and none is made to speak (the host also skips its "every AI character stayed silent" alert).
 * - Not addressed (or a line of another scene): the round is unchanged.
 */
export function addressedOrder(order: readonly string[], last: { to?: string; sceneId: string | null } | undefined, sceneId: string): { order: string[]; addressee: string | null; elsewhere: boolean } {
  const to = last && last.sceneId === sceneId && typeof last.to === "string" ? last.to : null;
  if (to === null) return { order: [...order], addressee: null, elsewhere: false };
  if (order.includes(to)) return { order: [to, ...order.filter((id) => id !== to)], addressee: to, elsewhere: false };
  return { order: [...order], addressee: null, elsewhere: true };
}
