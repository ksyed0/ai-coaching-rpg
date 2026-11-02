"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ConsoleFactText } from "../../lib/console-commands";
import { isolate } from "../../lib/console-view";
import { roleLabel } from "../../lib/names";
import type { ConsoleCharacter } from "../../lib/use-console-stream";
import { Person, type Labeler } from "./Person";
import type { ConfirmRequest } from "./SessionControls";

// US-0059: the AI characters' goals, stance and hidden facts.
// Hidden-fact text (security): it comes only from `loadFacts()` after the facilitator opens a "Hidden facts" list, lives only in this
// component's state while a list is open, and is dropped when the last list closes, when `loadFacts` changes (a new channel) and on
// unmount. A fetch answered after any of those is ignored. Nothing is logged and no attribute carries the text.

export const GOALS_MAX = 10;
export const GOAL_MAX_CHARS = 500;
const GOALS_ERROR = `Enter 1 to ${GOALS_MAX} goals, one per line, each at most ${GOAL_MAX_CHARS} characters.`;

export type CharactersPanelProps = {
  characters: ConsoleCharacter[];
  /** state.factsEarned: fact numbers the Game Master has suggested, per role. */
  factsEarned: Record<string, number[]>;
  label: Labeler;
  disabled: boolean;
  pending?: boolean;
  onConfirm: (r: ConfirmRequest) => void;
  /** Resolves true once the stance was changed. */
  onStance: (roleId: string, goals: string[]) => Promise<boolean> | void;
  /** `fetchFacts` bound to the session and channel; null on failure. A new function means a new channel. */
  loadFacts: () => Promise<ConsoleFactText[] | null>;
};

type Facts = {
  phase: "idle" | "loading" | "ready" | "failed";
  roles: ConsoleFactText[];
};
const IDLE: Facts = { phase: "idle", roles: [] };

/** The goals typed in the box: non-empty trimmed lines; null when there are none, too many, or one is too long. */
export function parseGoals(raw: string): string[] | null {
  const goals = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  if (goals.length < 1 || goals.length > GOALS_MAX) return null;
  return goals.some((g) => g.length > GOAL_MAX_CHARS) ? null : goals;
}

export function CharactersPanel({
  characters,
  factsEarned,
  label,
  disabled,
  pending = false,
  onConfirm,
  onStance,
  loadFacts,
}: CharactersPanelProps) {
  const id = useId();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [facts, setFacts] = useState<Facts>(IDLE);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, boolean>>({});
  const openRef = useRef(new Set<string>());
  const gen = useRef(0); // bumped whenever fetched text must be dropped; a fetch answers only into the generation it started in
  const load = useRef(loadFacts);
  load.current = loadFacts;

  const dropAll = useCallback(() => {
    gen.current += 1;
    openRef.current = new Set();
    setOpen(new Set());
    setFacts(IDLE);
  }, []);

  // A new channel (loadFacts changes) or unmount: close every list, drop the text, make any fetch in flight stale.
  useEffect(() => dropAll, [loadFacts, dropAll]);

  // A character that left the list takes its open list with it; when none is open the text goes.
  useEffect(() => {
    const here = new Set(characters.map((c) => c.roleId));
    const kept = [...openRef.current].filter((r) => here.has(r));
    if (kept.length === openRef.current.size) return;
    openRef.current = new Set(kept);
    setOpen(new Set(kept));
    if (kept.length === 0) {
      gen.current += 1;
      setFacts(IDLE);
    } else
      setFacts((p) => ({
        ...p,
        roles: p.roles.filter((r) => kept.includes(r.roleId)),
      }));
  }, [characters]);

  function toggle(roleId: string, isOpen: boolean) {
    if (isOpen) {
      if (openRef.current.has(roleId)) return;
      openRef.current.add(roleId);
      setOpen(new Set(openRef.current));
      // One fetch per opened list (a later one supersedes an earlier one in flight, and a reopen after a failure fetches again; there
      // is never an automatic retry). The answer keeps only the text of the lists that are open when it arrives.
      const g = ++gen.current;
      setFacts((p) =>
        p.phase === "ready" ? p : { phase: "loading", roles: [] },
      );
      const done = (r: ConsoleFactText[] | null) => {
        if (gen.current !== g) return; // closed, channel changed or unmounted meanwhile
        setFacts(
          r
            ? {
                phase: "ready",
                roles: r.filter((x) => openRef.current.has(x.roleId)),
              }
            : { phase: "failed", roles: [] },
        );
      };
      load.current().then(done, () => done(null));
    } else {
      if (!openRef.current.delete(roleId)) return;
      setOpen(new Set(openRef.current));
      if (openRef.current.size === 0) {
        gen.current += 1;
        setFacts(IDLE);
      } else
        setFacts((p) => ({
          ...p,
          roles: p.roles.filter((r) => openRef.current.has(r.roleId)),
        }));
    }
  }

  function submit(c: ConsoleCharacter, current: string) {
    if (pending) return;
    const goals = parseGoals(current);
    if (goals === null) {
      setErrors((e) => ({ ...e, [c.roleId]: true }));
      return;
    }
    setErrors((e) => ({ ...e, [c.roleId]: false }));
    void Promise.resolve(onStance(c.roleId, goals)).then((done) => {
      if (done === true)
        setEdits((m) => {
          const rest = { ...m };
          delete rest[c.roleId];
          return rest;
        });
    });
  }

  return (
    <section aria-labelledby={id} className="stack">
      <h3 className="s" id={id}>
        AI characters
      </h3>
      {characters.length === 0 ? (
        <p className="muted">This scenario has no AI characters.</p>
      ) : null}
      {characters.map((c) => {
        const name = roleLabel(c.roleId);
        const current = edits[c.roleId] ?? c.goals.join("\n");
        const suggested = factsEarned[c.roleId] ?? [];
        const isOpen = open.has(c.roleId);
        const errId = `${id}-${c.roleId}-err`;
        return (
          <div key={c.roleId} className="stack">
            <h4 className="s">
              <Person roleId={c.roleId} label={label} />
            </h4>
            <p className="small">Goals</p>
            {c.goals.length === 0 ? (
              <p className="muted small">No goals are set.</p>
            ) : (
              <ul className="plain">
                {c.goals.map((g, i) => (
                  <li key={i} className="preview">
                    {g}
                  </li>
                ))}
              </ul>
            )}
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                submit(c, current);
              }}
            >
              <label htmlFor={`${id}-${c.roleId}-g`}>
                Goals of {isolate(name)}, one per line
              </label>
              <textarea
                id={`${id}-${c.roleId}-g`}
                className="t"
                rows={4}
                value={current}
                disabled={disabled}
                aria-invalid={errors[c.roleId] ? "true" : undefined}
                aria-describedby={errors[c.roleId] ? errId : undefined}
                onChange={(e) =>
                  setEdits((m) => ({ ...m, [c.roleId]: e.target.value }))
                }
              />
              {errors[c.roleId] ? (
                <p className="err" id={errId}>
                  {GOALS_ERROR}
                </p>
              ) : null}
              <div>
                <button
                  type="submit"
                  className="btn"
                  disabled={disabled}
                  aria-disabled={pending ? "true" : undefined}
                  aria-label={`Set stance of ${isolate(name)}`}
                >
                  Set stance
                </button>
              </div>
            </form>
            <details
              open={isOpen}
              onToggle={(e) => toggle(c.roleId, e.currentTarget.open)}
            >
              <summary>Hidden facts ({c.facts.length})</summary>
              <div className="stack">
                {isOpen && facts.phase === "loading" ? (
                  <p role="status" className="muted small">
                    Loading facts…
                  </p>
                ) : null}
                {isOpen && facts.phase === "failed" ? (
                  <p role="alert" className="err">
                    The facts could not be loaded. Close the list and open it
                    again.
                  </p>
                ) : null}
                <ul className="plain stack">
                  {c.facts.map((f) => {
                    const text =
                      isOpen && facts.phase === "ready"
                        ? facts.roles
                            .find((r) => r.roleId === c.roleId)
                            ?.facts.find((x) => x.n === f.n)?.text
                        : undefined;
                    const earned = !f.released && suggested.includes(f.n);
                    return (
                      <li key={f.n} className="preview">
                        {text === undefined
                          ? `Fact ${f.n}`
                          : `Fact ${f.n}: ${text}`}
                        {f.released ? " · Released" : null}
                        {earned ? " · Suggested by the Game Master" : null}
                        {!f.released ? (
                          <>
                            {" "}
                            <button
                              type="button"
                              className="btn"
                              disabled={disabled}
                              aria-disabled={pending ? "true" : undefined}
                              aria-label={`Release fact ${f.n} of ${isolate(name)}`}
                              onClick={(e) => {
                                if (pending) return;
                                onConfirm({
                                  subject: {
                                    kind: "release_hidden",
                                    fact: f.n,
                                    character: isolate(name),
                                  },
                                  command: {
                                    kind: "release_hidden",
                                    roleId: c.roleId,
                                    fact: f.n,
                                  },
                                  opener: e.currentTarget,
                                });
                              }}
                            >
                              Release
                            </button>
                          </>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            </details>
          </div>
        );
      })}
    </section>
  );
}
