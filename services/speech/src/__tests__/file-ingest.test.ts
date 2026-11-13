import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeWav } from "@acr/adapters";
import { FileIngest, INGEST_FILE_REFUSED } from "../ingest/file-ingest.js";
import { concat, silence, tone } from "./signals.js";

let dir: string;
let savedTmp: string | undefined;
beforeAll(async () => {
  savedTmp = process.env.TMPDIR;
  const own = await mkdtemp(path.join(os.tmpdir(), "acr-speech-ingest-"));
  process.env.TMPDIR = own; // AGENTS.md section 8: a private temp root for this file
  dir = await mkdtemp(path.join(own, "wavs-"));
});
afterAll(async () => {
  const own = process.env.TMPDIR!;
  if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp;
  await rm(own, { recursive: true, force: true });
});

const noPace = async () => {};
const collect = async (ingest: FileIngest) => {
  const got: { roleId: string; frame: Int16Array }[] = [];
  await ingest.start((roleId, generation, frame) => { expect(generation).toBeUndefined(); got.push({ roleId, frame }); });
  return got;
};

describe("FileIngest (US-0070): WAV files as tracks", () => {
  it("frames are 320 samples and interleaved by time", async () => {
    await writeFile(path.join(dir, "a.wav"), encodeWav(concat(tone(60, -20), silence(10)), 16000)); // 70 ms: 4 frames, the last padded
    await writeFile(path.join(dir, "b.wav"), encodeWav(tone(40, -20), 16000)); // 2 frames
    const paced: number[] = [];
    const got = await collect(new FileIngest({ dir, roles: ["a", "b"], frameMs: 20, pace: async (ms) => { paced.push(ms); } }));
    expect(got.map((g) => g.roleId)).toEqual(["a", "b", "a", "b", "a", "a"]);
    for (const g of got) expect(g.frame.length).toBe(320);
    expect(got.at(-1)!.frame.subarray(160).every((x) => x === 0)).toBe(true); // padding
    expect(paced).toEqual([20, 20, 20, 20]); // one wait per frame time
  });

  it("a role id with a separator is refused before reading", () => {
    for (const bad of ["../a", "a/b", "A", "", "a.wav", "x".repeat(65)]) {
      expect(() => new FileIngest({ dir, roles: [bad], frameMs: 20, pace: noPace }), bad).toThrow(RangeError);
    }
  });

  it("a missing file yields no frames for that role", async () => {
    await writeFile(path.join(dir, "c.wav"), encodeWav(tone(40, -20), 16000));
    const got = await collect(new FileIngest({ dir, roles: ["nobody", "c"], frameMs: 20, pace: noPace }));
    expect(got.map((g) => g.roleId)).toEqual(["c", "c"]);
  });

  it("a stereo file is refused with a fixed error", async () => {
    const stereo = encodeWav(tone(40, -20), 16000);
    new DataView(stereo.buffer).setUint16(22, 2, true); // channels = 2
    await writeFile(path.join(dir, "st.wav"), stereo);
    const err = await collect(new FileIngest({ dir, roles: ["st"], frameMs: 20, pace: noPace })).then(() => null, (e: unknown) => e as Error);
    expect(err?.message).toBe(INGEST_FILE_REFUSED);
    expect(err?.message).not.toContain(dir);
  });

  it("a file at another sample rate is refused with the same fixed error", async () => {
    await writeFile(path.join(dir, "r8.wav"), encodeWav(tone(40, -20), 8000));
    await expect(collect(new FileIngest({ dir, roles: ["r8"], frameMs: 20, pace: noPace }))).rejects.toThrow(INGEST_FILE_REFUSED);
  });

  it("a symlink at a role's path is refused, never followed", async () => {
    await writeFile(path.join(dir, "target.wav"), encodeWav(tone(40, -20), 16000));
    await symlink(path.join(dir, "target.wav"), path.join(dir, "link.wav"));
    await expect(collect(new FileIngest({ dir, roles: ["link"], frameMs: 20, pace: noPace }))).rejects.toThrow(INGEST_FILE_REFUSED);
  });

  it("stop ends the run early and start then resolves", async () => {
    await writeFile(path.join(dir, "long.wav"), encodeWav(tone(2000, -20), 16000));
    let n = 0;
    let ingest!: FileIngest;
    ingest = new FileIngest({ dir, roles: ["long"], frameMs: 20, pace: async () => { if (++n === 3) void ingest.stop(); } });
    const got = await collect(ingest);
    expect(got.length).toBe(3);
    await ingest.stop(); // a second stop is harmless
  });

  it("only frameMs 20 is accepted", () => {
    expect(() => new FileIngest({ dir, roles: ["a"], frameMs: 10 as 20, pace: noPace })).toThrow(RangeError);
  });
});
