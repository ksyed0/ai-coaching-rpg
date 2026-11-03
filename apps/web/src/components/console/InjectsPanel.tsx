"use client";

import { Fragment, useId } from "react";
import { who } from "../../lib/console-confirm";
import { isolate } from "../../lib/console-view";
import type { ConsoleScene } from "../../lib/use-console-stream";
import { Person, type Labeler } from "./Person";
import type { ConfirmRequest } from "./SessionControls";

// US-0059: the injects of the scene that is running. Content, ids and names are text children only; the confirmation shows the content.

export type InjectsPanelProps = {
  /** The scene that is running now, or null. */
  scene: ConsoleScene | null;
  /** state.injectsFired: ids that have fired in this session. */
  fired: string[];
  label: Labeler;
  disabled: boolean;
  pending?: boolean;
  onConfirm: (r: ConfirmRequest) => void;
};

export function InjectsPanel({
  scene,
  fired,
  label,
  disabled,
  pending = false,
  onConfirm,
}: InjectsPanelProps) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="stack">
      <h3 className="s" id={id}>
        Injects
      </h3>
      {scene === null ? (
        <p className="muted">No scene is running.</p>
      ) : scene.injects.length === 0 ? (
        <p className="muted">This scene has no injects.</p>
      ) : (
        <ul className="console-list stack">
          {scene.injects.map((inj) => {
            const again = fired.includes(inj.id);
            return (
              <li key={inj.id} className="stack">
                <p className="preview">{inj.content}</p>
                <p className="muted small">
                  Audience:{" "}
                  {inj.to.length === 0
                    ? "no listed role"
                    : inj.to.map((r, i) => (
                        <Fragment key={r}>
                          {i > 0
                            ? i === inj.to.length - 1
                              ? " and "
                              : ", "
                            : null}
                          <Person roleId={r} label={label} />
                        </Fragment>
                      ))}
                  {inj.atMinute !== undefined
                    ? ` · fires at minute ${inj.atMinute}`
                    : null}
                  {again ? " · Fired" : null}
                </p>
                <div>
                  <button
                    type="button"
                    className="btn"
                    disabled={disabled}
                    aria-disabled={pending ? "true" : undefined}
                    aria-label={`Fire inject ${isolate(inj.id)}${again ? " again" : ""}`}
                    onClick={(e) => {
                      if (pending) return;
                      onConfirm({
                        subject: {
                          kind: "fire_inject",
                          injectId: inj.id,
                          audience: inj.to.map((r) =>
                            who(r, { names: label.names, ai: label.ai(r) }),
                          ),
                          again,
                        },
                        command: { kind: "fire_inject", injectId: inj.id },
                        preview: inj.content,
                        opener: e.currentTarget,
                      });
                    }}
                  >
                    {again ? "Fire again" : "Fire"}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
