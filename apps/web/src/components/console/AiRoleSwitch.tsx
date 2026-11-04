"use client";

import { roleLabel } from "../../lib/names";

// US-0060: the per-role switch between a human and an AI player. It only asks: the parent opens the confirmation (with the button as the
// opener, so focus returns to it) and posts the change. `data-ai-switch` is how the parent finds this button again after a re-render.

export type AiRoleSwitchProps = {
  roleId: string;
  /** True when an AI player holds the seat now: the button offers the way back. */
  ai: boolean;
  /** The participant's name and whether anyone has joined: the parent builds the confirmation from them; unused here. */
  name?: string;
  joined: boolean;
  disabled: boolean;
  onAsk: (opener: HTMLElement) => void;
};

export function AiRoleSwitch({ roleId, ai, disabled, onAsk }: AiRoleSwitchProps) {
  const label = roleLabel(roleId);
  return (
    <button
      className="btn"
      type="button"
      disabled={disabled}
      data-ai-switch={roleId}
      aria-label={ai ? `Make ${label} human` : `Make ${label} an AI player`}
      onClick={(ev) => onAsk(ev.currentTarget)}
    >
      {ai ? "Make human" : "Make AI player"}
    </button>
  );
}
