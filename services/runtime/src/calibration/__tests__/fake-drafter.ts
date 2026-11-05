import type { ChatRequest, ModelProvider } from "@acr/adapters";
import { modelFamily, type Judge } from "../judge.js";

/** What a scripted drafter does for one call: reply with this text, throw this error, or hang until the call is aborted. */
export type Script = string | Error | "hang";

export type ScriptedDrafter = ModelProvider & { calls: ChatRequest[] };

/** The criterion id and target level a draft request asks for (read from the user message). */
export function targetOf(req: ChatRequest): { criterion: string; level: number } {
  const m = /criterion ([a-z0-9_-]+) at level (\d)/.exec(req.messages.map((x) => x.content).join("\n"));
  return { criterion: m?.[1] ?? "", level: Number(m?.[2] ?? 0) };
}

/** A drafter that answers each call from `script` (given the request and the 0-based call number). Never reaches a network. */
export function scriptedDrafter(script: (req: ChatRequest, i: number) => Script): ScriptedDrafter {
  const calls: ChatRequest[] = [];
  return {
    name: "scripted-drafter", calls,
    async *stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<string> {
      calls.push(req);
      const s = script(req, calls.length - 1);
      if (s instanceof Error) throw s;
      if (s === "hang") {
        await new Promise<never>((_, reject) => {
          if (signal?.aborted) reject(new Error("aborted"));
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
        return;
      }
      yield s;
    },
  };
}

/** A transcript reply on the Friday scenario: the delivery lead and the client sponsor on the client call. */
export const fridayReply = (subjectText = "We can look at that together."): string => JSON.stringify({
  transcript: [
    { scene: "s2_client_call", role: "client_sponsor", text: "We need the reconciliation module before go-live." },
    { scene: "s2_client_call", role: "delivery_lead", text: subjectText },
    { scene: "s2_client_call", role: "client_sponsor", text: "Can you confirm that today?" },
    { scene: "s2_client_call", role: "delivery_lead", text: "Let me check with the team first." },
  ],
});

export const drafterJudge = (p: ModelProvider, model = "qwen3-30b-a3b", label = "drafter"): Judge => ({ label, model, family: modelFamily(model), provider: p });
