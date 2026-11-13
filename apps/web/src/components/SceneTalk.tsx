"use client";

import type { PlayerView } from "@acr/events";
import type { ActionResult } from "../lib/api";
import { isAiSpeaker, speakerName, waitingForYou, type ActivityMap } from "../lib/activity";
import { roleLabel } from "../lib/names";
import { SayBox, type AddressCandidateUi } from "./SayBox";
import { ThinkingLines } from "./ThinkingLines";
import { WaitingForYou } from "./WaitingForYou";

// US-0082: what sits under the transcript while a scene is played: who is composing a reply, "Waiting for you" when an AI line was
// addressed to this player, and the say box with its @ list of the other roles of the current scene.

export type SceneTalkProps = {
  selfRole: string; view: PlayerView; activity: ActivityMap; names: Record<string, string>; playerRoles: ReadonlySet<string>;
  disabledReason: string | null; onSay: (text: string, to?: string) => Promise<ActionResult>;
};

export function SceneTalk({ selfRole, view, activity, names, playerRoles, disabledReason, onSay }: SceneTalkProps) {
  const aiRoles = new Set(view.aiRoles);
  const who = { selfRole, names, aiRoles };
  const label = (roleId: string) => ({ name: speakerName(roleId, who), ai: isAiSpeaker(roleId, aiRoles, playerRoles) });
  const waiting = waitingForYou(view, { selfRole, aiRoles, playerRoles });
  const candidates: AddressCandidateUi[] = (view.scene?.participants ?? []).filter((r) => r !== selfRole).map((r) => ({
    roleId: r, label: roleLabel(r),
    detail: aiRoles.has(r) ? "AI player" : !playerRoles.has(r) ? "AI character" : Object.hasOwn(names, r) ? names[r]! : "Player",
  }));
  return (
    <>
      <ThinkingLines activity={activity} label={label} />
      <WaitingForYou by={waiting ? speakerName(waiting.roleId, who) : null} />
      <SayBox disabledReason={disabledReason} onSay={onSay} candidates={candidates} />
    </>
  );
}
