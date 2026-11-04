import { isolate } from "./console-view";
import { roleLabel } from "./names";

// US-0059: the exact words of the facilitator console's confirmations. Values that came from outside (a scene title, an inject id, a
// participant's name) are isolated so a bidi control cannot reorder the text after it; `recipient`, `character` and `audience` arrive
// already built by `who`, which isolates the name.

export type ConfirmSubject =
  | { kind: "advance"; scene: string }
  | { kind: "end_now" }
  | {
      kind: "fire_inject";
      injectId: string;
      audience: string[];
      again: boolean;
    }
  | { kind: "whisper"; recipient: string }
  | { kind: "release_hidden"; fact: number; character: string }
  | { kind: "remove"; name?: string; role: string }
  | { kind: "to_ai"; role: string; name?: string; joined: boolean }
  | { kind: "to_human"; role: string };

export type ConfirmCopy = {
  title: string;
  description: string;
  confirmLabel: string;
  tone: "danger" | "primary";
};

const q = (v: string): string => `“${isolate(v)}”`;

/** What an inject with no listed role reads as: the plan has no word for it, and "everyone" would promise a wider audience than it has. */
export const NO_AUDIENCE = "no listed role";

/** "A", "A and B", "A, B and C". */
export function audienceText(labels: string[]): string {
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]!}`;
}

/** "Name (Role label)" for a seated player, "Role label" for an empty seat, "... (AI character)" for an AI character. */
export function who(
  roleId: string,
  o: { names: Record<string, string>; ai: boolean; aiPlayer?: boolean },
): string {
  const label = roleLabel(roleId);
  const name = o.aiPlayer ? undefined : o.names[roleId];
  const base = name ? `${isolate(name)} (${label})` : label;
  const marked = o.aiPlayer ? `${base} (AI player)` : base;
  return o.ai ? `${marked} (AI character)` : marked;
}

export function confirmCopy(s: ConfirmSubject): ConfirmCopy {
  switch (s.kind) {
    case "advance":
      return {
        title: `Move on from ${q(s.scene)}?`,
        description:
          "The scene ends for everyone in the room and the next scene begins. This cannot be undone.",
        confirmLabel: "Move on",
        tone: "danger",
      };
    case "end_now":
      return {
        title: "End the session now?",
        description:
          "The session ends for everyone in the room. Nobody can speak after this and the session cannot be restarted.",
        confirmLabel: "End session",
        tone: "danger",
      };
    case "fire_inject":
      return {
        title: `Fire inject ${q(s.injectId)}${s.again ? " again" : ""}?`,
        description: `It is shown to ${s.audience.length === 0 ? NO_AUDIENCE : audienceText(s.audience)}. It cannot be taken back.`,
        confirmLabel: "Fire inject",
        tone: "primary",
      };
    case "whisper":
      return {
        title: `Whisper to ${s.recipient}?`,
        description: `Only ${s.recipient} sees this message. It cannot be taken back.`,
        confirmLabel: "Send whisper",
        tone: "primary",
      };
    case "release_hidden":
      return {
        title: `Release fact ${s.fact} of ${s.character}?`,
        description: `${s.character} may now share this fact with everyone in the room. It cannot be taken back.`,
        confirmLabel: "Release fact",
        tone: "primary",
      };
    case "remove":
      return {
        title: s.name
          ? `Remove ${isolate(s.name)} from ${s.role}?`
          : `Remove the participant from ${s.role}?`,
        description: `They are signed out of the ${s.role} seat and their code stops working. A new code for the seat is shown once. This affects the ${s.role} role only.`,
        confirmLabel: "Remove",
        tone: "danger",
      };
    case "to_ai": {
      const keep = "An AI player takes the seat and its lines are marked AI. You can switch the role back to human until the start.";
      if (!s.joined)
        return {
          title: `Fill ${s.role} with an AI player?`,
          description: `The code for ${s.role} stops working. ${keep}`,
          confirmLabel: "Use AI player",
          tone: "primary",
        };
      return {
        title: s.name ? `Replace ${isolate(s.name)} with an AI player in ${s.role}?` : `Fill ${s.role} with an AI player?`,
        description: `They are signed out of the ${s.role} seat, their consent is withdrawn and their code stops working. ${keep}`,
        confirmLabel: "Use AI player",
        tone: "danger",
      };
    }
    case "to_human":
      return {
        title: `Switch ${s.role} back to a human?`,
        description: `The AI player leaves the ${s.role} seat. A new code for the seat is shown once: give it to the person who will play the role.`,
        confirmLabel: "Switch to human",
        tone: "primary",
      };
  }
}
