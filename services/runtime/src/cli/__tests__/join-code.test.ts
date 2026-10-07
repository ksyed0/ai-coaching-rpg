import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CODE_FILE_MAX_BYTES, isPlausibleJoinCode, readCodeFile, resolveJoinCode, type JoinCodeDeps } from "../join-code.js";

const CODE = "ABCD-EFGH-JKMN";
const deps = (o: Partial<JoinCodeDeps> = {}): JoinCodeDeps => ({
  env: {}, role: "delivery_lead", readFile: () => { throw new Error("unexpected read"); }, fileMode: () => 0o600, isTTY: false, promptHidden: async () => { throw new Error("unexpected prompt"); }, ...o,
});

describe("join code on the terminal client (US-0033)", () => {
  it("test_isPlausibleJoinCode_accepts_loose_typing_and_refuses_other_shapes", () => {
    for (const ok of [CODE, "abcdefghjkmn", " abcd efgh jkmn ", "0000-1111-2222"]) expect(isPlausibleJoinCode(ok)).toBe(true);
    for (const bad of ["", "ABCD-EFGH", "ABCD-EFGH-JKMNP", "ABCD-EFGH-JKMI", "ABCD-EFGH-JKM!", `${CODE}${" ".repeat(60)}`]) expect(isPlausibleJoinCode(bad)).toBe(false);
  });

  it("test_resolveJoinCode_env_first_ahead_of_a_file_and_the_prompt", async () => {
    expect(await resolveJoinCode(deps({ env: { JOIN_CODE: CODE }, codeFile: "/f", isTTY: true }))).toEqual({ ok: true, code: CODE, warnings: [] });
  });

  it("test_resolveJoinCode_invalid_values_are_refused_without_showing_them", async () => {
    for (const r of [
      await resolveJoinCode(deps({ env: { JOIN_CODE: "WRONGSHAPE-XYZ" } })),
      await resolveJoinCode(deps({ codeFile: "/f", readFile: () => "WRONGSHAPE-XYZ\n" })),
      await resolveJoinCode(deps({ isTTY: true, promptHidden: async () => "WRONGSHAPE-XYZ" })),
    ]) {
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain("WRONGSHAPE");
    }
  });

  it("test_resolveJoinCode_file_trims_the_newline_and_warns_when_others_can_read_it", async () => {
    expect(await resolveJoinCode(deps({ codeFile: "/f", readFile: () => `${CODE}\n` }))).toEqual({ ok: true, code: CODE, warnings: [] });
    const loose = await resolveJoinCode(deps({ codeFile: "/f", readFile: () => CODE, fileMode: () => 0o644 }));
    expect(loose.ok && loose.warnings[0]).toMatch(/readable by other users \(mode 644\)/);
    const missing = await resolveJoinCode(deps({ codeFile: "/nope", readFile: () => { throw new Error("ENOENT"); } }));
    expect(missing).toMatchObject({ ok: false, error: expect.stringContaining("cannot read the --code-file") });
  });

  it("test_resolveJoinCode_prompts_hidden_on_a_terminal_and_blank_means_none", async () => {
    const prompt = vi.fn(async (_q: string) => `${CODE.toLowerCase()}\n`);
    expect(await resolveJoinCode(deps({ isTTY: true, promptHidden: prompt }))).toEqual({ ok: true, code: CODE.toLowerCase(), warnings: [] });
    expect(prompt.mock.calls[0]![0]).toContain("delivery_lead");
    expect(await resolveJoinCode(deps({ isTTY: true, promptHidden: async () => " " }))).toEqual({ ok: true, code: undefined, warnings: [] });
    expect(await resolveJoinCode(deps())).toEqual({ ok: true, code: undefined, warnings: [] });
  });

  it("test_readCodeFile_reads_a_small_file_and_refuses_a_big_one", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "acr-codefile-"));
    try {
      writeFileSync(path.join(dir, "ok"), `${CODE}\n`);
      expect(await readCodeFile(path.join(dir, "ok"))).toBe(`${CODE}\n`);
      writeFileSync(path.join(dir, "big"), "x".repeat(CODE_FILE_MAX_BYTES + 1));
      await expect(readCodeFile(path.join(dir, "big"))).rejects.toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
