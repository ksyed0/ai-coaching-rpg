import type { ModelProvider } from "@acr/adapters";
import type { NpcRole, Scenario } from "@acr/script";
import { collectModelReply } from "../agents/model-reply.js";
import type { SpeakerName } from "../agents/npc-reply.js";
import { MAX_LINE_CHARS, cleanPlayerReply } from "./clean.js";
import { buildLiveRequest, roleLabel, type PlayerView } from "./prompt.js";
import type { AiPlayerSettings } from "./settings.js";
import type { Trigger } from "./turn-policy.js";

export type LiveSkipReason = "model_failed" | "timeout" | "unusable";
export type LiveLine = { ok: true; text: string; cut: boolean } | { ok: false; reason: LiveSkipReason };

/**
 * Makes the live AI player speak one line. One model call, raced against `settings.hardTimeoutMs` (the provider is aborted when it
 * loses). Never throws and never returns a canned line: when the model fails, times out or says nothing usable, the caller skips the turn.
 */
export async function generateLiveLine(o: {
  provider: ModelProvider; scenario: Scenario; view: PlayerView; trigger: Trigger; hint?: string | null; settings: AiPlayerSettings; signal?: AbortSignal;
  /** US-0081: the human seat a nudge addresses. */
  target?: string | null;
}): Promise<LiveLine> {
  const { settings, view } = o;
  const ac = new AbortController();
  const onOuter = (): void => ac.abort();
  if (o.signal?.aborted) return { ok: false, reason: "model_failed" };
  o.signal?.addEventListener("abort", onOuter, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const req = buildLiveRequest({ view, trigger: o.trigger, hint: o.hint, target: o.target, maxTokens: settings.maxTokens, temperature: settings.temperature });
    const hard = new Promise<"hard">((r) => { timer = setTimeout(() => r("hard"), settings.hardTimeoutMs); });
    const got = await Promise.race([
      collectModelReply(o.provider, req, { firstTokenTimeoutMs: settings.firstTokenTimeoutMs, replyTimeoutMs: settings.replyTimeoutMs, signal: ac.signal }),
      hard,
    ]);
    if (got === "hard") { ac.abort(); return { ok: false, reason: "timeout" }; }
    if (got.failure) return { ok: false, reason: /timeout|deadline/i.test(got.failure) ? "timeout" : "model_failed" };
    const self: SpeakerName = { id: view.roleId, name: roleLabel(view.roleId) };
    const others: SpeakerName[] = Object.values(o.scenario.roles).filter((r) => r.id !== view.roleId)
      .map((r) => ({ id: r.id, name: r.type === "npc" ? (r as NpcRole).name : roleLabel(r.id) }));
    const cleaned = cleanPlayerReply(got.text, self, others);
    if (!/[\p{L}\p{N}]/u.test(cleaned.text) || cleaned.text.length > MAX_LINE_CHARS) return { ok: false, reason: "unusable" };
    return { ok: true, text: cleaned.text, cut: cleaned.cut };
  } catch {
    return { ok: false, reason: "model_failed" };
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", onOuter);
  }
}
