import { readFile } from "node:fs/promises";
import { parseGmReply } from "../agents/gm-parse.js";

export type TraceLine = { nonce?: string | null; seq?: number; sceneId?: string; condition?: string; attempt?: number; raw: string; error?: string; parse: { ok: boolean; verdict?: boolean; via?: string; reason?: string } };
export type ReplayResult = {
  records: number; unreadable: number;
  /** Replies the current parser reads as a usable verdict / all records. */
  parsedNow: number;
  /** Records whose result with the CURRENT parser differs from the one recorded when the trace was captured (the parser changed since). */
  drift: { index: number; recorded: string; now: string }[];
  byReasonNow: Record<string, number>; viaNow: Record<string, number>;
  /** Records from an old trace without a nonce field: they were replayed with the offline rules (any verdict shape), not the rules they were read under. */
  noNonceRecorded: number;
  /** Verdict objects set aside because they lacked the recorded nonce. */
  ignoredNow: number;
};

const describe = (p: { ok: boolean; verdict?: boolean; reason?: string; via?: string }): string => (p.ok ? `verdict ${p.verdict}${p.via ? ` via ${p.via}` : ""}` : `no verdict (${p.reason})`);

/** Replays a `--gm-trace` / GM_TRACE_FILE capture through the current parser, offline. A trace line that is not valid JSON is counted, never fatal. */
export async function replayTrace(file: string): Promise<ReplayResult> {
  const text = await readFile(file, "utf8");
  const res: ReplayResult = { records: 0, unreadable: 0, parsedNow: 0, drift: [], byReasonNow: {}, viaNow: {}, noNonceRecorded: 0, ignoredNow: 0 };
  for (const [i, line] of text.split("\n").filter((l) => l.trim() !== "").entries()) {
    let rec: TraceLine;
    try { rec = JSON.parse(line) as TraceLine; } catch { res.unreadable++; continue; }
    if (typeof rec.raw !== "string" || !rec.parse || typeof rec.parse.ok !== "boolean") { res.unreadable++; continue; }
    res.records++;
    // Replay under the rules the reply was read under: with the nonce that evaluation asked for. Only an OLD trace (no nonce field) falls back to the offline rules.
    const hasNonce = Object.prototype.hasOwnProperty.call(rec, "nonce");
    if (!hasNonce) res.noNonceRecorded++;
    // A reasoning-only reply was an error stand-in with an empty raw: the parser reads empty as `empty`, the capture said `reasoning_only`.
    const now = rec.error ? ({ ok: false, reason: "reasoning_only", ignored: 0 } as const) : parseGmReply(rec.raw, { nonce: hasNonce ? rec.nonce : undefined });
    res.ignoredNow += now.ignored;
    if (now.ok) { res.parsedNow++; res.viaNow[now.via] = (res.viaNow[now.via] ?? 0) + 1; }
    else res.byReasonNow[now.reason] = (res.byReasonNow[now.reason] ?? 0) + 1;
    // A verdict taken from the re-ask was recorded as via "reask" (the parser alone says strict or tolerant): compare via only for first replies.
    const viaSame = !now.ok || !rec.parse.ok || rec.attempt === 2 || rec.parse.via === undefined || rec.parse.via === now.via;
    const same = now.ok === rec.parse.ok && (now.ok ? now.verdict === rec.parse.verdict && viaSame : now.reason === rec.parse.reason);
    if (!same) res.drift.push({ index: i + 1, recorded: describe(rec.parse), now: describe(now.ok ? now : now) });
  }
  return res;
}
