"use client";

import { useEffect, useId } from "react";
import { REPORT_CONSOLE } from "../../../lib/messages";

// The name the facilitator types for the review record. Control appends `-console`, so the name must be a safe id of at most 56
// characters (the BFF and control check it again). It is never taken from the sign-in cookie. The typed name is kept in sessionStorage
// so a reload does not ask again; storage may be blocked or full, so every access is in try/catch and the field works without it.

const KEY = "scenecoach-console-author";
const RULE = /^[A-Za-z0-9_-]{1,56}$/;

/** True when `name` can be sent as the author (letters, digits, `_`, `-`, 1 to 56 characters). */
export const isAuthorName = (name: string): boolean => RULE.test(name);

/** The stored name when it passes the rule, else "". */
export function loadAuthorName(): string {
  try {
    const v = sessionStorage.getItem(KEY);
    return v !== null && isAuthorName(v) ? v : "";
  } catch {
    return "";
  }
}

function saveAuthorName(name: string): void {
  try {
    if (isAuthorName(name)) sessionStorage.setItem(KEY, name);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: the field still works */
  }
}

export type AuthorNameProps = { value: string; onChange: (name: string) => void };

export function AuthorName({ value, onChange }: AuthorNameProps) {
  const id = useId();
  // Once, after mount (never during a server render): a stored name fills an empty field.
  useEffect(() => {
    const stored = loadAuthorName();
    if (stored !== "" && value === "") onChange(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const bad = value !== "" && !isAuthorName(value);
  return (
    <div className="field">
      <label className="f" htmlFor={`${id}-name`}>
        {REPORT_CONSOLE.nameLabel}
      </label>
      <input
        id={`${id}-name`}
        className="t"
        type="text"
        autoComplete="off"
        spellCheck={false}
        value={value}
        aria-invalid={bad ? "true" : "false"}
        aria-describedby={bad ? `${id}-rule ${id}-err` : `${id}-rule`}
        onChange={(e) => {
          saveAuthorName(e.target.value);
          onChange(e.target.value);
        }}
      />
      <p className="hint muted" id={`${id}-rule`}>
        {REPORT_CONSOLE.nameRule}
      </p>
      {bad ? (
        <p className="err" id={`${id}-err`} role="alert">
          {`${REPORT_CONSOLE.nameBad} ${REPORT_CONSOLE.nameRule}`}
        </p>
      ) : null}
    </div>
  );
}
