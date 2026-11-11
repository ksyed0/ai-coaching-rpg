import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StorePathError, ensureRoleDir, roleDir, segmentFile, sessionDir } from "../../store/paths.js";

/** US-0073 (voice A2a, Task 4): path building validates every id and stays inside the audio directory; folders are private and never links. */
const ID = "0123456789abcdef0123456789abcdef";
let root: string;
let audio: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), "acr-paths-")); audio = path.join(root, "audio"); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const badIds = ["", "..", "a/b", "a\\b", "/abs", "A", "a".repeat(65), "a.b", "a b", "a\0b"];

describe("path building", () => {
  it("test_builds_the_layout", () => {
    expect(sessionDir(audio, ID)).toBe(path.join(audio, ID));
    expect(roleDir(audio, ID, "coach")).toBe(path.join(audio, ID, "coach"));
    expect(segmentFile(audio, ID, "coach", "seg-1")).toBe(path.join(audio, ID, "coach", "seg-1.wav"));
  });
  it.each(["", "..", "ABCDEF0123456789abcdef0123456789", "0123456789abcdef0123456789abcde", "0123456789abcdef0123456789abcdef0", `${"a".repeat(31)}/`, "../".padEnd(32, "a")])("test_bad_identity_%j_throws", (id) => {
    expect(() => sessionDir(audio, id)).toThrow(StorePathError);
    expect(() => roleDir(audio, id, "coach")).toThrow(StorePathError);
  });
  it.each(badIds)("test_bad_role_id_%j_throws", (bad) => {
    expect(() => roleDir(audio, ID, bad)).toThrow(StorePathError);
    expect(() => segmentFile(audio, ID, bad, "s1")).toThrow(StorePathError);
  });
  it.each(badIds)("test_bad_segment_id_%j_throws", (bad) => {
    expect(() => segmentFile(audio, ID, "coach", bad)).toThrow(StorePathError);
  });
  it("test_errors_never_carry_the_value_or_the_path", () => {
    for (const fn of [() => sessionDir(audio, "../../etc/SECRET"), () => roleDir(audio, ID, "../SECRETROLE"), () => segmentFile(audio, ID, "coach", "../SECRETSEG")]) {
      try { fn(); throw new Error("did not throw"); } catch (e) {
        expect(e).toBeInstanceOf(StorePathError);
        const m = (e as Error).message;
        expect(m).not.toContain("SECRET");
        expect(m).not.toContain(audio);
        expect(m).not.toContain(ID);
      }
    }
  });
  it("test_a_relative_audio_dir_still_resolves_inside", () => {
    expect(sessionDir("rel/audio", ID)).toBe(path.join("rel/audio", ID));
  });
});

describe("ensureRoleDir", () => {
  it("test_creates_private_directories_step_by_step", () => {
    const dir = ensureRoleDir(audio, ID, "coach");
    expect(dir).toBe(path.join(audio, ID, "coach"));
    for (const d of [audio, path.join(audio, ID), dir]) {
      const st = lstatSync(d);
      expect(st.isDirectory()).toBe(true);
      expect(st.mode & 0o777).toBe(0o700);
    }
    expect(ensureRoleDir(audio, ID, "coach")).toBe(dir); // idempotent
  });
  it("test_refuses_a_symlinked_audio_dir", () => {
    const real = path.join(root, "real"); mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, audio);
    expect(() => ensureRoleDir(audio, ID, "coach")).toThrow(StorePathError);
    expect(() => lstatSync(path.join(real, ID))).toThrow(); // nothing was made through the link
  });
  it("test_refuses_a_symlinked_session_folder", () => {
    const real = path.join(root, "real"); mkdirSync(real, { mode: 0o700 });
    mkdirSync(audio, { mode: 0o700 });
    symlinkSync(real, path.join(audio, ID));
    expect(() => ensureRoleDir(audio, ID, "coach")).toThrow(StorePathError);
    expect(() => lstatSync(path.join(real, "coach"))).toThrow();
  });
  it("test_refuses_a_symlinked_role_folder", () => {
    const real = path.join(root, "real"); mkdirSync(real, { mode: 0o700 });
    mkdirSync(path.join(audio, ID), { recursive: true, mode: 0o700 });
    symlinkSync(real, path.join(audio, ID, "coach"));
    try { ensureRoleDir(audio, ID, "coach"); throw new Error("did not throw"); } catch (e) {
      expect(e).toBeInstanceOf(StorePathError);
      expect((e as Error).message).not.toContain(root);
    }
  });
  it("test_refuses_a_file_where_a_folder_belongs", () => {
    mkdirSync(path.join(audio, ID), { recursive: true, mode: 0o700 });
    symlinkSync("nowhere", path.join(audio, ID, "coach")); // dangling link
    expect(() => ensureRoleDir(audio, ID, "coach")).toThrow(StorePathError);
  });
  it("test_repairs_a_group_readable_audio_dir", () => {
    mkdirSync(audio, { mode: 0o755 }); chmodSync(audio, 0o755);
    ensureRoleDir(audio, ID, "coach");
    expect(lstatSync(audio).mode & 0o777).toBe(0o700);
  });
  it("test_bad_ids_throw_before_touching_the_disk", () => {
    expect(() => ensureRoleDir(audio, "nope", "coach")).toThrow(StorePathError);
    expect(() => lstatSync(audio)).toThrow();
  });
});
