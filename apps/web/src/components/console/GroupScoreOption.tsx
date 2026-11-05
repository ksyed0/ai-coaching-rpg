"use client";

// US-0061: the facilitator's group-score option. A native checkbox with a visible label and a hint it is described by. It only reports
// the wish; the parent posts it, disables the box while the post is in flight and shows the value the server holds.

export const GROUP_SCORE_LABEL = "Include AI players in group scores";
export const GROUP_SCORE_HINT =
  "On: what the AI players say can count as team evidence in the group report, always marked AI. Off: their lines are context only. AI players never get an individual score. You can change this until the start.";

export type GroupScoreOptionProps = {
  id: string;
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
};

export function GroupScoreOption({ id, checked, disabled, onChange }: GroupScoreOptionProps) {
  return (
    <div className="stack">
      <label htmlFor={id}>
        <input
          type="checkbox"
          id={id}
          checked={checked}
          disabled={disabled}
          aria-describedby={`${id}-hint`}
          onChange={(ev) => onChange(ev.currentTarget.checked)}
        />{" "}
        {GROUP_SCORE_LABEL}
      </label>
      <p className="muted small" id={`${id}-hint`}>
        {GROUP_SCORE_HINT}
      </p>
    </div>
  );
}
