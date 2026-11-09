import { useId } from "react";
import { CONSOLE_VOICE, type ConsoleVoiceState } from "../../lib/console-voice";
import { roleLabel } from "../../lib/names";
import { SpeakingIndicator } from "./SpeakingIndicator";

// US-0071 (A1b Task 16): the facilitator's voice panel in the live view. One row per human seat that carries a voice state (an AI seat is
// never listed), its voice choice in words and, for a seat that chose voice, whether it speaks now. Rendered only when at least one entry
// has `voice` (voice on): a text-only session shows nothing new. No live region anywhere in it (speaking changes are not announced).
// Names are untrusted text inside <bdi>.

export type VoicePanelEntry = { roleId: string; name?: string; ai?: true; voice?: ConsoleVoiceState; speaking?: true };

export function VoiceStateWords({ voice }: { voice: ConsoleVoiceState }) {
  const on = voice === "voice";
  return (
    <span className={`pill ${on ? "ok" : "mut"}`}>
      <span aria-hidden="true">{on ? "✓ " : "– "}</span>
      {CONSOLE_VOICE.states[voice]}
    </span>
  );
}

export function VoicePanel({ roster }: { roster: readonly VoicePanelEntry[] }) {
  const id = useId();
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
                <td><VoiceStateWords voice={e.voice} /></td>
                <td>{e.voice === "voice" ? <SpeakingIndicator speaking={e.speaking === true} /> : <span className="muted">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
