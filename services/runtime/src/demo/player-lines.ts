import type { Provenance } from "./provenance.js";

/** One spoken player line and where its text came from. `generated` only when the model produced the recorded text. */
export type PlayerLineRecord = {
  role: string; text: string; source: Extract<Provenance, "generated" | "scripted">;
  /** The generated text equals the scripted line (ignoring case and spacing). */
  verbatim: boolean;
  /** Lines for other speakers were cut from the model's reply. */
  cut: boolean;
  /** Set when a failed generation fell back to the scripted line. */
  reason?: string;
};

/**
 * The runner's own record of every player line it SENT, in order. The server's event stream does not say who wrote a line, so the
 * transcript and the report ask this registry; a line that is not in it (or whose entry says scripted) is never tagged generated.
 */
export class PlayerLines {
  readonly records: PlayerLineRecord[] = [];
  add(r: PlayerLineRecord): PlayerLineRecord { this.records.push(r); return r; }
  /** Forget a line the server refused (it never became an event). */
  drop(r: PlayerLineRecord): void { const i = this.records.indexOf(r); if (i >= 0) this.records.splice(i, 1); }
  /** A fresh matcher: for each utterance event in stream order, the record of the line that produced it (same role and text, in send order). Reads the live registry. */
  reader(): (role: string, text: string) => PlayerLineRecord | undefined {
    const used = new Map<string, number>();
    return (role, text) => {
      const k = `${role}\n${text}`; const n = used.get(k) ?? 0; used.set(k, n + 1);
      return this.records.filter((r) => r.role === role && r.text === text)[n];
    };
  }
}

/** The tag source of a player line: only a registry entry that says generated is generated; everything else is the scripted text. */
export const playerSource = (r: PlayerLineRecord | undefined): "generated" | "scripted" => (r?.source === "generated" ? "generated" : "scripted");
