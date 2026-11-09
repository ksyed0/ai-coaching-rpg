import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acquireLock, clearState, loadState, openPrivateSubdir, openStateDir, readState, releaseLock, StateDirError, writeState, type VoiceOpsState,
} from "../state.js";

// US-0072 (EPIC-0003 voice A1c, Task 3): the private state directory, `state.json` and the lock. Every test works in a private mkdtemp
// directory; the owner's real ~/.scenecoach is never touched.

let root: string;
let savedTmp: string | undefined;
beforeAll(() => {
  savedTmp = process.env.TMPDIR;
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "acr-voice-ops-state-")));
  process.env.TMPDIR = root; // this file lists directories (AGENTS.md section 8)
});
afterAll(() => {
  if (savedTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmp;
  rmSync(root, { recursive: true, force: true });
});
const newDir = (): string => mkdtempSync(path.join(root, "d-"));
/** A fake repository root beside the state directories (never the real one). */
const fakeRepo = (): string => { const r = newDir(); writeFileSync(path.join(r, "pnpm-workspace.yaml"), "packages: []\n"); return r; };
const mode = (p: string): number => statSync(p).mode & 0o777;
const code = (fn: () => unknown): string | undefined => {
  try { fn(); } catch (e) { if (e instanceof StateDirError) return e.code; throw e; }
  return undefined;
};

const STATE: VoiceOpsState = {
  v: 1, access: "local", nodeIp: "127.0.0.1",
  ports: { stt: 24680, livekit: 7880, tcp: 7881, udp: 7882 }, profiles: [],
  whisper: { pid: 4242, port: 24680, startedAt: 1_700_000_000_000, comm: "whisper-server" },
  compose: { project: "scenecoach-voice", profiles: [] },
};
const LAN_STATE: VoiceOpsState = {
  v: 1, access: "lan", nodeIp: "192.168.1.20",
  ports: { stt: 24680, livekit: 7880, tcp: 7881, udp: 7882, https: 443, livekitTls: 7443 }, profiles: ["lan"],
};

describe("openStateDir (US-0072, A1c Task 3)", () => {
  it("creates the directory and its missing parents 0700", () => {
    const dir = path.join(newDir(), "home", ".scenecoach", "voice");
    openStateDir(dir, { repoRoot: fakeRepo() });
    expect(mode(dir)).toBe(0o700);
    expect(mode(path.dirname(dir))).toBe(0o700);
  });

  it("creates 0700 whatever the umask", () => {
    const dir = path.join(newDir(), "voice");
    const repo = fakeRepo();
    const old = process.umask(0o477);
    try {
      openStateDir(dir, { repoRoot: repo });
      expect(mode(dir)).toBe(0o700);
    } finally { process.umask(old); }
  });

  it("accepts an existing private directory", () => {
    const dir = path.join(newDir(), "voice");
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
    expect(code(() => openStateDir(dir, { repoRoot: fakeRepo() }))).toBeUndefined();
  });

  it("refuses a symlinked state directory", () => {
    const base = newDir();
    const real = path.join(base, "real");
    mkdirSync(real, { mode: 0o700 });
    const link = path.join(base, "voice");
    symlinkSync(real, link);
    expect(code(() => openStateDir(link, { repoRoot: fakeRepo() }))).toBe("symlink");
  });

  it("refuses a 0755 directory and does not change its mode", () => {
    const dir = path.join(newDir(), "voice");
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    expect(code(() => openStateDir(dir, { repoRoot: fakeRepo() }))).toBe("too_open");
    expect(mode(dir)).toBe(0o755);
  });

  it("refuses a file where the directory should be", () => {
    const dir = path.join(newDir(), "voice");
    writeFileSync(dir, "x", { mode: 0o600 });
    expect(code(() => openStateDir(dir, { repoRoot: fakeRepo() }))).toBe("not_directory");
  });

  it("refuses a directory owned by another user (uid injected)", () => {
    const dir = path.join(newDir(), "voice");
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
    const other = (process.getuid?.() ?? 0) + 1;
    expect(code(() => openStateDir(dir, { repoRoot: fakeRepo(), uid: other }))).toBe("not_owner");
  });

  it("refuses VOICE_STATE_DIR inside the repository, and creates nothing there", () => {
    const repo = fakeRepo();
    const dir = path.join(repo, "data", "voice");
    expect(code(() => openStateDir(dir, { repoRoot: repo }))).toBe("inside_repo");
    expect(existsSync(path.join(repo, "data"))).toBe(false);
    expect(code(() => openStateDir(repo, { repoRoot: repo }))).toBe("inside_repo");
  });

  it("VOICE_STATE_DIR inside the repository through a symlink is refused (batch 1 review A F14)", () => {
    const repo = fakeRepo();
    const outside = newDir();
    const link = path.join(outside, "to-repo");
    symlinkSync(repo, link); // a parent of the state directory is a link into the repository
    expect(code(() => openStateDir(path.join(link, "voice"), { repoRoot: repo }))).toBe("inside_repo");
    expect(existsSync(path.join(repo, "voice"))).toBe(false);
  });

  it("the repository root given through a symlink is resolved too", () => {
    const repo = fakeRepo();
    const repoLink = path.join(newDir(), "repo-link");
    symlinkSync(repo, repoLink);
    expect(code(() => openStateDir(path.join(repo, "voice"), { repoRoot: repoLink }))).toBe("inside_repo");
  });

  it("VOICE_STATE_DIR inside the repository in another letter case is refused on darwin (batch 1 review A F14)", () => {
    const repo = fakeRepo();
    const upper = path.join(path.dirname(repo), path.basename(repo).toUpperCase(), "voice");
    expect(code(() => openStateDir(upper, { repoRoot: repo, platform: "darwin" }))).toBe("inside_repo");
  });

  it("another letter case is a different directory on linux (case kept)", () => {
    const base = newDir();
    const repo = path.join(base, "repo");
    mkdirSync(repo);
    const other = path.join(base, "REPO", "voice");
    expect(code(() => openStateDir(other, { repoRoot: repo, platform: "linux" }))).toBeUndefined();
  });

  it("a sibling whose name starts with the repository's is not inside it", () => {
    const base = newDir();
    const repo = path.join(base, "repo");
    mkdirSync(repo);
    expect(code(() => openStateDir(path.join(base, "repo-voice"), { repoRoot: repo }))).toBeUndefined();
  });

  it("the errors are fixed sentences that name no path", () => {
    const repo = fakeRepo();
    for (const dir of [path.join(repo, "x")]) {
      try { openStateDir(dir, { repoRoot: repo }); } catch (e) {
        expect((e as Error).message).not.toContain(repo);
        expect((e as Error).message).toContain("VOICE_STATE_DIR");
      }
    }
  });
});

describe("openPrivateSubdir (US-0072, A1c Task 3)", () => {
  it("creates public/ 0700, empty", () => {
    const dir = path.join(newDir(), "voice");
    openStateDir(dir, { repoRoot: fakeRepo() });
    const p = openPrivateSubdir(dir, "public", { empty: true });
    expect(p).toBe(path.join(dir, "public"));
    expect(mode(p)).toBe(0o700);
  });

  it("refuses a public/ that holds a file (whisper-server would serve it)", () => {
    const dir = path.join(newDir(), "voice");
    openStateDir(dir, { repoRoot: fakeRepo() });
    const p = openPrivateSubdir(dir, "public", { empty: true });
    writeFileSync(path.join(p, "index.html"), "x");
    expect(code(() => openPrivateSubdir(dir, "public", { empty: true }))).toBe("not_empty");
  });

  it("refuses a symlinked or too-open subdirectory", () => {
    const dir = path.join(newDir(), "voice");
    openStateDir(dir, { repoRoot: fakeRepo() });
    symlinkSync(newDir(), path.join(dir, "tmp"));
    expect(code(() => openPrivateSubdir(dir, "tmp"))).toBe("symlink");
    mkdirSync(path.join(dir, "caddy-data"));
    chmodSync(path.join(dir, "caddy-data"), 0o750);
    expect(code(() => openPrivateSubdir(dir, "caddy-data"))).toBe("too_open");
  });

  it("refuses a name that is not one plain path segment", () => {
    const dir = path.join(newDir(), "voice");
    openStateDir(dir, { repoRoot: fakeRepo() });
    for (const bad of ["", ".", "..", "a/b", "../x"]) expect(() => openPrivateSubdir(dir, bad), bad).toThrow();
  });
});

describe("state.json (US-0072, A1c Task 3)", () => {
  const stateDir = (): string => { const d = path.join(newDir(), "voice"); openStateDir(d, { repoRoot: fakeRepo() }); return d; };

  it("writeState then readState round-trips (local and lan)", () => {
    const d = stateDir();
    writeState(d, STATE);
    expect(readState(d)).toEqual(STATE);
    writeState(d, LAN_STATE);
    expect(readState(d)).toEqual(LAN_STATE);
  });

  it("the state file is 0600, whatever the umask, and no temporary file is left", () => {
    const d = stateDir();
    const old = process.umask(0o477);
    try { writeState(d, STATE); } finally { process.umask(old); }
    expect(mode(path.join(d, "state.json"))).toBe(0o600);
    expect(readdirSync(d).sort()).toEqual(["state.json"]);
  });

  it("a missing state reads as none; clearState removes it and is idempotent", () => {
    const d = stateDir();
    expect(loadState(d)).toEqual({ status: "none" });
    expect(readState(d)).toBeNull();
    writeState(d, STATE);
    clearState(d);
    expect(existsSync(path.join(d, "state.json"))).toBe(false);
    expect(() => clearState(d)).not.toThrow();
  });

  const rewrite = (d: string, value: unknown): void => {
    writeFileSync(path.join(d, "state.json"), JSON.stringify(value), { mode: 0o600 });
    chmodSync(path.join(d, "state.json"), 0o600);
  };

  it("an extra key or v: 2 reads as null (unreadable)", () => {
    const d = stateDir();
    rewrite(d, { ...STATE, extra: 1 });
    expect(readState(d)).toBeNull();
    expect(loadState(d)).toEqual({ status: "unreadable" });
    rewrite(d, { ...STATE, v: 2 });
    expect(readState(d)).toBeNull();
    rewrite(d, { ...STATE, whisper: { ...STATE.whisper, extra: true } });
    expect(readState(d)).toBeNull();
    rewrite(d, { ...STATE, ports: { ...STATE.ports, extra: 1 } });
    expect(readState(d)).toBeNull();
  });

  it("a state without nodeIp, ports or profiles reads as null", () => {
    const d = stateDir();
    for (const k of ["nodeIp", "ports", "profiles", "access", "v"] as const) {
      const copy: Record<string, unknown> = { ...STATE };
      delete copy[k];
      rewrite(d, copy);
      expect(readState(d), k).toBeNull();
    }
  });

  it("refuses wrong values field by field", () => {
    const d = stateDir();
    const bad: unknown[] = [
      { ...STATE, access: "wan" }, { ...STATE, nodeIp: "1.2.3" }, { ...STATE, ports: { ...STATE.ports, livekit: 7881 } },
      { ...STATE, ports: { ...STATE.ports, stt: 0 } }, { ...STATE, ports: { ...STATE.ports, stt: 70000 } }, { ...STATE, ports: { ...STATE.ports, https: 1.5 } },
      { ...STATE, profiles: ["prod"] }, { ...STATE, profiles: "lan" }, { ...STATE, whisper: { ...STATE.whisper, pid: 0 } },
      { ...STATE, whisper: { ...STATE.whisper, comm: "" } }, { ...STATE, whisper: { ...STATE.whisper, comm: "a/b" } },
      { ...STATE, whisper: { ...STATE.whisper, startedAt: "x" } }, { ...STATE, compose: { project: "other", profiles: [] } },
      [], null, "x", 1,
    ];
    for (const b of bad) { rewrite(d, b); expect(readState(d), JSON.stringify(b)).toBeNull(); }
    writeFileSync(path.join(d, "state.json"), "{not json", { mode: 0o600 });
    expect(readState(d)).toBeNull();
  });

  it("a state file readable by others, a symlink, or one over 64 KiB is unreadable", () => {
    const d = stateDir();
    writeState(d, STATE);
    chmodSync(path.join(d, "state.json"), 0o644);
    expect(loadState(d)).toEqual({ status: "unreadable" });
    rmSync(path.join(d, "state.json"));
    const elsewhere = path.join(newDir(), "s.json");
    writeFileSync(elsewhere, JSON.stringify(STATE), { mode: 0o600 });
    symlinkSync(elsewhere, path.join(d, "state.json"));
    expect(loadState(d)).toEqual({ status: "unreadable" });
    rmSync(path.join(d, "state.json"));
    writeFileSync(path.join(d, "state.json"), " ".repeat(65 * 1024) + JSON.stringify(STATE), { mode: 0o600 });
    expect(loadState(d)).toEqual({ status: "unreadable" });
  });

  it("writeState refuses a state it could not read back, and writes nothing", () => {
    const d = stateDir();
    expect(() => writeState(d, { ...STATE, nodeIp: "nope" } as VoiceOpsState)).toThrow();
    expect(readdirSync(d)).toEqual([]);
  });

  it("the state holds no secret-shaped field: only the names of its shape", () => {
    const d = stateDir();
    writeState(d, STATE);
    const keys = Object.keys(JSON.parse(readFileSync(path.join(d, "state.json"), "utf8")) as object).sort();
    expect(keys).toEqual(["access", "compose", "nodeIp", "ports", "profiles", "v", "whisper"]);
  });
});

describe("the lock (US-0072, A1c Task 3)", () => {
  const stateDir = (): string => { const d = path.join(newDir(), "voice"); openStateDir(d, { repoRoot: fakeRepo() }); return d; };
  const everyoneAlive = () => true;
  const nobodyAlive = () => false;

  it("acquireLock takes a free lock: a 0600 file holding the pid, no temporary file left", () => {
    const d = stateDir();
    expect(acquireLock(d, 1234, everyoneAlive)).toBe("taken");
    expect(readFileSync(path.join(d, "lock"), "utf8")).toBe("1234\n");
    expect(mode(path.join(d, "lock"))).toBe(0o600);
    expect(readdirSync(d)).toEqual(["lock"]);
  });

  it("a second taker is busy while the holder is alive", () => {
    const d = stateDir();
    expect(acquireLock(d, 1234, everyoneAlive)).toBe("taken");
    expect(acquireLock(d, 5678, everyoneAlive)).toBe("busy");
    expect(readFileSync(path.join(d, "lock"), "utf8")).toBe("1234\n");
  });

  it("a lock of a dead pid is taken over", () => {
    const d = stateDir();
    expect(acquireLock(d, 1234, everyoneAlive)).toBe("taken");
    const asked: number[] = [];
    expect(acquireLock(d, 5678, (pid) => { asked.push(pid); return false; })).toBe("taken");
    expect(asked).toEqual([1234]);
    expect(readFileSync(path.join(d, "lock"), "utf8")).toBe("5678\n");
  });

  it("a lock with no readable pid is taken over", () => {
    const d = stateDir();
    writeFileSync(path.join(d, "lock"), "garbage", { mode: 0o600 });
    expect(acquireLock(d, 5678, nobodyAlive)).toBe("taken");
    expect(readFileSync(path.join(d, "lock"), "utf8")).toBe("5678\n");
  });

  it("a symlinked lock is never followed: busy, the target untouched", () => {
    const d = stateDir();
    const target = path.join(newDir(), "t");
    writeFileSync(target, "1\n");
    symlinkSync(target, path.join(d, "lock"));
    expect(acquireLock(d, 5678, nobodyAlive)).toBe("busy");
    expect(readFileSync(target, "utf8")).toBe("1\n");
  });

  it("releaseLock removes only a lock holding this pid", () => {
    const d = stateDir();
    acquireLock(d, 1234, everyoneAlive);
    releaseLock(d, 5678);
    expect(existsSync(path.join(d, "lock"))).toBe(true);
    releaseLock(d, 1234);
    expect(existsSync(path.join(d, "lock"))).toBe(false);
    expect(() => releaseLock(d, 1234)).not.toThrow();
  });
});
