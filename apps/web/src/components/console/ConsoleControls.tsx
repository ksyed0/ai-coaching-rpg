"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { fetchFacts, useConsoleCommands } from "../../lib/console-commands";
import type { ConsoleCommand } from "../../lib/console-commands";
import { confirmCopy } from "../../lib/console-confirm";
import { aiPlayerRoles, type ConsoleStreamUi } from "../../lib/use-console-stream";
import { AiPlayersPanel } from "./AiPlayersPanel";
import { CharactersPanel } from "./CharactersPanel";
import { ConfirmDialog } from "./ConfirmDialog";
import { InjectsPanel } from "./InjectsPanel";
import type { Labeler } from "./Person";
import { WhisperForm } from "./WhisperForm";
import { SessionControls, type ConfirmRequest } from "./SessionControls";

// US-0059: the facilitator's controls. Owns the command hook, the one open confirmation, and the status and alert lines (always
// mounted, outside any dialog, so a message is announced; an error is held back until the dialog has closed and the page is live).
// The injects, whisper and characters panels follow SessionControls; they stamp the scene id the console showed when they asked.

const CLOSING_MAX = 300;

export type ConsoleControlsProps = {
  sessionId: string;
  ui: ConsoleStreamUi;
  fetch?: typeof fetch;
};

export function ConsoleControls({
  sessionId,
  ui,
  fetch: fetchImpl,
}: ConsoleControlsProps) {
  const id = useId();
  const cmds = useConsoleCommands(sessionId, ui.channel, fetchImpl);
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const [message, setMessage] = useState("");
  // What the status and alert lines show. Published from an effect once no dialog is open: the dialog lifts `inert` from the page in its
  // own passive cleanup, so text written in the same commit that unmounts it would land in a region that is still inert (not announced).
  const [shown, setShown] = useState<{
    status: string | null;
    error: string | null;
  }>({ status: null, error: null });
  useEffect(() => {
    if (request === null) setShown({ status: cmds.status, error: cmds.error });
  }, [request, cmds.status, cmds.error]);

  const state = ui.view?.state ?? null;
  const disabled =
    ui.conn !== "live" || ui.channel === null || state?.status !== "running";
  const sceneTitle = useMemo(() => {
    const cur = state?.currentScene;
    return cur
      ? (ui.scenes.find((s) => s.id === cur.id)?.title ?? cur.id)
      : null;
  }, [state?.currentScene, ui.scenes]);

  const scene = useMemo(() => {
    const cur = state?.currentScene;
    return cur ? (ui.scenes.find((s) => s.id === cur.id) ?? null) : null;
  }, [state?.currentScene, ui.scenes]);
  const label = useMemo<Labeler>(() => {
    const aiSeats = aiPlayerRoles(state?.aiRoles, ui.roster);
    const names: Record<string, string> = {};
    for (const r of ui.roster) if (r.name && !aiSeats.has(r.roleId)) names[r.roleId] = r.name;
    return { names, ai: (roleId) => state?.roles[roleId]?.kind === "npc", aiPlayer: (roleId) => aiSeats.has(roleId) };
  }, [ui.roster, state?.roles, state?.aiRoles]);
  // Whisper goes to a player: the current scene's players, else every player role.
  const recipients = useMemo(() => {
    const players = (ids: string[]) =>
      ids.filter((r) => state?.roles[r]?.kind === "player");
    const inScene = players(state?.currentScene?.participants ?? []);
    return inScene.length > 0
      ? inScene
      : players(Object.keys(state?.roles ?? {}));
  }, [state?.currentScene, state?.roles]);
  const sceneId = state?.currentScene?.id;
  // Stable across renders (a new fetch function must not close an open list); a new channel or session is a new function.
  const fetchRef = useRef(fetchImpl);
  fetchRef.current = fetchImpl;
  const loadFacts = useCallback(async () => {
    if (ui.channel === null) return null;
    const r = await fetchFacts(sessionId, ui.channel, fetchRef.current);
    return r.ok ? r.roles : null;
  }, [sessionId, ui.channel]);

  // Injects, whisper and release name the scene the console showed when the control was used; the runtime refuses them if it moved on.
  function openStamped(r: ConfirmRequest) {
    const c = r.command;
    const stamp =
      sceneId !== undefined &&
      (c.kind === "fire_inject" ||
        c.kind === "whisper" ||
        c.kind === "release_hidden");
    open(
      stamp
        ? { ...r, command: { ...c, expectSceneId: sceneId } as ConsoleCommand }
        : r,
    );
  }

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
  if (request?.preview !== undefined)
    body = <p className="preview">{request.preview}</p>;
  else if (request?.command.kind === "end_now")
    body = (
      <div className="stack">
        <label htmlFor={`${id}-m`}>
          Closing message to participants (optional)
        </label>
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
          Shown to participants who are connected at the end. At most 300
          characters.
        </p>
      </div>
    );

  const copy = request ? confirmCopy(request.subject) : null;

  return (
    <section aria-labelledby={id} className="card stack">
      <h2 className="s" id={id}>
        Facilitator controls
      </h2>
      <SessionControls
        state={state}
        disabled={disabled}
        pending={cmds.pending}
        onCommand={(c) => void cmds.run(c)}
        onConfirm={open}
        sceneTitle={sceneTitle}
      />
      <InjectsPanel
        scene={scene}
        fired={state?.injectsFired ?? []}
        label={label}
        disabled={disabled}
        pending={cmds.pending}
        onConfirm={openStamped}
      />
      <WhisperForm
        recipients={recipients}
        label={label}
        disabled={disabled}
        pending={cmds.pending}
        onConfirm={openStamped}
      />
      <CharactersPanel
        characters={ui.characters}
        factsEarned={state?.factsEarned ?? {}}
        label={label}
        disabled={disabled}
        pending={cmds.pending}
        onConfirm={openStamped}
        onStance={(roleId, goals) =>
          cmds.run({
            kind: "set_npc_stance",
            roleId,
            goals,
            ...(sceneId !== undefined && { expectSceneId: sceneId }),
          })
        }
        loadFacts={loadFacts}
      />
      <AiPlayersPanel
        sessionId={sessionId}
        channel={ui.channel}
        aiRoles={[...aiPlayerRoles(state?.aiRoles, ui.roster)]}
        running={state?.status === "running" && ui.conn === "live"}
        paused={state?.paused === true}
        sceneRoles={state?.currentScene?.participants ?? null}
        {...(fetchImpl ? { fetch: fetchImpl } : {})}
      />
      <div role="status">
        {shown.status ? <p className="banner ok">{shown.status}</p> : null}
      </div>
      <div role="alert">
        {shown.error ? <p className="err">{shown.error}</p> : null}
      </div>
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
