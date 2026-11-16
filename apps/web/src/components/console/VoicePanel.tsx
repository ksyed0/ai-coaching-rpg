import { useEffect, useId, useState } from "react";
import { useConsoleCommands } from "../../lib/console-commands";
import { CONSOLE_VOICE, type ConsoleVoiceState } from "../../lib/console-voice";
import { MESSAGES } from "../../lib/messages";
import { roleLabel } from "../../lib/names";
import { SpeakingIndicator } from "./SpeakingIndicator";

// US-0071 (A1b Task 16): the facilitator's voice panel in the live view. One row per human seat that carries a voice state (an AI seat is
// never listed), its voice choice in words and, for a seat that chose voice, whether it speaks now. Rendered only when at least one entry
// has `voice` (voice on): a text-only session shows nothing new. The speaking changes are never announced; the only live region is the
// polite status line for the result of a mute or unmute (A3A), mounted only while the panel can send commands.
// Names are untrusted text inside <bdi>.

export type VoicePanelEntry = { roleId: string; name?: string; ai?: true; voice?: ConsoleVoiceState; speaking?: true; /** A3A: the facilitator has muted this seat. */ facilitatorMuted?: boolean };

/** What the panel needs to send a mute command; absent (an ended session) means no buttons and no status line. */
export type VoiceMuteContext = { sessionId: string; channel: string | null; /** The live view is connected (conn live and a channel). Not live: a press sends nothing and says so. */ live: boolean; fetch?: typeof fetch };

export function VoiceStateWords({ voice }: { voice: ConsoleVoiceState }) {
  const on = voice === "voice";
  return (
    <span className={`pill ${on ? "ok" : "mut"}`}>
      <span aria-hidden="true">{on ? "✓ " : "– "}</span>
      {CONSOLE_VOICE.states[voice]}
    </span>
  );
}

const seatName = (e: VoicePanelEntry) => (e.name !== undefined && e.name !== "" ? `${e.name} (${roleLabel(e.roleId)})` : roleLabel(e.roleId));

export function VoicePanel({ roster, mute }: { roster: readonly VoicePanelEntry[]; mute?: VoiceMuteContext }) {
  const id = useId();
  // One command at a time (the hook's in-flight guard): a second press while one is out sends nothing.
  const [notLive, setNotLive] = useState(false);
  // The "not sent" notice belongs to the press that caused it: once the view is live again it is spent, so a later drop starts clean.
  const live = mute?.live === true;
  useEffect(() => { if (live) setNotLive(false); }, [live]);
  const cmds = useConsoleCommands(mute?.sessionId ?? "", mute?.channel ?? null, mute?.fetch);
  const seats = roster.filter((e): e is VoicePanelEntry & { voice: ConsoleVoiceState } => e.ai !== true && e.voice !== undefined);
  if (seats.length === 0) return null;
  return (
    <section aria-labelledby={id} className="card voicepanel">
      <h2 className="s" id={id}>{CONSOLE_VOICE.heading}</h2>
      <p className="muted small">{CONSOLE_VOICE.caption}</p>
      <div className="tablewrap">
        <table className="grid">
          <caption className="sr-only">{CONSOLE_VOICE.heading}</caption>
          <thead>
            <tr><th scope="col">Participant</th><th scope="col">Voice</th><th scope="col">Speaking</th></tr>
          </thead>
          <tbody>
            {seats.map((e) => (
              <tr key={e.roleId}>
                <th scope="row">
                  {e.name !== undefined && e.name !== "" ? (
                    <><bdi>{e.name}</bdi> <span className="muted">(<bdi>{roleLabel(e.roleId)}</bdi>)</span></>
                  ) : (
                    <bdi>{roleLabel(e.roleId)}</bdi>
                  )}
                </th>
                <td>
                  <VoiceStateWords voice={e.voice} />
                  {e.facilitatorMuted === true ? (
                    <> <span className="pill warn"><span aria-hidden="true">🔇 </span>{CONSOLE_VOICE.mutedByFacilitator}</span></>
                  ) : null}
                  {mute ? (
                    <> <button
                      className="btn"
                      type="button"
                      aria-disabled={mute.live && !cmds.pending ? undefined : true}
                      aria-label={`${e.facilitatorMuted === true ? "Unmute" : "Mute"} microphone, ${seatName(e)}`}
                      onClick={() => {
                        if (!mute.live) { setNotLive(true); return; }
                        setNotLive(false);
                        void cmds.run({ kind: "mute_seat", roleId: e.roleId, muted: e.facilitatorMuted !== true });
                      }}
                    >
                      {e.facilitatorMuted === true ? "Unmute" : "Mute"}
                    </button></>
                  ) : null}
                </td>
                <td>{e.voice === "voice" ? <SpeakingIndicator speaking={e.speaking === true} /> : <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {mute ? (
        <div role="status" aria-live="polite">
          {notLive && !mute.live ? <p className="err">{MESSAGES.consoleMuteNotLive}</p> : null}
          {!(notLive && !mute.live) && cmds.status ? <p className="banner ok">{cmds.status}</p> : null}
          {!(notLive && !mute.live) && cmds.error ? <p className="err">{cmds.error}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
