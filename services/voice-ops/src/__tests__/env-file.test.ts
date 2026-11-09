import { randomBytes } from "node:crypto";
import { chmodSync, chownSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  appendBlock, ensureVoiceSecrets, EnvFileError, MANAGED_NAMES, planSecrets, readPrivateEnv, sttRequestPath, type EnvFileErrorCode, type GitRun,
} from "../env-file.js";
import { isHex } from "../text.js";

// US-0072 (EPIC-0003 voice A1c, Task 2): the `.env` secrets writer. Every test works in a private mkdtemp directory with fabricated
// placeholder values; the owner's real `.env` is never touched. Generated test keys are never printed or snapshotted.

let root: string;
let savedTmp: string | undefined;
beforeAll(() => {
  savedTmp = process.env.TMPDIR;
  root = mkdtempSync(path.join(os.tmpdir(), "acr-voice-ops-env-"));
  process.env.TMPDIR = root; // this file lists directories: keep everything private (AGENTS.md section 8)
});
afterAll(() => {
  if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp;
  rmSync(root, { recursive: true, force: true });
});

/** A deterministic `random`: each call fills its bytes with the next counter value. */
function counterRandom(): (n: number) => Buffer {
  let k = 1;
  return (n) => Buffer.alloc(n, k++);
}
const NOW = () => Date.UTC(2026, 10, 9, 12, 0, 0);
/** git ls-files --error-unmatch answers "not tracked" (exit 1), as for the repository's real .env. */
const untracked: GitRun = async () => ({ code: 1, stdout: "", stderr: "" });
const freePortStub = (port = 24680) => vi.fn(async () => port);

function newDir(): string { return mkdtempSync(path.join(root, "d-")); }
function envFile(text: string, mode = 0o600): string {
  const dir = newDir();
  const file = path.join(dir, ".env");
  writeFileSync(file, text, { mode });
  chmodSync(file, mode); // the umask may have removed bits
  return file;
}
/** What an `ls -A` would list, minus `.env` itself. */
const leftovers = (dir: string): string[] => readdirSync(dir).filter((n) => n.startsWith(".env.voice-ops."));
const ensure = (file: string, o: Partial<Parameters<typeof ensureVoiceSecrets>[0]> = {}) =>
  ensureVoiceSecrets({ file, random: counterRandom(), freePort: freePortStub(), now: NOW, env: {}, run: untracked, ...o });
async function refusal(p: Promise<unknown>): Promise<EnvFileError> {
  try { await p; } catch (err) { if (err instanceof EnvFileError) return err; throw err; }
  throw new Error("expected an EnvFileError");
}

const KEY = "APIplaceholderkey0001"; // fabricated, not a real key
const SECRET = "placeholder-secret-".padEnd(48, "x"); // fabricated, 48 characters
const STT = "http://127.0.0.1:9000/0123456789abcdef0123456789abcdef";

describe("ensureVoiceSecrets (US-0072, A1c Task 2)", () => {
  it("adds the key, the secret and STT_URL to a .env that has none, once", async () => {
    const file = envFile("FACILITATOR_TOKEN=placeholder-token\n");
    const freePort = freePortStub(24680);
    expect(await ensure(file, { freePort })).toEqual({ added: ["LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "STT_URL"] });
    expect(freePort).toHaveBeenCalledTimes(1);
    const v = parseEnv(readFileSync(file, "utf8"));
    expect(v.FACILITATOR_TOKEN).toBe("placeholder-token");
    expect(v.LIVEKIT_API_KEY!.startsWith("API") && isHex(v.LIVEKIT_API_KEY!.slice(3), 24)).toBe(true);
    expect(isHex(v.LIVEKIT_API_SECRET!, 64)).toBe(true);
    const prefix = "http://127.0.0.1:24680/";
    expect(v.STT_URL!.startsWith(prefix) && isHex(v.STT_URL!.slice(prefix.length), 32)).toBe(true);
    const before = readFileSync(file);
    const freePort2 = freePortStub(25000);
    expect(await ensure(file, { freePort: freePort2 })).toEqual({ added: [] });
    expect(freePort2).not.toHaveBeenCalled();
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it("the block starts with the fixed comment and the date, and the values are one per line", async () => {
    const file = envFile("A=1\n");
    await ensure(file);
    const added = readFileSync(file, "utf8").slice("A=1\n".length).split("\n");
    expect(added[0]).toBe("# Added by pnpm voice:up on 2026-11-09 (US-0072). Secrets: keep this file private (mode 600), never commit it.");
    expect(added.slice(1, 4).map((l) => l.slice(0, l.indexOf("=")))).toEqual(["LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "STT_URL"]);
    expect(added.slice(4)).toEqual([""]);
  });

  it("keeps every existing byte and appends only the missing names", async () => {
    const text = "# a comment\r\nNAME=\"quoted value # not a comment\"\r\nexport X=1\r\n\r\nSTT_URL=" + STT + "\r\nY='single'\r\n";
    const file = envFile(text);
    const freePort = freePortStub();
    expect(await ensure(file, { freePort })).toEqual({ added: ["LIVEKIT_API_KEY", "LIVEKIT_API_SECRET"] });
    expect(freePort).not.toHaveBeenCalled(); // STT_URL is present: no port is picked
    const after = readFileSync(file, "utf8");
    expect(after.startsWith(text)).toBe(true);
    const v = parseEnv(after);
    expect(v.STT_URL).toBe(STT);
    expect(v.NAME).toBe("quoted value # not a comment");
    expect(v.X).toBe("1");
  });

  it("an existing key pair is never changed; only STT_URL is added", async () => {
    const text = `LIVEKIT_API_KEY=${KEY}\nLIVEKIT_API_SECRET=${SECRET}\n`;
    const file = envFile(text);
    expect(await ensure(file)).toEqual({ added: ["STT_URL"] });
    const after = readFileSync(file, "utf8");
    expect(after.startsWith(text)).toBe(true);
    const v = parseEnv(after);
    expect([v.LIVEKIT_API_KEY, v.LIVEKIT_API_SECRET]).toEqual([KEY, SECRET]);
    expect(after.split("LIVEKIT_API_KEY=").length).toBe(2); // exactly one assignment of each, the original
    expect(after.split("LIVEKIT_API_SECRET=").length).toBe(2);
  });

  it("a file without a final newline gets one before the block", async () => {
    const file = envFile("A=1");
    await ensure(file);
    const after = readFileSync(file, "utf8");
    expect(after.startsWith("A=1\n# Added by pnpm voice:up")).toBe(true);
    expect(parseEnv(after).A).toBe("1");
  });

  it("an empty .env gets the block alone", async () => {
    const file = envFile("");
    await ensure(file);
    expect(readFileSync(file, "utf8").startsWith("# Added by pnpm voice:up")).toBe(true);
  });

  it("the result is mode 600 and no temporary file is left", async () => {
    const file = envFile("A=1\n");
    const dir = path.dirname(file);
    // Self-test: the listing would see a leftover temp file.
    const probe = newDir();
    writeFileSync(path.join(probe, ".env.voice-ops.0123456789ab.tmp"), "");
    expect(leftovers(probe)).toEqual([".env.voice-ops.0123456789ab.tmp"]);
    await ensure(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(leftovers(dir)).toEqual([]);
    expect(readdirSync(dir)).toEqual([".env"]);
  });

  it("the file is replaced, not written in place (a new inode)", async () => {
    const file = envFile("A=1\n");
    const ino = statSync(file).ino;
    await ensure(file);
    expect(statSync(file).ino).not.toBe(ino);
  });

  const table: [string, string, EnvFileErrorCode][] = [
    ["only the key set", `LIVEKIT_API_KEY=${KEY}\n`, "half_pair"],
    ["only the secret set", `LIVEKIT_API_SECRET=${SECRET}\n`, "half_pair"],
    ["LIVEKIT_API_SECRET= empty", `LIVEKIT_API_KEY=${KEY}\nLIVEKIT_API_SECRET=\n`, "empty_assignment"],
    ["LIVEKIT_API_KEY=\"\" empty", `LIVEKIT_API_KEY=""\n`, "empty_assignment"],
    ["STT_URL= empty", "STT_URL=\n", "empty_assignment"],
    ["export STT_URL= empty", "export STT_URL=   \n", "empty_assignment"],
    ["an empty line before a real one", `LIVEKIT_API_KEY=${KEY}\nLIVEKIT_API_SECRET=\nLIVEKIT_API_SECRET=${SECRET}\n`, "empty_assignment"],
    ["devkey / secret", "LIVEKIT_API_KEY=devkey\nLIVEKIT_API_SECRET=secret\n", "dev_keys"],
    ["DEVKEY / SECRET", "LIVEKIT_API_KEY=DEVKEY\nLIVEKIT_API_SECRET=SECRET\n", "dev_keys"],
    ["devkey with a long secret", `LIVEKIT_API_KEY=DevKey\nLIVEKIT_API_SECRET=${SECRET}\n`, "dev_keys"],
    ["a 31-character secret", `LIVEKIT_API_KEY=${KEY}\nLIVEKIT_API_SECRET=${"s".repeat(31)}\n`, "dev_keys"],
    ["STT_URL=http://0.0.0.0:9000", "STT_URL=http://0.0.0.0:9000\n", "bad_stt_url"],
    ["STT_URL=http://[::1]:9000/abc", "STT_URL=http://[::1]:9000/abc\n", "bad_stt_url"],
    ["STT_URL without a port", "STT_URL=http://127.0.0.1/abc\n", "bad_stt_url"],
  ];
  it.each(table)("refuses and leaves the file byte-identical for %s", async (_label, text, code) => {
    const file = envFile(text);
    const before = readFileSync(file);
    const freePort = freePortStub();
    const err = await refusal(ensure(file, { freePort }));
    expect(err.code).toBe(code);
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(leftovers(path.dirname(file))).toEqual([]);
    expect(freePort).not.toHaveBeenCalled();
  });

  it.each([0o644, 0o640, 0o604, 0o620, 0o602, 0o610])("refuses mode %o as too open and leaves the file byte-identical", async (mode) => {
    const file = envFile("A=1\n", mode);
    const before = readFileSync(file);
    expect((await refusal(ensure(file))).code).toBe("too_open");
    expect(readFileSync(file).equals(before)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(mode);
  });

  it("refuses a symlink to a real file and leaves the target unchanged", async () => {
    const dir = newDir();
    const target = path.join(dir, "real.env");
    writeFileSync(target, "A=1\n", { mode: 0o600 });
    const file = path.join(dir, ".env");
    symlinkSync(target, file);
    expect((await refusal(ensure(file))).code).toBe("symlink");
    expect(readFileSync(target, "utf8")).toBe("A=1\n");
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(leftovers(dir)).toEqual([]);
  });

  it("refuses a dangling symlink and creates nothing", async () => {
    const dir = newDir();
    const file = path.join(dir, ".env");
    symlinkSync(path.join(dir, "nowhere"), file);
    expect((await refusal(ensure(file))).code).toBe("symlink");
    expect(readdirSync(dir)).toEqual([".env"]);
  });

  it("refuses a directory", async () => {
    const dir = newDir();
    mkdirSync(path.join(dir, ".env"), { mode: 0o700 });
    expect((await refusal(ensure(path.join(dir, ".env")))).code).toBe("not_regular");
  });

  it("refuses a missing .env and creates none", async () => {
    const dir = newDir();
    const err = await refusal(ensure(path.join(dir, ".env")));
    expect(err.code).toBe("missing");
    expect(readdirSync(dir)).toEqual([]);
  });

  it.runIf(typeof process.getuid === "function" && process.getuid() === 0)("refuses a .env owned by another user (root only)", async () => {
    const file = envFile("A=1\n");
    chownSync(file, 12345, 12345);
    expect((await refusal(ensure(file))).code).toBe("not_owner");
  });

  it("the too-open and missing sentences name chmod 600 .env and ./run.sh", () => {
    expect(new EnvFileError("too_open").message).toBe(".env is readable by other users: run chmod 600 .env, then pnpm voice:up");
    expect(new EnvFileError("missing").message).toBe(".env not found: run ./run.sh once first (it creates .env with a facilitator token), then pnpm voice:up");
    expect(new EnvFileError("changed").message).toBe(".env changed while voice:up was writing it: run pnpm voice:up again");
    expect(new EnvFileError("tracked").message).toBe("remove .env from git (git rm --cached .env) before voice:up writes secrets into it");
    expect(new EnvFileError("env_override", "LIVEKIT_API_KEY").message).toBe("unset LIVEKIT_API_KEY in this shell: voice:up and control must read it from .env");
    expect(new EnvFileError("empty_assignment", "STT_URL").message).toContain("STT_URL");
    expect(new EnvFileError("too_open").name).toBe("EnvFileError");
  });

  it.each(MANAGED_NAMES.map((n) => [n]))("the real environment setting %s is refused, before git or the file is read", async (name) => {
    const file = envFile("A=1\n");
    const before = readFileSync(file);
    const run = vi.fn(untracked);
    for (const value of ["from-the-shell", ""]) {
      const err = await refusal(ensure(file, { env: { [name]: value }, run }));
      expect(err.code).toBe("env_override");
      expect(err.message).toBe(`unset ${name} in this shell: voice:up and control must read it from .env`);
    }
    expect(run).not.toHaveBeenCalled();
    expect(readFileSync(file).equals(before)).toBe(true);
    // Unrelated variables in the real environment are fine.
    expect((await ensure(file, { env: { PATH: "/usr/bin", LIVEKIT_HOST: "http://127.0.0.1:7880" } })).added).toHaveLength(3);
  });

  it("a .env tracked by git is refused; the check runs git -C <dir> ls-files --error-unmatch -- .env", async () => {
    const file = envFile("A=1\n");
    const before = readFileSync(file);
    const run = vi.fn<GitRun>(async () => ({ code: 0, stdout: ".env\n", stderr: "" }));
    expect((await refusal(ensure(file, { run }))).code).toBe("tracked");
    expect(run).toHaveBeenCalledWith("git", ["-C", path.dirname(file), "ls-files", "--error-unmatch", "--", ".env"], { timeoutMs: 30_000 });
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it("git missing, not a repository or not tracked skips the tracked check", async () => {
    for (const run of [
      (async () => { throw Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }); }) as GitRun,
      (async () => ({ code: 128, stdout: "", stderr: "fatal: not a git repository" })) as GitRun,
      (async () => ({ code: null, stdout: "", stderr: "" })) as GitRun,
      untracked,
    ]) {
      const file = envFile("A=1\n");
      expect((await ensure(file, { run })).added).toHaveLength(3);
    }
  });

  it("a file replaced between the read and the rename is left alone", async () => {
    // Replaced by another file (a new inode).
    {
      const file = envFile("A=1\n");
      const r = readPrivateEnv(file);
      const swap = path.join(path.dirname(file), "swap");
      writeFileSync(swap, "B=2\n", { mode: 0o600 });
      renameSync(swap, file);
      expect(() => appendBlock(file, r.text, "X=1\n", r.id)).toThrow(expect.objectContaining({ code: "changed" }));
      expect(readFileSync(file, "utf8")).toBe("B=2\n");
      expect(leftovers(path.dirname(file))).toEqual([]);
    }
    // Written in place (same inode, another size).
    {
      const file = envFile("A=1\n");
      const r = readPrivateEnv(file);
      appendFileSync(file, "B=2\n");
      expect(() => appendBlock(file, r.text, "X=1\n", r.id)).toThrow(expect.objectContaining({ code: "changed" }));
      expect(readFileSync(file, "utf8")).toBe("A=1\nB=2\n");
      expect(leftovers(path.dirname(file))).toEqual([]);
    }
    // Same size, only the modification time moved.
    {
      const file = envFile("A=1\n");
      const r = readPrivateEnv(file);
      utimesSync(file, new Date(Date.UTC(2020, 0, 1)), new Date(Date.UTC(2020, 0, 1)));
      expect(() => appendBlock(file, r.text, "X=1\n", r.id)).toThrow(expect.objectContaining({ code: "changed" }));
      expect(readFileSync(file, "utf8")).toBe("A=1\n");
    }
    // Replaced by a symlink.
    {
      const file = envFile("A=1\n");
      const r = readPrivateEnv(file);
      const target = path.join(path.dirname(file), "t");
      writeFileSync(target, "T=1\n", { mode: 0o600 });
      rmSync(file);
      symlinkSync(target, file);
      expect(() => appendBlock(file, r.text, "X=1\n", r.id)).toThrow(expect.objectContaining({ code: "changed" }));
      expect(readFileSync(target, "utf8")).toBe("T=1\n");
      expect(lstatSync(file).isSymbolicLink()).toBe(true);
    }
    // Removed.
    {
      const file = envFile("A=1\n");
      const r = readPrivateEnv(file);
      rmSync(file);
      expect(() => appendBlock(file, r.text, "X=1\n", r.id)).toThrow(expect.objectContaining({ code: "changed" }));
      expect(readdirSync(path.dirname(file))).toEqual([]);
    }
  });

  it("a file swapped while the port is being picked is left alone (end to end)", async () => {
    const file = envFile("A=1\n");
    const freePort = vi.fn(async () => {
      const swap = path.join(path.dirname(file), "swap");
      writeFileSync(swap, "SWAPPED=1\n", { mode: 0o600 });
      renameSync(swap, file);
      return 24680;
    });
    expect((await refusal(ensure(file, { freePort }))).code).toBe("changed");
    expect(readFileSync(file, "utf8")).toBe("SWAPPED=1\n");
    expect(leftovers(path.dirname(file))).toEqual([]);
  });

  it("no error message and no thrown value contains a value from the file", async () => {
    const M = "MARKERz9";
    const cases = [
      `LIVEKIT_API_KEY=${M}key\n`,
      `LIVEKIT_API_SECRET=${M}${"s".repeat(40)}\n`,
      `LIVEKIT_API_KEY=${M}k\nLIVEKIT_API_SECRET=${M}short\n`,
      `LIVEKIT_API_KEY=${M}k\nLIVEKIT_API_SECRET=\n`,
      `STT_URL=http://${M}.example:9000/${M}\n`,
      `STT_URL=http://[::1]:9000/${M}\n`,
    ];
    let n = 0;
    for (const text of cases) {
      const err = await refusal(ensure(envFile(text)));
      for (const shown of [err.message, String(err), err.stack ?? "", JSON.stringify(err), JSON.stringify(Object.values(err))]) expect(shown).not.toContain(M);
      n += 1;
    }
    const tooOpen = await refusal(ensure(envFile(`SECRET_THING=${M}\n`, 0o644)));
    expect(JSON.stringify([tooOpen.message, tooOpen.stack, Object.values(tooOpen)])).not.toContain(M);
    expect(n).toBe(cases.length);
  });

  it("prints nothing, on success and on a refusal", async () => {
    const spies = [
      ...(["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined)),
      vi.spyOn(process.stdout, "write").mockImplementation(() => true),
      vi.spyOn(process.stderr, "write").mockImplementation(() => true),
    ];
    try {
      await ensure(envFile("A=1\n"));
      await refusal(ensure(envFile("LIVEKIT_API_KEY=devkey\nLIVEKIT_API_SECRET=secret\n")));
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally { for (const s of spies) s.mockRestore(); }
  });

  it("the generated values differ between two files (real randomBytes)", async () => {
    const a = envFile("A=1\n");
    const b = envFile("A=1\n");
    let port = 20000;
    const freePort = async () => ++port;
    await ensureVoiceSecrets({ file: a, random: randomBytes, freePort, now: NOW, env: {}, run: untracked });
    await ensureVoiceSecrets({ file: b, random: randomBytes, freePort, now: NOW, env: {}, run: untracked });
    const va = parseEnv(readFileSync(a, "utf8"));
    const vb = parseEnv(readFileSync(b, "utf8"));
    expect(va.LIVEKIT_API_KEY).not.toBe(vb.LIVEKIT_API_KEY);
    expect(va.LIVEKIT_API_SECRET).not.toBe(vb.LIVEKIT_API_SECRET);
    expect(sttRequestPath(new URL(va.STT_URL!))).not.toBe(sttRequestPath(new URL(vb.STT_URL!)));
  });
});

describe("planSecrets (US-0072)", () => {
  it("never plans one of the key and the secret alone", () => {
    const r = planSecrets("", {}, { random: counterRandom(), freePort: 24680 });
    expect(r.ok && r.add.map((a) => a.name)).toEqual(["LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "STT_URL"]);
    const pair = planSecrets("", { LIVEKIT_API_KEY: KEY, LIVEKIT_API_SECRET: SECRET }, { random: counterRandom(), freePort: 24680 });
    expect(pair.ok && pair.add.map((a) => a.name)).toEqual(["STT_URL"]);
    expect(planSecrets("", { LIVEKIT_API_KEY: KEY }, { random: counterRandom(), freePort: 24680 })).toEqual({ ok: false, code: "half_pair" });
  });

  it("a whitespace-only value counts as empty", () => {
    expect(planSecrets("LIVEKIT_API_KEY=\" \"\n", { LIVEKIT_API_KEY: " " }, { random: counterRandom(), freePort: 24680 })).toEqual({ ok: false, code: "empty_assignment" });
  });

  it("the STT port must come from 20000..32767", () => {
    for (const port of [19999, 32768, 0, 20000.5]) expect(() => planSecrets("", {}, { random: counterRandom(), freePort: port }), String(port)).toThrow(/20000 to 32767/);
    expect(planSecrets("", {}, { random: counterRandom(), freePort: 32767 }).ok).toBe(true);
    expect(planSecrets("", { STT_URL: STT }, { random: counterRandom(), freePort: 0 }).ok).toBe(true); // unused when STT_URL is present
  });

  it("refuses a random source that returns the wrong length", () => {
    expect(() => planSecrets("", {}, { random: () => Buffer.alloc(1), freePort: 24680 })).toThrow(/random/);
  });
});

describe("readPrivateEnv (US-0072)", () => {
  it("returns the text, the parsed values and the file's identity", () => {
    const file = envFile("A=1\nB=\"two\"\n");
    const r = readPrivateEnv(file);
    const st = statSync(file);
    expect(r.text).toBe("A=1\nB=\"two\"\n");
    expect(r.values).toEqual({ A: "1", B: "two" });
    expect(r.id).toEqual({ dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs });
  });

  it("refuses a file over 1 MiB as unreadable", () => {
    const file = envFile("A=" + "x".repeat(1024 * 1024) + "\n");
    expect(() => readPrivateEnv(file)).toThrow(expect.objectContaining({ code: "unreadable" }));
  });
});

describe("sttRequestPath (US-0072)", () => {
  it.each([
    ["http://127.0.0.1:9000/abc/", "/abc"],
    ["http://127.0.0.1:9000/abc", "/abc"],
    ["http://127.0.0.1:9000/", ""],
    ["http://127.0.0.1:9000", ""],
    ["http://127.0.0.1:9000/a/b//", "/a/b"],
  ])("%s gives %j", (u, want) => {
    expect(sttRequestPath(new URL(u))).toBe(want);
  });
});
