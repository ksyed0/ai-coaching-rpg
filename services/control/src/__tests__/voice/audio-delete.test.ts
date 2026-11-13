import {
  chmodSync, closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync,
  type Dirent,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isDeletedLine, isLowerHex } from "@acr/speech/protocol";
import { AudioCatalog, readSegmentIndex } from "../../voice/audio-catalog.js";
import { deleteAudio, type DeleteOutcome, type DeleteOptions, type DeleteScope } from "../../voice/audio-delete.js";
import type { AuditEvent } from "../../voice/audit-log.js";
import { IdentityMutex, acquireStoreLock, type StoreLockResult } from "../../voice/store-lock.js";

/**
 * US-0075 (A2b-1b, spec section 4): the audited per-identity facilitator delete, against a real temp audio directory with real files,
 * the real identity mutex and store lock, a recording fake audit and a fake live predicate.
 */
const id = (n: number): string => n.toString(16).padStart(32, "0");
const A = id(0xa), B = id(0xb), C = id(0xc);
const S = "session-1", OTHER = "session-2";
const BY = "kamal-console";
const NOW = 5_000;
const isRoot = process.getuid?.() === 0;

let root: string, audioDir: string, outside: string;
let mutex: IdentityMutex;
let live: boolean;
let held: StoreLockResult[];

type Snapshot = { identity: string; event: AuditEvent; indexes: Record<string, string>; wavs: string[] };
let auditCalls: Snapshot[];
let auditResult: boolean;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "acr-delete-"));
  audioDir = path.join(root, "audio");
  outside = path.join(root, "outside");
  mkdirSync(audioDir, { mode: 0o700 });
  mkdirSync(outside, { mode: 0o700 });
  mutex = new IdentityMutex();
  live = false;
  held = [];
  auditCalls = [];
  auditResult = true;
});
afterEach(() => {
  for (const r of held.splice(0)) if (r.kind === "held") r.release();
  try { chmodSync(path.join(audioDir, A, "r"), 0o700); } catch { /* not every test changes it */ }
  rmSync(root, { recursive: true, force: true });
});

const segLine = (segment: string, participantId = "p1", startMs = 0) =>
  ({ v: 1, kind: "segment", segment, participantId, startMs, endMs: startMs + 500, status: "transcribed", raw: "secret" });
const jsonl = (lines: unknown[]): string => lines.map((l) => `${JSON.stringify(l)}\n`).join("");

function mkIdentity(identity: string, sessionId: string | null): string {
  const dir = path.join(audioDir, identity);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (sessionId !== null) writeFileSync(path.join(dir, "session.json"), JSON.stringify({ v: 1, sessionId }), { mode: 0o600 });
  return dir;
}
/** `<audioDir>/<identity>/<role>` with an index of `lines` and a WAV per segment line. */
function mkRole(identity: string, role: string, lines: Array<ReturnType<typeof segLine>>, extraWavs: string[] = []): string {
  const dir = path.join(audioDir, identity, role);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, "index.jsonl"), jsonl(lines), { mode: 0o600 });
  for (const l of lines) writeFileSync(path.join(dir, `${l.segment}.wav`), Buffer.alloc(64, 1), { mode: 0o600 });
  for (const w of extraWavs) writeFileSync(path.join(dir, `${w}.wav`), Buffer.alloc(64, 2), { mode: 0o600 });
  return dir;
}
const wav = (identity: string, role: string, seg: string) => path.join(audioDir, identity, role, `${seg}.wav`);
const indexText = (identity: string, role: string) => readFileSync(path.join(audioDir, identity, role, "index.jsonl"), "utf8");
async function deletedIn(identity: string, role: string): Promise<string[]> {
  const r = await readSegmentIndex(audioDir, identity, role);
  if (r.kind !== "trusted") throw new Error("untrusted");
  return [...r.index].filter(([, v]) => v.deleted).map(([k]) => k).sort();
}
function snapshot(): Pick<Snapshot, "indexes" | "wavs"> {
  const indexes: Record<string, string> = {};
  const wavs: string[] = [];
  // Open-then-check (CodeQL js/file-system-race): the directory listing gives each entry's type, and an index file is opened
  // without following a link and read through the descriptor, never by a path that was probed first.
  const walk = (dir: string, rel: string) => {
    let entries: Dirent[];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const n = e.name;
      const p = path.join(dir, n);
      const r = rel === "" ? n : `${rel}/${n}`;
      if (e.isDirectory()) walk(p, r);
      else if (n === "index.jsonl") {
        let fd: number;
        try { fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { continue; }
        try { if (fstatSync(fd).isFile()) indexes[r] = readFileSync(fd, "utf8"); } finally { closeSync(fd); }
      } else if (n.endsWith(".wav")) wavs.push(r);
    }
  };
  walk(audioDir, "");
  return { indexes, wavs: wavs.sort() };
}

const audit = {
  append: vi.fn(async (identity: string, event: AuditEvent): Promise<boolean> => {
    auditCalls.push({ identity, event, ...snapshot() });
    return auditResult;
  }),
};

function opts(o: Partial<DeleteOptions> = {}): DeleteOptions {
  return {
    audioDir, catalog: new AudioCatalog({ audioDir }), audit, mutex, isLive: () => live, now: () => NOW, ...o,
  };
}
const run = (scope: DeleteScope = { kind: "session" }, reason: "facilitator" | "participant_request" = "facilitator", o: Partial<DeleteOptions> = {}, sessionId = S) =>
  deleteAudio(opts(o), sessionId, scope, reason, BY);
const done = (identity: string, deleted: number) => ({ identity, deleted, state: "done" as const });

beforeEach(() => { audit.append.mockClear(); });

describe("deleteAudio: scopes", () => {
  it("session scope marks and unlinks every segment of every role, and audits once with segments and a 16-hex op", async () => {
    mkIdentity(A, S);
    mkRole(A, "coach", [segLine("c1"), segLine("c2", "p2")]);
    mkRole(A, "learner", [segLine("l1")]);
    const r = await run();
    expect(r).toStrictEqual<DeleteOutcome>({ live: false, deleted: 3, gone: [], identities: [done(A, 3)], pending: [] });
    expect(await deletedIn(A, "coach")).toEqual(["c1", "c2"]);
    expect(await deletedIn(A, "learner")).toEqual(["l1"]);
    for (const [role, seg] of [["coach", "c1"], ["coach", "c2"], ["learner", "l1"]] as const) expect(existsSync(wav(A, role, seg))).toBe(false);
    expect(audit.append).toHaveBeenCalledTimes(1);
    const e = auditCalls[0]!.event as Extract<AuditEvent, { type: "audio.deleted" }>;
    expect(e).toMatchObject({ type: "audio.deleted", scope: { kind: "session" }, reason: "facilitator", by: BY, segments: 3 });
    expect(isLowerHex(e.op, 16)).toBe(true);
    // Every mark carries the audit line's op and the injected clock.
    for (const role of ["coach", "learner"]) {
      const marks = indexText(A, role).split("\n").filter((l) => l !== "").map((l) => JSON.parse(l)).filter(isDeletedLine);
      for (const m of marks) expect(m).toMatchObject({ op: e.op, ts: NOW });
    }
    // The folder, the index and the marker stay (spec: the session scope keeps them until expiry).
    expect(existsSync(path.join(audioDir, A, "session.json"))).toBe(true);
  });

  it("role scope marks only that role and leaves the other role playable", async () => {
    mkIdentity(A, S);
    mkRole(A, "coach", [segLine("c1")]);
    mkRole(A, "learner", [segLine("l1")]);
    const r = await run({ kind: "role", role: "coach" });
    expect(r).toStrictEqual({ live: false, deleted: 1, gone: [], identities: [done(A, 1)], pending: [] });
    expect(await deletedIn(A, "coach")).toEqual(["c1"]);
    expect(await deletedIn(A, "learner")).toEqual([]);
    expect(existsSync(wav(A, "coach", "c1"))).toBe(false);
    expect(existsSync(wav(A, "learner", "l1"))).toBe(true);
    expect(auditCalls[0]!.event).toMatchObject({ scope: { kind: "role", role: "coach" }, segments: 1 });
  });

  it("participant scope matches participantId across every role and every identity, and leaves the others playable", async () => {
    mkIdentity(A, S);
    mkRole(A, "coach", [segLine("c1", "p1"), segLine("c2", "p2")]);
    mkRole(A, "learner", [segLine("l1", "p1")]);
    mkIdentity(B, S);
    mkRole(B, "coach", [segLine("b1", "p1"), segLine("b2", "p2")]);
    const r = await run({ kind: "participant", participant: "p1" });
    expect(r).toStrictEqual({ live: false, deleted: 3, gone: [], identities: [done(A, 2), done(B, 1)], pending: [] });
    expect(await deletedIn(A, "coach")).toEqual(["c1"]);
    expect(await deletedIn(A, "learner")).toEqual(["l1"]);
    expect(await deletedIn(B, "coach")).toEqual(["b1"]);
    expect(existsSync(wav(A, "coach", "c2"))).toBe(true);
    expect(existsSync(wav(B, "coach", "b2"))).toBe(true);
    const ops = auditCalls.map((c) => (c.event as { op?: string }).op);
    expect(ops[0]).not.toBe(ops[1]); // one op per identity per request
  });

  it("a participant id with spaces and non-ASCII, 128 characters long, is matched as a string and never used as a path", async () => {
    const p = `Zoë Ñandú 日本 ${"é".repeat(128)}`.slice(0, 128);
    expect(p.length).toBe(128);
    mkIdentity(A, S);
    mkRole(A, "coach", [segLine("c1", p), segLine("c2", "p2")]);
    const r = await run({ kind: "participant", participant: p }, "participant_request");
    expect(r).toStrictEqual({ live: false, deleted: 1, gone: [], identities: [done(A, 1)], pending: [] });
    expect(await deletedIn(A, "coach")).toEqual(["c1"]);
    expect(auditCalls[0]!.event).toMatchObject({ scope: { kind: "participant", participant: p }, reason: "participant_request", segments: 1 });
  });

  it("a participant id that looks like a path matches nothing and touches no other folder", async () => {
    mkIdentity(A, S);
    mkRole(A, "coach", [segLine("c1")]);
    const r = await run({ kind: "participant", participant: "../coach" });
    expect(r).toStrictEqual({ live: false, deleted: 0, gone: [], identities: [done(A, 0)], pending: [] });
    expect(audit.append).not.toHaveBeenCalled();
  });

  it("a retry skips segments already marked: deleted 0 and no second audit line for a facilitator", async () => {
    mkIdentity(A, S);
    mkRole(A, "coach", [segLine("c1")]);
    await run();
    audit.append.mockClear();
    const before = indexText(A, "coach");
    expect(await run()).toStrictEqual({ live: false, deleted: 0, gone: [], identities: [done(A, 0)], pending: [] });
    expect(audit.append).not.toHaveBeenCalled();
    expect(indexText(A, "coach")).toBe(before);
  });

  it("returns null when the catalog finds no identity, before any audit or live check", async () => {
    const isLive = vi.fn(() => false);
    expect(await run(undefined, undefined, { isLive })).toBeNull();
    expect(await run(undefined, undefined, { isLive }, "not a valid id/..")).toBeNull();
    expect(audit.append).not.toHaveBeenCalled();
  });

  it("the outcome never carries a path", async () => {
    mkIdentity(A, S);
    mkRole(A, "coach", [segLine("c1")]);
    const r = await run();
    expect(JSON.stringify(r)).not.toContain(root);
    expect(JSON.stringify(r)).not.toContain("coach");
  });
});

describe("deleteAudio: the audit comes first", () => {
  it("the audit line is appended while every index is untouched and every WAV still present", async () => {
    mkIdentity(A, S);
    mkRole(A, "coach", [segLine("c1"), segLine("c2")]);
    const before = snapshot();
    await run();
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]!.indexes).toStrictEqual(before.indexes);
    expect(auditCalls[0]!.wavs).toStrictEqual(before.wavs);
    expect(snapshot().wavs).toEqual([]);
  });

  it("an audit that returns false leaves files and index untouched and the identity pending audit_unavailable", async () => {
    mkIdentity(A, S);
    mkRole(A, "coach", [segLine("c1")]);
    auditResult = false;
    const before = snapshot();
    const r = await run();
    expect(r).toStrictEqual({ live: false, deleted: 0, gone: [], identities: [], pending: [{ identity: A, reason: "audit_unavailable" }] });
    expect(snapshot()).toStrictEqual(before);
    // The lock and the mutex were released.
    const probe = mutex.tryTake(A);
    expect(probe).toBeTypeOf("function");
    probe!();
  });

  it("participant_request with nothing in scope writes one segments: 0 line for an identity that holds audio", async () => {
    mkIdentity(A, S);
    mkRole(A, "coach", [segLine("c1", "p2")]);
    const r = await run({ kind: "participant", participant: "p1" }, "participant_request");
    expect(r).toStrictEqual({ live: false, deleted: 0, gone: [], identities: [done(A, 0)], pending: [] });
    expect(audit.append).toHaveBeenCalledTimes(1);
    expect(auditCalls[0]!.event).toMatchObject({ reason: "participant_request", segments: 0 });
    expect(isLowerHex((auditCalls[0]!.event as { op?: string }).op, 16)).toBe(true);
    expect(await deletedIn(A, "coach")).toEqual([]);
  });

  it("participant_request: an identity holding only a WAV with no index line still holds audio; one holding nothing writes nothing", async () => {
    mkIdentity(A, S);
    mkRole(A, "coach", [], ["orphan"]);
    mkIdentity(B, S); // no role folder at all
    const r = await run({ kind: "role", role: "learner" }, "participant_request");
    expect(r).toStrictEqual({ live: false, deleted: 0, gone: [], identities: [done(A, 0), done(B, 0)], pending: [] });
    expect(auditCalls.map((c) => c.identity)).toEqual([A]);
    expect(auditCalls[0]!.event).toMatchObject({ segments: 0 });
  });

  it("participant_request with segments: 0 and a failing audit is pending audit_unavailable", async () => {
    mkIdentity(A, S);
    mkRole(A, "coach", [segLine("c1", "p2")]);
    auditResult = false;
    const r = await run({ kind: "participant", participant: "p1" }, "participant_request");
    expect(r!.pending).toStrictEqual([{ identity: A, reason: "audit_unavailable" }]);
  });

  it("facilitator with nothing in scope writes no audit line and returns deleted: 0", async () => {
    mkIdentity(A, S);
    mkRole(A, "coach", [segLine("c1", "p2")]);
    const r = await run({ kind: "participant", participant: "p1" }, "facilitator");
    expect(r).toStrictEqual({ live: false, deleted: 0, gone: [], identities: [done(A, 0)], pending: [] });
    expect(audit.append).not.toHaveBeenCalled();
  });
});

describe("deleteAudio: live", () => {
  it("isLive true returns live: true with nothing written", async () => {
    mkIdentity(A, S);
    mkRole(A, "coach", [segLine("c1")]);
    live = true;
    const before = snapshot();
    expect(await run()).toStrictEqual({ live: true, deleted: 0, gone: [], identities: [], pending: [] });
    expect(snapshot()).toStrictEqual(before);
    expect(audit.append).not.toHaveBeenCalled();
  });

  it("an isLive that throws is taken as live", async () => {
    mkIdentity(A, S);
    mkRole(A, "coach", [segLine("c1")]);
    const r = await run(undefined, undefined, { isLive: () => { throw new Error("boom"); } });
    expect(r!.live).toBe(true);
    expect(audit.append).not.toHaveBeenCalled();
  });

  it("isLive is asked again before each identity: going live after the first stops with the first done", async () => {
    mkIdentity(A, S); mkRole(A, "coach", [segLine("a1")]);
    mkIdentity(B, S); mkRole(B, "coach", [segLine("b1")]);
    let calls = 0;
    const isLive = vi.fn(() => { calls++; return calls > 2; }); // before the first, before A: no; before B: yes
    const r = await run(undefined, undefined, { isLive });
    expect(r).toStrictEqual({ live: true, deleted: 1, gone: [], identities: [done(A, 1)], pending: [] });
    expect(existsSync(wav(B, "coach", "b1"))).toBe(true);
    expect(auditCalls.map((c) => c.identity)).toEqual([A]);
  });

  it("locked_other (another acquirer holds the store lock) stops the whole request as live with the work done so far", async () => {
    mkIdentity(A, S); mkRole(A, "coach", [segLine("a1")]);
    mkIdentity(B, S); mkRole(B, "coach", [segLine("b1")]);
    mkIdentity(C, S); mkRole(C, "coach", [segLine("c1")]);
    const other = acquireStoreLock(audioDir, B, new IdentityMutex()); // a worker's hold
    held.push(other);
    expect(other.kind).toBe("held");
    const r = await run();
    expect(r).toStrictEqual({ live: true, deleted: 1, gone: [], identities: [done(A, 1)], pending: [] });
    expect(existsSync(wav(B, "coach", "b1"))).toBe(true);
    expect(existsSync(wav(C, "coach", "c1"))).toBe(true); // nothing after the live signal
    expect(auditCalls.map((c) => c.identity)).toEqual([A]);
  });

  it("locked_other on the only identity: live: true and nothing written", async () => {
    mkIdentity(A, S); mkRole(A, "coach", [segLine("a1")]);
    held.push(acquireStoreLock(audioDir, A, new IdentityMutex()));
    const before = snapshot();
    expect(await run()).toStrictEqual({ live: true, deleted: 0, gone: [], identities: [], pending: [] });
    expect(snapshot()).toStrictEqual(before);
    expect(audit.append).not.toHaveBeenCalled();
  });
});

describe("deleteAudio: busy and retry", () => {
  it("the mutex held (as by the sweep) gives pending busy and no audit line", async () => {
    mkIdentity(A, S); mkRole(A, "coach", [segLine("a1")]);
    const rel = mutex.tryTake(A)!;
    const before = snapshot();
    expect(await run()).toStrictEqual({ live: false, deleted: 0, gone: [], identities: [], pending: [{ identity: A, reason: "busy" }] });
    expect(snapshot()).toStrictEqual(before);
    expect(audit.append).not.toHaveBeenCalled();
    rel();
  });

  it("two identities, the second busy: the first done, the second pending; a retry deletes only the remainder", async () => {
    mkIdentity(A, S); mkRole(A, "coach", [segLine("a1")]);
    mkIdentity(B, S); mkRole(B, "coach", [segLine("b1")]);
    const rel = mutex.tryTake(B)!;
    expect(await run()).toStrictEqual({ live: false, deleted: 1, gone: [], identities: [done(A, 1)], pending: [{ identity: B, reason: "busy" }] });
    expect(existsSync(wav(B, "coach", "b1"))).toBe(true);
    rel();
    expect(await run()).toStrictEqual({ live: false, deleted: 1, gone: [], identities: [done(A, 0), done(B, 1)], pending: [] });
    expect(auditCalls.map((c) => c.identity)).toEqual([A, B]); // no second line for A
    expect(existsSync(wav(B, "coach", "b1"))).toBe(false);
  });

  it("locked_here and error from the acquirer give pending busy", async () => {
    mkIdentity(A, S); mkRole(A, "coach", [segLine("a1")]);
    for (const kind of ["locked_here", "error"] as const) {
      const r = await run(undefined, undefined, { acquireLock: () => ({ kind }) });
      expect(r!.pending).toStrictEqual([{ identity: A, reason: "busy" }]);
    }
    expect(audit.append).not.toHaveBeenCalled();
  });
});

describe("deleteAudio: store_unsafe", () => {
  it("an untrusted index (index.jsonl a symlink) gives pending store_unsafe and nothing changes", async () => {
    mkIdentity(A, S);
    const dir = mkRole(A, "coach", []);
    rmSync(path.join(dir, "index.jsonl"));
    const target = path.join(outside, "index.jsonl");
    writeFileSync(target, jsonl([segLine("c1")]), { mode: 0o600 });
    writeFileSync(path.join(dir, "c1.wav"), Buffer.alloc(64), { mode: 0o600 });
    symlinkSync(target, path.join(dir, "index.jsonl"));
    const before = snapshot();
    const targetBefore = readFileSync(target, "utf8");
    expect(await run()).toStrictEqual({ live: false, deleted: 0, gone: [], identities: [], pending: [{ identity: A, reason: "store_unsafe" }] });
    expect(snapshot()).toStrictEqual(before);
    expect(readFileSync(target, "utf8")).toBe(targetBefore);
    expect(existsSync(path.join(dir, "c1.wav"))).toBe(true);
    expect(audit.append).not.toHaveBeenCalled();
  });

  it("a lock whose assertHeld is false before the index write gives store_unsafe and writes no index line", async () => {
    mkIdentity(A, S);
    mkRole(A, "coach", [segLine("c1")]);
    const before = indexText(A, "coach");
    const acquireLock: DeleteOptions["acquireLock"] = (dir, ident, m) => {
      const r = acquireStoreLock(dir, ident, m);
      if (r.kind !== "held") return r;
      return { ...r, assertHeld: async () => false };
    };
    const r = await run(undefined, undefined, { acquireLock });
    expect(r).toStrictEqual({ live: false, deleted: 0, gone: [], identities: [], pending: [{ identity: A, reason: "store_unsafe" }] });
    expect(indexText(A, "coach")).toBe(before);
    expect(existsSync(wav(A, "coach", "c1"))).toBe(true);
    expect(audit.append).toHaveBeenCalledTimes(1); // the documented residual: the audit line is already written
    const probe = mutex.tryTake(A); // released on this path too
    expect(probe).toBeTypeOf("function");
    probe!();
  });

  it("a lock lost between the marks and the unlinks gives store_unsafe: the marks hold, the WAVs are left to the sweep", async () => {
    mkIdentity(A, S);
    mkRole(A, "coach", [segLine("c1")]);
    let n = 0;
    const acquireLock: DeleteOptions["acquireLock"] = (dir, ident, m) => {
      const r = acquireStoreLock(dir, ident, m);
      if (r.kind !== "held") return r;
      return { ...r, assertHeld: async () => ++n === 1 };
    };
    const r = await run(undefined, undefined, { acquireLock });
    expect(r!.pending).toStrictEqual([{ identity: A, reason: "store_unsafe" }]);
    expect(await deletedIn(A, "coach")).toEqual(["c1"]);
    expect(existsSync(wav(A, "coach", "c1"))).toBe(true);
  });

  it("a lock file that is a symlink gives pending store_unsafe, not busy", async () => {
    mkIdentity(A, S); mkRole(A, "coach", [segLine("c1")]);
    symlinkSync(path.join(outside, "nowhere"), path.join(audioDir, `${A}.store.lock`));
    expect((await run())!.pending).toStrictEqual([{ identity: A, reason: "store_unsafe" }]);
    expect(audit.append).not.toHaveBeenCalled();
  });

  it("a role folder that is a symlink gives store_unsafe for the session scope and nothing is touched for that identity", async () => {
    mkIdentity(A, S);
    mkRole(A, "coach", [segLine("c1")]);
    mkdirSync(path.join(outside, "learner"), { mode: 0o700 });
    writeFileSync(path.join(outside, "learner", "index.jsonl"), jsonl([segLine("x1")]), { mode: 0o600 });
    writeFileSync(path.join(outside, "learner", "x1.wav"), Buffer.alloc(64), { mode: 0o600 });
    symlinkSync(path.join(outside, "learner"), path.join(audioDir, A, "learner"));
    const before = snapshot();
    expect(await run()).toStrictEqual({ live: false, deleted: 0, gone: [], identities: [], pending: [{ identity: A, reason: "store_unsafe" }] });
    expect(snapshot()).toStrictEqual(before);
    expect(existsSync(path.join(outside, "learner", "x1.wav"))).toBe(true);
    expect(audit.append).not.toHaveBeenCalled();
  });

  it("a linked role folder blocks the participant scope too, and a role scope only when it is that role", async () => {
    mkIdentity(A, S);
    mkRole(A, "coach", [segLine("c1")]);
    mkdirSync(path.join(outside, "learner"), { mode: 0o700 });
    symlinkSync(path.join(outside, "learner"), path.join(audioDir, A, "learner"));
    expect((await run({ kind: "participant", participant: "p1" }))!.pending).toStrictEqual([{ identity: A, reason: "store_unsafe" }]);
    expect((await run({ kind: "role", role: "learner" }))!.pending).toStrictEqual([{ identity: A, reason: "store_unsafe" }]);
    expect(audit.append).not.toHaveBeenCalled();
    expect(await run({ kind: "role", role: "coach" })).toStrictEqual({ live: false, deleted: 1, gone: [], identities: [done(A, 1)], pending: [] });
  });

  it("a role entry that is a regular file under the identity folder is store_unsafe for the session scope, never silently skipped", async () => {
    mkIdentity(A, S);
    mkRole(A, "coach", [segLine("c1")]);
    writeFileSync(path.join(audioDir, A, "stray"), "x", { mode: 0o600 });
    expect((await run())!.pending).toStrictEqual([{ identity: A, reason: "store_unsafe" }]);
    expect(existsSync(wav(A, "coach", "c1"))).toBe(true);
  });
});

describe("deleteAudio: the files themselves", () => {
  it("a torn last index line is terminated before the marks", async () => {
    mkIdentity(A, S);
    const dir = mkRole(A, "coach", [segLine("c1")]);
    writeFileSync(path.join(dir, "index.jsonl"), `${jsonl([segLine("c1")])}{"v":1,"kind":"seg`, { mode: 0o600 });
    expect((await run())!.deleted).toBe(1);
    const text = indexText(A, "coach");
    expect(text).toContain(`{"v":1,"kind":"seg\n{"v":1,"kind":"deleted","segment":"c1"`);
    expect(await deletedIn(A, "coach")).toEqual(["c1"]);
  });

  it("a role folder swapped for a symlink before the unlink is not followed; the identity still counts done", async () => {
    mkIdentity(A, S);
    mkRole(A, "coach", [segLine("c1")]);
    mkdirSync(path.join(outside, "coach"), { mode: 0o700 });
    writeFileSync(path.join(outside, "coach", "c1.wav"), Buffer.alloc(64), { mode: 0o600 });
    let n = 0;
    const acquireLock: DeleteOptions["acquireLock"] = (dir, ident, m) => {
      const r = acquireStoreLock(dir, ident, m);
      if (r.kind !== "held") return r;
      return {
        ...r,
        assertHeld: async () => {
          if (++n === 2) { // after the marks, before the unlinks
            renameSync(path.join(audioDir, A, "coach"), path.join(root, "moved"));
            symlinkSync(path.join(outside, "coach"), path.join(audioDir, A, "coach"));
          }
          return r.assertHeld();
        },
      };
    };
    const r = await run(undefined, undefined, { acquireLock });
    expect(r).toStrictEqual({ live: false, deleted: 1, gone: [], identities: [done(A, 1)], pending: [] });
    expect(existsSync(path.join(outside, "coach", "c1.wav"))).toBe(true); // the link's target was never touched
    expect(existsSync(path.join(root, "moved", "c1.wav"))).toBe(true); // the real (moved) folder: marked, not unlinked
    expect(readFileSync(path.join(root, "moved", "index.jsonl"), "utf8")).toContain(`"kind":"deleted"`);
  });

  it("a role folder swapped for ANOTHER real folder before the unlink: nothing in the new folder is removed", async () => {
    mkIdentity(A, S);
    mkRole(A, "coach", [segLine("c1")]);
    let n = 0;
    const acquireLock: DeleteOptions["acquireLock"] = (dir, ident, m) => {
      const r = acquireStoreLock(dir, ident, m);
      if (r.kind !== "held") return r;
      return {
        ...r,
        assertHeld: async () => {
          if (++n === 2) {
            renameSync(path.join(audioDir, A, "coach"), path.join(root, "moved"));
            mkdirSync(path.join(audioDir, A, "coach"), { mode: 0o700 });
            writeFileSync(path.join(audioDir, A, "coach", "c1.wav"), Buffer.alloc(64), { mode: 0o600 });
          }
          return r.assertHeld();
        },
      };
    };
    expect((await run(undefined, undefined, { acquireLock }))!.identities).toStrictEqual([done(A, 1)]);
    expect(existsSync(wav(A, "coach", "c1"))).toBe(true);
  });

  it("a WAV that is a symlink is not followed: the target stays, the segment is still marked", async () => {
    mkIdentity(A, S);
    const dir = mkRole(A, "coach", [segLine("c1")]);
    rmSync(path.join(dir, "c1.wav"));
    writeFileSync(path.join(outside, "target.wav"), Buffer.alloc(64), { mode: 0o600 });
    symlinkSync(path.join(outside, "target.wav"), path.join(dir, "c1.wav"));
    expect((await run())!.deleted).toBe(1);
    expect(existsSync(path.join(outside, "target.wav"))).toBe(true);
    expect(await deletedIn(A, "coach")).toEqual(["c1"]);
  });

  it("a WAV with nlink 2 is marked and our name unlinked; the other name is left", async () => {
    mkIdentity(A, S);
    mkRole(A, "coach", [segLine("c1")]);
    linkSync(wav(A, "coach", "c1"), path.join(outside, "hard.wav"));
    expect(statSync(wav(A, "coach", "c1")).nlink).toBe(2);
    expect(await run()).toStrictEqual({ live: false, deleted: 1, gone: [], identities: [done(A, 1)], pending: [] });
    expect(existsSync(wav(A, "coach", "c1"))).toBe(false);
    expect(existsSync(path.join(outside, "hard.wav"))).toBe(true);
    expect(await deletedIn(A, "coach")).toEqual(["c1"]);
  });

  it("a segment whose WAV is already gone is still marked and counted", async () => {
    mkIdentity(A, S);
    mkRole(A, "coach", [segLine("c1")]);
    rmSync(wav(A, "coach", "c1"));
    expect((await run())!.deleted).toBe(1);
    expect(await deletedIn(A, "coach")).toEqual(["c1"]);
  });

  it("all marks for a role go in one write", async () => {
    mkIdentity(A, S);
    mkRole(A, "coach", [segLine("c1"), segLine("c2"), segLine("c3")]);
    const before = indexText(A, "coach");
    await run();
    const added = indexText(A, "coach").slice(before.length).split("\n").filter((l) => l !== "");
    expect(added.map((l) => JSON.parse(l).segment)).toEqual(["c1", "c2", "c3"]);
  });
});

describe("deleteAudio: which folders", () => {
  it("a fallback-only session (a pre-marker folder, no session.json) is deleted, not skipped", async () => {
    mkIdentity(A, null);
    mkRole(A, "coach", [segLine("c1")]);
    const catalog = new AudioCatalog({ audioDir, fallbackIdentity: async () => A });
    expect(await run(undefined, undefined, { catalog })).toStrictEqual({ live: false, deleted: 1, gone: [], identities: [done(A, 1)], pending: [] });
    expect(existsSync(wav(A, "coach", "c1"))).toBe(false);
    expect(await deletedIn(A, "coach")).toEqual(["c1"]);
  });

  it("a folder that vanished between find and the lock is listed in gone, and the others are still done", async () => {
    mkIdentity(A, S); mkRole(A, "coach", [segLine("a1")]);
    mkIdentity(B, S); mkRole(B, "coach", [segLine("b1")]);
    const real = new AudioCatalog({ audioDir });
    const catalog = { find: async (s: string) => { const r = await real.find(s); rmSync(path.join(audioDir, A), { recursive: true }); return r; } };
    expect(await run(undefined, undefined, { catalog })).toStrictEqual({ live: false, deleted: 1, gone: [A], identities: [done(B, 1)], pending: [] });
  });

  it("a folder whose marker now names another session is gone, and nothing in it is touched", async () => {
    mkIdentity(A, S); mkRole(A, "coach", [segLine("a1")]);
    const real = new AudioCatalog({ audioDir });
    const catalog = { find: async (s: string) => { const r = await real.find(s); mkIdentity(A, OTHER); return r; } };
    expect(await run(undefined, undefined, { catalog })).toStrictEqual({ live: false, deleted: 0, gone: [A], identities: [], pending: [] });
    expect(existsSync(wav(A, "coach", "a1"))).toBe(true);
    expect(audit.append).not.toHaveBeenCalled();
  });

  describe("a recheck that cannot tell is pending store_unsafe, never gone (the audio may still be on disk)", () => {
    const unsafeOutcome = { live: false, deleted: 0, gone: [], identities: [], pending: [{ identity: A, reason: "store_unsafe" }] };

    it("the root made group-writable after find: pending store_unsafe, nothing audited, marked or removed", async () => {
      mkIdentity(A, S); mkRole(A, "coach", [segLine("a1")]);
      const before = indexText(A, "coach");
      const catalog = { find: async () => { chmodSync(audioDir, 0o770); return [A]; } };
      try {
        expect(await run(undefined, undefined, { catalog })).toStrictEqual(unsafeOutcome);
      } finally { chmodSync(audioDir, 0o700); }
      expect(audit.append).not.toHaveBeenCalled();
      expect(indexText(A, "coach")).toBe(before);
      expect(existsSync(wav(A, "coach", "a1"))).toBe(true);
    });

    it("the identity folder replaced by a link to a copy with a valid marker: pending store_unsafe, the link target untouched", async () => {
      mkIdentity(A, S); mkRole(A, "coach", [segLine("a1")]);
      const copy = path.join(outside, "copy");
      const catalog = { find: async () => { renameSync(path.join(audioDir, A), copy); symlinkSync(copy, path.join(audioDir, A)); return [A]; } };
      expect(await run(undefined, undefined, { catalog })).toStrictEqual(unsafeOutcome);
      expect(audit.append).not.toHaveBeenCalled();
      expect(readFileSync(path.join(copy, "coach", "index.jsonl"), "utf8")).toBe(jsonl([segLine("a1")]));
      expect(existsSync(path.join(copy, "coach", "a1.wav"))).toBe(true);
      expect(lstatSync(path.join(audioDir, A)).isSymbolicLink()).toBe(true);
    });

    it("the identity path replaced by a regular file: pending store_unsafe, nothing audited", async () => {
      mkIdentity(A, S); mkRole(A, "coach", [segLine("a1")]);
      const aside = path.join(outside, "aside");
      const catalog = { find: async () => { renameSync(path.join(audioDir, A), aside); writeFileSync(path.join(audioDir, A), "x"); return [A]; } };
      expect(await run(undefined, undefined, { catalog })).toStrictEqual(unsafeOutcome);
      expect(audit.append).not.toHaveBeenCalled();
      expect(readFileSync(path.join(aside, "coach", "index.jsonl"), "utf8")).toBe(jsonl([segLine("a1")]));
      expect(existsSync(path.join(aside, "coach", "a1.wav"))).toBe(true);
      expect(readFileSync(path.join(audioDir, A), "utf8")).toBe("x");
    });
  });

  it("everything gone is still a normal outcome (not null)", async () => {
    const catalog = { find: async () => [A] };
    expect(await run(undefined, undefined, { catalog })).toStrictEqual({ live: false, deleted: 0, gone: [A], identities: [], pending: [] });
  });

  it("identities are processed in the catalog's order, one at a time", async () => {
    mkIdentity(A, S); mkRole(A, "coach", [segLine("a1")]);
    mkIdentity(B, S); mkRole(B, "coach", [segLine("b1")]);
    let inFlight = 0, maxInFlight = 0;
    const slow = {
      append: vi.fn(async (identity: string, event: AuditEvent) => {
        inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        auditCalls.push({ identity, event, ...snapshot() });
        inFlight--;
        return true;
      }),
    };
    await run(undefined, undefined, { audit: slow });
    expect(auditCalls.map((c) => c.identity)).toEqual([A, B]);
    expect(maxInFlight).toBe(1);
  });

  it("op comes from the randomOp seam when given", async () => {
    mkIdentity(A, S); mkRole(A, "coach", [segLine("a1")]);
    await run(undefined, undefined, { randomOp: () => "00112233445566ff" });
    expect(auditCalls[0]!.event).toMatchObject({ op: "00112233445566ff" });
    expect(indexText(A, "coach")).toContain(`"op":"00112233445566ff"`);
  });
});

describe.skipIf(isRoot)("deleteAudio: failures made with chmod (root ignores chmod; runs as a normal user, as CI does)", () => {
  it("an index write that throws gives pending store_unsafe and leaves every WAV in place", async () => {
    mkIdentity(A, S);
    const dir = mkRole(A, "r", [segLine("c1"), segLine("c2")]);
    chmodSync(path.join(dir, "index.jsonl"), 0o400); // readable (the plan reads it), not writable (the mark's O_RDWR open fails)
    const r = await run();
    expect(r).toStrictEqual({ live: false, deleted: 0, gone: [], identities: [], pending: [{ identity: A, reason: "store_unsafe" }] });
    expect(existsSync(wav(A, "r", "c1"))).toBe(true);
    expect(existsSync(wav(A, "r", "c2"))).toBe(true);
    expect(audit.append).toHaveBeenCalledTimes(1); // the audit line is already out (documented residual)
  });

  it("a failed unlink still counts as done: the mark makes it unplayable", async () => {
    mkIdentity(A, S);
    mkRole(A, "r", [segLine("c1")]);
    let n = 0;
    const acquireLock: DeleteOptions["acquireLock"] = (dir, ident, m) => {
      const r = acquireStoreLock(dir, ident, m);
      if (r.kind !== "held") return r;
      return { ...r, assertHeld: async () => { if (++n === 2) chmodSync(path.join(audioDir, A, "r"), 0o500); return r.assertHeld(); } };
    };
    const r = await run(undefined, undefined, { acquireLock });
    chmodSync(path.join(audioDir, A, "r"), 0o700);
    expect(r).toStrictEqual({ live: false, deleted: 1, gone: [], identities: [done(A, 1)], pending: [] });
    expect(existsSync(wav(A, "r", "c1"))).toBe(true);
    expect(await deletedIn(A, "r")).toEqual(["c1"]);
  });
});
