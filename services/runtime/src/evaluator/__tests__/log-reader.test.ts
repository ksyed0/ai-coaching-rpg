import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseSessionLog, readSessionLog, SessionLogError } from "../log-reader.js";
import { sampleEvents } from "./fixtures.js";

const jsonl = (evs: unknown[]) => evs.map((e) => JSON.stringify(e)).join("\n") + "\n";

describe("parseSessionLog", () => {
  it("parses a valid log", () => { expect(parseSessionLog(jsonl(sampleEvents()))).toHaveLength(sampleEvents().length); });
  it("tolerates a cut-off final line but not a corrupt middle line", () => {
    const text = jsonl(sampleEvents());
    expect(parseSessionLog(text + '{"type":"utt')).toHaveLength(sampleEvents().length);
    const lines = text.split("\n"); lines[2] = "{oops";
    expect(() => parseSessionLog(lines.join("\n"))).toThrow(/malformed event at line 3/);
  });
  it("rejects an empty log, a gap in seq and a log without session.started", () => {
    expect(() => parseSessionLog("\n")).toThrow(SessionLogError);
    const evs = sampleEvents(); evs.splice(2, 1);
    expect(() => parseSessionLog(jsonl(evs))).toThrow(/not a valid session log/);
    const noStart = sampleEvents().slice(1).map((e, i) => ({ ...e, seq: i + 1 }));
    expect(() => parseSessionLog(jsonl(noStart))).toThrow(/no session.started/);
  });
});

describe("readSessionLog", () => {
  it("reads a file and reports a missing one without the path", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "acr-log-"));
    try {
      const f = path.join(dir, "s.jsonl");
      await writeFile(f, jsonl(sampleEvents()));
      expect((await readSessionLog(f)).length).toBeGreaterThan(5);
      const err = await readSessionLog(path.join(dir, "missing.jsonl")).catch((e: unknown) => e as Error);
      expect(err).toBeInstanceOf(SessionLogError);
      expect((err as Error).message).toBe("cannot read the session log (ENOENT)");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
