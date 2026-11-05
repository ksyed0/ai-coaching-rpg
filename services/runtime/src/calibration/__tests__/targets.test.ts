import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TARGETS, loadTargets } from "../targets.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "acr-cal-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const write = async (text: string) => { await mkdir(path.join(dir, "calibration"), { recursive: true }); await writeFile(path.join(dir, "calibration", "targets.yaml"), text); };

describe("loadTargets", () => {
  it("returns the defaults when calibration/targets.yaml is absent", async () => {
    expect(await loadTargets(dir)).toEqual(DEFAULT_TARGETS);
  });
  it("merges overrides over the defaults", async () => {
    await write("maxAbsBias: 0.5\nexactAgreement: 0.6\n");
    expect(await loadTargets(dir)).toEqual({ ...DEFAULT_TARGETS, maxAbsBias: 0.5, exactAgreement: 0.6 });
  });
  it("accepts an empty file as no overrides", async () => {
    await write("");
    expect(await loadTargets(dir)).toEqual(DEFAULT_TARGETS);
  });
  it("rejects an unknown key, naming the file", async () => {
    await write("bogusKey: 1\n");
    await expect(loadTargets(dir)).rejects.toThrow(/calibration\/targets\.yaml: .*bogusKey/);
  });
  it("rejects an out-of-range value, naming the file and the field", async () => {
    await write("minUsable: 7\n");
    await expect(loadTargets(dir)).rejects.toThrow(/calibration\/targets\.yaml: minUsable /);
  });
  it("rejects malformed YAML, naming the file", async () => {
    await write("a: [unclosed\n");
    await expect(loadTargets(dir)).rejects.toThrow(/^calibration\/targets\.yaml: /);
  });
  it("refuses an alias bomb", async () => {
    await write("a: &a [1]\nb: [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\n");
    await expect(loadTargets(dir)).rejects.toThrow(/calibration\/targets\.yaml: /);
  });
  it("refuses an oversized file", async () => {
    await write(`# ${"x".repeat(20000)}\nminUsable: 0.5\n`);
    await expect(loadTargets(dir)).rejects.toThrow(/calibration\/targets\.yaml: .*larger than/);
  });
  it("rejects a YAML warning (an unknown tag) as an error and writes nothing to process stderr", async () => {
    await write("maxAbsBias: !!js/function 'x'\n");
    const emit = vi.spyOn(process, "emitWarning");
    try {
      await expect(loadTargets(dir)).rejects.toThrow(/^calibration\/targets\.yaml: .*Unresolved tag/);
      expect(emit).not.toHaveBeenCalled();
    } finally { emit.mockRestore(); }
  });
  it("strips control characters from echoed text", async () => {
    await write('"bad\\u001b[31mkey": 1\n');
    const err = await loadTargets(dir).catch((e: Error) => e);
    expect((err as Error).message).not.toMatch(/[\u0000-\u001f\u007f]/);
  });
  it("never cuts an astral character in half when truncating an echoed key", async () => {
    await write(`${"x".repeat(100)}${"😀".repeat(150)}: 1\n`);
    const err = (await loadTargets(dir).catch((e: Error) => e)) as Error;
    expect(err.message).toMatch(/…$/);
    expect(err.message).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
  });
});
