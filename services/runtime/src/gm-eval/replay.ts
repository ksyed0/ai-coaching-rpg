import { readFile } from "node:fs/promises";
import { parseGmReply } from "../agents/gm-parse.js";

export type TraceLine = { seq?: number; sceneId?: string; condition?: string; attempt?: number; raw: string; error?: string; parse: { ok: boolean; verdict?: boolean; via?: string; reason?: string } };
export type ReplayResult = {
  records: number; unreadable: number;
  /** Replies the current parser reads as a usable verdict / all records. */
  parsedNow: number;
  /** Records whose result with the CURRENT parser differs from the one recorded when the trace was captured (the parser changed since). */
  drift: { index: number; recorded: string; now: string }[];
  byReasonNow: Record<string, number>; viaNow: Record<string, number>;
};

const describe = (p: { ok: boolean; verdict?: boolean; reason?: string }): string => (p.ok ? `verdict ${p.verdict}` : `no verdict (${p.reason})`);

/** Replays a `--gm-trace` / GM_TRACE_FILE capture through the current parser, offline. A trace line that is not valid JSON is counted, never fatal. */
export async function replayTrace(file: string): Promise<ReplayResult> {
  const text = await readFile(file, "utf8");
  const res: ReplayResult = { records: 0, unreadable: 0, parsedNow: 0, drift: [], byReasonNow: {}, viaNow: {} };
  for (const [i, line] of text.split("\n").filter((l) => l.trim() !== "").entries()) {
    let rec: TraceLine;
    try { rec = JSON.parse(line) as TraceLine; } catch { res.unreadable++; continue; }
    if (typeof rec.raw !== "string" || !rec.parse || typeof rec.parse.ok !== "boolean") { res.unreadable++; continue; }
    res.records++;
    // A reasoning-only reply was an error stand-in with an empty raw: the parser reads empty as `empty`, the capture said `reasoning_only`.
    const now = rec.error ? ({ ok: false, reason: "reasoning_only" } as const) : parseGmReply(rec.raw);
    if (now.ok) { res.parsedNow++; res.viaNow[now.via] = (res.viaNow[now.via] ?? 0) + 1; }
    else res.byReasonNow[now.reason] = (res.byReasonNow[now.reason] ?? 0) + 1;
    const same = now.ok === rec.parse.ok && (now.ok ? now.verdict === rec.parse.verdict : now.reason === rec.parse.reason);
    if (!same) res.drift.push({ index: i + 1, recorded: describe(rec.parse), now: describe(now) });
  }
  return res;
}
