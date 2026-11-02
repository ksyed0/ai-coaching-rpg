"use client";

import { useId, useMemo, useState, type ReactNode } from "react";
import { useConsoleCommands } from "../../lib/console-commands";
import type { ConsoleCommand } from "../../lib/console-commands";
import { confirmCopy } from "../../lib/console-confirm";
import type { ConsoleStreamUi } from "../../lib/use-console-stream";
import { ConfirmDialog } from "./ConfirmDialog";
import { SessionControls, type ConfirmRequest } from "./SessionControls";

// US-0059: the facilitator's controls. Owns the command hook, the one open confirmation, and the status and alert lines (always
// mounted, outside any dialog, so a message is announced; an error is held back until the dialog has closed and the page is live).
// Task 13 adds the injects, whisper and characters panels beside SessionControls.

const CLOSING_MAX = 300;

export type ConsoleControlsProps = { sessionId: string; ui: ConsoleStreamUi; fetch?: typeof fetch };

export function ConsoleControls({ sessionId, ui, fetch: fetchImpl }: ConsoleControlsProps) {
  const id = useId();
  const cmds = useConsoleCommands(sessionId, ui.channel, fetchImpl);
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const [message, setMessage] = useState("");

  const state = ui.view?.state ?? null;
  const disabled = ui.conn !== "live" || ui.channel === null || state?.status !== "running";
  const sceneTitle = useMemo(() => {
    const cur = state?.currentScene;
    return cur ? (ui.scenes.find((s) => s.id === cur.id)?.title ?? cur.id) : null;
  }, [state?.currentScene, ui.scenes]);

  function open(r: ConfirmRequest) {
    setMessage("");
    setRequest(r);
  }

  async function confirm() {
    if (!request) return;
    let c: ConsoleCommand = request.command;
    if (c.kind === "end_now") {
      const m = message.trim();
      c = m === "" ? { kind: "end_now" } : { kind: "end_now", message: m };
    }
    await cmds.run(c);
    setRequest(null); // success or refusal: the dialog closes, focus returns to its opener, then the alert shows
  }

  let body: ReactNode;
  if (request?.preview !== undefined) body = <p className="preview">{request.preview}</p>;
  else if (request?.command.kind === "end_now")
    body = (
      <div className="stack">
        <label htmlFor={`${id}-m`}>Closing message to participants (optional)</label>
        <textarea
          id={`${id}-m`}
          className="t"
          rows={3}
          maxLength={CLOSING_MAX}
          value={message}
          aria-describedby={`${id}-h`}
          onChange={(e) => setMessage(e.target.value)}
        />
        <p className="muted small" id={`${id}-h`}>
          Shown to participants who are connected at the end. At most 300 characters.
        </p>
      </div>
    );

  const copy = request ? confirmCopy(request.subject) : null;

  return (
    <section aria-labelledby={id} className="card stack">
      <h2 className="s" id={id}>Facilitator controls</h2>
      <SessionControls
        state={state}
        disabled={disabled}
        pending={cmds.pending}
        onCommand={(c) => void cmds.run(c)}
        onConfirm={open}
        sceneTitle={sceneTitle}
      />
      <div role="status">{cmds.status ? <p className="banner ok">{cmds.status}</p> : null}</div>
      <div role="alert">{request === null && cmds.error ? <p className="err">{cmds.error}</p> : null}</div>
      {request && copy ? (
        <ConfirmDialog
          title={copy.title}
          description={copy.description}
          confirmLabel={copy.confirmLabel}
          tone={copy.tone}
          pending={cmds.pending}
          opener={request.opener}
          describeBody={request.preview !== undefined}
          onCancel={() => setRequest(null)}
          onConfirm={() => void confirm()}
        >
          {body}
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
