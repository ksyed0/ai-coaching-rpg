"use client";

import { useId, useState } from "react";
import { who } from "../../lib/console-confirm";
import type { Labeler } from "./Person";
import type { ConfirmRequest } from "./SessionControls";

// US-0059: a private message to one player. The select shows plain text (an option cannot hold markup); the dialog shows the message.

const WHISPER_MAX = 2000;

export type WhisperFormProps = {
  /** Role ids that may be whispered to: the current scene's players, else every player role. */
  recipients: string[];
  label: Labeler;
  disabled: boolean;
  pending?: boolean;
  onConfirm: (r: ConfirmRequest) => void;
};

export function WhisperForm({
  recipients,
  label,
  disabled,
  pending = false,
  onConfirm,
}: WhisperFormProps) {
  const id = useId();
  const [to, setTo] = useState("");
  const [text, setText] = useState("");
  const target = recipients.includes(to) ? to : (recipients[0] ?? "");
  const text_ = (r: string) => who(r, { names: label.names, ai: label.ai(r) });
  const empty = recipients.length === 0;
  const blank = text.trim() === "";

  return (
    <form
      className="stack"
      aria-labelledby={`${id}-h`}
      onSubmit={(e) => {
        e.preventDefault();
        if (pending || empty || blank) return;
        const btn = e.currentTarget.querySelector<HTMLElement>(
          "button[type=submit]",
        );
        if (!btn) return;
        onConfirm({
          subject: { kind: "whisper", recipient: text_(target) },
          command: { kind: "whisper", roleId: target, text },
          preview: text,
          opener: btn,
        });
      }}
    >
      <h3 className="s" id={`${id}-h`}>
        Whisper
      </h3>
      <label htmlFor={`${id}-to`}>To</label>
      <select
        id={`${id}-to`}
        className="t"
        value={target}
        disabled={disabled || empty}
        onChange={(e) => setTo(e.target.value)}
      >
        {recipients.map((r) => (
          <option key={r} value={r}>
            {text_(r)}
          </option>
        ))}
      </select>
      <label htmlFor={`${id}-m`}>Message</label>
      <textarea
        id={`${id}-m`}
        className="t"
        rows={3}
        maxLength={WHISPER_MAX}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
      />
      <div>
        <button
          type="submit"
          className="btn"
          disabled={disabled || empty || blank}
          aria-disabled={pending ? "true" : undefined}
        >
          Send whisper
        </button>
      </div>
    </form>
  );
}
