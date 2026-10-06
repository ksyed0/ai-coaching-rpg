import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { replayTrace } from "../replay.js";

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const file = async (lines: string[]) => { const d = await mkdtemp(path.join(os.tmpdir(), "gm-trace-")); dirs.push(d); const f = path.join(d, "t.jsonl"); await writeFile(f, lines.join("\n")); return f; };
const rec = (raw: string, parse: object, extra: object = {}) => JSON.stringify({ seq: 1, sceneId: "s", condition: "c", attempt: 1, raw, parse, ...extra });

describe("replayTrace", () => {
  it("re-parses every raw reply with the current parser and reports parse rate by reason, never failing on a bad line", async () => {
    const f = await file([
      rec('{"reasoning": "r", "verdict": true}', { ok: true, verdict: true, via: "strict" }),
      rec("nope", { ok: false, reason: "no_json" }),
      rec("```json\n{\"verdict\": false}\n```", { ok: true, verdict: false, via: "tolerant" }),
      rec("", { ok: false, reason: "reasoning_only" }, { error: "reasoning_budget" }),
      "not json at all",
      JSON.stringify({ raw: 5 }),
      "",
    ]);
    const r = await replayTrace(f);
    expect(r).toMatchObject({ records: 4, unreadable: 2, parsedNow: 2, byReasonNow: { no_json: 1, reasoning_only: 1 }, viaNow: { strict: 1, tolerant: 1 } });
    expect(r.drift).toEqual([]);
  });
  it("reports drift when the parser reads a captured reply differently from when it was captured", async () => {
    const f = await file([rec('{"reasoning": "r", "verdict": "true"}', { ok: false, reason: "bad_verdict" })]); // an old strict parser refused the string "true"
    const r = await replayTrace(f);
    expect(r.drift).toEqual([{ index: 1, recorded: "no verdict (bad_verdict)", now: "verdict true" }]);
  });
});
