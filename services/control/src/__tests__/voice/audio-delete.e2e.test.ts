import { fork, type ChildProcess } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionLock } from "@acr/runtime/files";
import { isDeletedLine, isLowerHex } from "@acr/speech/protocol";
import { buildAudioService } from "../../main.js";
import { AuditLog, type AuditEvent } from "../../voice/audit-log.js";
import { IdentityMutex } from "../../voice/store-lock.js";
import { A, B, BY, DAY_MS, S, S2, T0, TOKEN, client, listing, useAudioE2e } from "./audio-e2e-harness.js";

/**
 * US-0075 (voice A2b-1b, Task 9; spec sections 4 to 10): the facilitator's audio delete end to end. The REAL speech `AudioStore` writes
 * the marker, WAVs and index lines; the REAL control API (`createApi` over `buildAudioService`, and the whole `startControl` for the
 * shared-mutex race) answers over real loopback HTTP; the REAL `AuditLog` writes every line (a wrapper only delays or observes it); the
 * REAL `sweepAudio` repairs a half-done delete. Crashes are injected through the file system itself (an index or a role folder that
 * refuses the write), never through a code seam, so the production modules run unchanged.
 */
const h = useAudioE2e("acr-delete-e2e-");
const { record, wavPath, wavOnDisk, auditLines, deletedLines } = h;
const NOW = T0 + 5;
const isRoot = process.getuid?.() === 0;

type DeleteData = { deleted: number; gone: string[]; identities: { identity: string; deleted: number; state: string }[]; pending: { identity: string; reason: string }[] };
type DeleteReply = { status: number; retryAfter: string | null; code: string | undefined; data: DeleteData | null };
type Scope = { kind: "session" } | { kind: "role"; role: string } | { kind: "participant"; participant: string };

async function del(port: number, sessionId: string, scope: Scope = { kind: "session" }, reason = "facilitator"): Promise<DeleteReply> {
  const r = await fetch(`http://127.0.0.1:${port}/sessions/${sessionId}/audio`, {
    method: "DELETE", headers: { "x-service-token": TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ scope, reason, by: BY }),
  });
  const json = (await r.json()) as { data: DeleteData | null; error: { code: string } | null };
  return { status: r.status, retryAfter: r.headers.get("retry-after"), code: json.error?.code, data: json.data };
}
const done = (identity: string, deleted: number) => ({ identity, deleted, state: "done" });
const code = (b: Buffer): unknown => (JSON.parse(b.toString("utf8")) as { error: { code: string } }).error.code;

/** The audio service main.ts builds (`buildAudioService`) on a real port, with the real AuditLog unless `audit` is given. */
async function boot(o: { audit?: Pick<AuditLog, "append">; mutex?: IdentityMutex; isLive?: (sessionId: string) => boolean } = {}) {
  const audit = o.audit ?? realAudit();
  const port = await h.serve(buildAudioService({ audioDir: h.ctx.audioDir, sessionsDir: h.ctx.sessionsDir }, {
    audit, ...(o.mutex ? { mutex: o.mutex } : {}), ...(o.isLive ? { isLive: o.isLive } : {}),
  }));
  return { port, get: client(port), del: (sessionId: string, scope?: Scope, reason?: string) => del(port, sessionId, scope, reason) };
}
const realAudit = (dir = h.ctx.audioDir) => new AuditLog({ audioDir: dir, now: () => NOW, log: () => {} });

/** A role's index lines, parsed (torn lines skipped). */
const indexLines = (identity: string, role: string, dir = h.ctx.audioDir): unknown[] =>
  readFileSync(path.join(dir, identity, role, "index.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as unknown);
const marks = (identity: string, role: string, dir = h.ctx.audioDir) => indexLines(identity, role, dir).filter(isDeletedLine);

/** Locks taken by the test (released after it), and second processes (killed after it). */
const locks: SessionLock[] = [];
const children: ChildProcess[] = [];
const chmods: string[] = [];
afterEach(() => {
  for (const p of chmods.splice(0)) { try { chmodSync(p, 0o700); } catch { /* gone */ } }
  for (const l of locks.splice(0)) l.release();
  for (const c of children.splice(0)) c.kill("SIGKILL");
  vi.useRealTimers();
});
/** Holds `<id>.audio-audit.lock` as another writer would: the real AuditLog's append for `id` then fails after its retries. */
const holdAuditLock = (dir: string, identity: string): SessionLock => {
  const l = SessionLock.acquire(dir, identity, { suffix: "audio-audit" });
  locks.push(l);
  return l;
};
const release = (l: SessionLock): void => { l.release(); locks.splice(locks.indexOf(l), 1); };

/** A real second process (node + tsx) that takes the REAL store lock `<identity>.store.lock` and holds it until killed. */
async function secondProcessHolds(dir: string, identity: string): Promise<void> {
  const script = path.join(h.ctx.root, "hold-lock.mjs");
  writeFileSync(script, [
    "const { SessionLock } = await import(process.argv[2]);",
    "SessionLock.acquire(process.argv[3], process.argv[4], { suffix: 'store' });",
    "process.send('held');",
    "setInterval(() => {}, 60_000);",
  ].join("\n"));
  const files = pathToFileURL(path.resolve(import.meta.dirname, "../../../../runtime/src/files/index.ts")).href;
  const child = fork(script, [files, dir, identity], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "inherit", "ipc"] });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once("message", () => resolve());
    child.once("exit", (c) => reject(new Error(`the lock holder exited (${String(c)})`)));
  });
}

describe("audio delete end to end: real worker store, real control API, real audit and sweep (US-0075, Task 9)", () => {
  it("the real store writes a session and the listing shows it; DELETE by role is 200, those segments replay 410, the others still play", async () => {
    record({ identity: A, sessionId: S, segments: [{ role: "coach", segment: "seg1", seed: 1 }, { role: "coach", segment: "seg2", seed: 2 }, { role: "client", segment: "seg3", seed: 3 }] });
    const { get, del: remove } = await boot();
    const before = listing((await get(`/sessions/${S}/audio`)).body);
    expect(before.segments.map((s) => [s.role, s.segment, s.audio])).toEqual([["client", "seg3", "available"], ["coach", "seg1", "available"], ["coach", "seg2", "available"]]);

    const r = await remove(S, { kind: "role", role: "coach" });
    expect(r).toStrictEqual({ status: 200, retryAfter: null, code: undefined, data: { deleted: 2, gone: [], identities: [done(A, 2)], pending: [] } });
    expect(existsSync(wavPath(A, "coach", "seg1"))).toBe(false);
    expect(existsSync(wavPath(A, "coach", "seg2"))).toBe(false);

    for (const seg of ["seg1", "seg2"]) {
      const gone = await get(`/sessions/${S}/audio/coach/${seg}`);
      expect(gone.status).toBe(410);
      expect(code(gone.body)).toBe("audio_deleted");
    }
    const still = await get(`/sessions/${S}/audio/client/seg3`);
    expect(still.status).toBe(200);
    expect(still.body.equals(wavOnDisk(A, "client", "seg3"))).toBe(true);
    // The transcript side is untouched: every segment is still listed, the deleted ones as deleted.
    const after = listing((await get(`/sessions/${S}/audio`)).body);
    expect(after.segments.map((s) => [s.role, s.segment, s.audio])).toEqual([["client", "seg3", "available"], ["coach", "seg1", "deleted"], ["coach", "seg2", "deleted"]]);
  });

  it("the audit file holds exactly one audio.deleted line (facilitator, the scope, the op the marks carry) and no text, path or audio field", async () => {
    record({ identity: A, sessionId: S, segments: [{ role: "coach", segment: "seg1", seed: 1 }, { role: "coach", segment: "seg2", seed: 2 }] });
    const { del: remove } = await boot();
    expect((await remove(S, { kind: "role", role: "coach" })).status).toBe(200);
    const lines = deletedLines(A);
    expect(lines).toStrictEqual([{ v: 1, ts: NOW, type: "audio.deleted", scope: { kind: "role", role: "coach" }, reason: "facilitator", by: BY, segments: 2, op: expect.any(String) }]);
    const op = lines[0]!.op as string;
    expect(isLowerHex(op, 16)).toBe(true);
    expect(marks(A, "coach").map((m) => [m.segment, m.op])).toEqual([["seg1", op], ["seg2", op]]);
    const text = readFileSync(path.join(h.ctx.audioDir, `${A}.audio-audit.jsonl`), "utf8");
    for (const banned of ["words somebody said", h.ctx.root, h.ctx.audioDir, ".wav", "RIFF", "raw", "audio\":", "path"]) expect(text).not.toContain(banned);
  });

  it.skipIf(isRoot)("a crash after the audit line and before the index write (the index refuses the write) leaves the audio playable; a retry writes a NEW line with a NEW op", async () => {
    record({ identity: A, sessionId: S, segments: [{ role: "coach", segment: "seg1", seed: 1 }] });
    const { get, del: remove } = await boot();
    const index = path.join(h.ctx.audioDir, A, "coach", "index.jsonl");
    chmodSync(index, 0o400); // the real appendDeletedLines now throws (EACCES) right after the audit line
    let first: DeleteReply;
    try { first = await remove(S); } finally { chmodSync(index, 0o600); }
    expect(first).toStrictEqual({ status: 503, retryAfter: null, code: "store_unsafe", data: { deleted: 0, gone: [], identities: [], pending: [{ identity: A, reason: "store_unsafe" }] } });
    expect(deletedLines(A).length).toBe(1); // the audit says deleted (the documented residual) ...
    expect(marks(A, "coach")).toEqual([]); // ... but nothing was marked
    const playable = await get(`/sessions/${S}/audio/coach/seg1`);
    expect(playable.status).toBe(200);
    expect(playable.body.equals(wavOnDisk(A, "coach", "seg1"))).toBe(true);

    const retry = await remove(S);
    expect(retry).toStrictEqual({ status: 200, retryAfter: null, code: undefined, data: { deleted: 1, gone: [], identities: [done(A, 1)], pending: [] } });
    const lines = deletedLines(A);
    expect(lines.length).toBe(2);
    expect(lines[1]!.op).not.toBe(lines[0]!.op);
    expect(marks(A, "coach").map((m) => m.op)).toEqual([lines[1]!.op]);
    expect((await get(`/sessions/${S}/audio/coach/seg1`)).status).toBe(410);
  });

  it.skipIf(isRoot)("a crash after the index write and before the unlink (the role folder refuses it): marked, 410, the WAV left; the real sweep removes it as an orphan", async () => {
    // ended at T0, so the sweep at NOW keeps the folder and runs its orphan pass (the segment times are session-relative, not a clock)
    record({ identity: A, sessionId: S, segments: [{ role: "coach", segment: "seg1", seed: 1 }, { role: "coach", segment: "seg2", seed: 2 }], ended: true });
    const { get, del: remove } = await boot();
    const role = path.join(h.ctx.audioDir, A, "coach");
    chmods.push(role);
    chmodSync(role, 0o500); // the marks still go in (the index file is writable); every unlink fails (EACCES)
    let r: DeleteReply;
    try { r = await remove(S, { kind: "role", role: "coach" }); } finally { chmodSync(role, 0o700); }
    expect(r).toStrictEqual({ status: 200, retryAfter: null, code: undefined, data: { deleted: 2, gone: [], identities: [done(A, 2)], pending: [] } });
    expect(existsSync(wavPath(A, "coach", "seg1"))).toBe(true);
    expect(existsSync(wavPath(A, "coach", "seg2"))).toBe(true);
    expect((await get(`/sessions/${S}/audio/coach/seg1`)).status).toBe(410); // unplayable at once: the mark wins over the file
    expect(listing((await get(`/sessions/${S}/audio`)).body).segments.map((s) => s.audio)).toEqual(["deleted", "deleted"]);

    expect(await h.sweep(NOW)).toStrictEqual({ deleted: 0, skipped: 0, orphans: 2 }); // a kept folder: the marked WAVs are orphans
    expect(existsSync(wavPath(A, "coach", "seg1"))).toBe(false);
    expect(existsSync(wavPath(A, "coach", "seg2"))).toBe(false);
    expect(existsSync(path.join(role, "index.jsonl"))).toBe(true);
    expect((await get(`/sessions/${S}/audio/coach/seg1`)).status).toBe(410);
    expect(await h.sweep(NOW)).toStrictEqual({ deleted: 0, skipped: 0, orphans: 0 });
  });

  it("an audit line that cannot be written (the real audit lock held by another writer) is 503 audit_unavailable: no mark, no unlink, still playable", async () => {
    record({ identity: A, sessionId: S, segments: [{ role: "coach", segment: "seg1", seed: 1 }] });
    const { get, del: remove } = await boot();
    const lock = holdAuditLock(h.ctx.audioDir, A);
    const r = await remove(S);
    expect(r).toStrictEqual({ status: 503, retryAfter: null, code: "audit_unavailable", data: { deleted: 0, gone: [], identities: [], pending: [{ identity: A, reason: "audit_unavailable" }] } });
    expect(marks(A, "coach")).toEqual([]);
    expect(existsSync(wavPath(A, "coach", "seg1"))).toBe(true);
    release(lock);
    expect(deletedLines(A)).toEqual([]);
    expect((await get(`/sessions/${S}/audio/coach/seg1`)).status).toBe(200);
  });

  it("a DELETE racing the real sweep inside one startControl (ONE shared mutex) is 503 pending busy with Retry-After: 1, never 409", async () => {
    // The sweep holds an identity's mutex (and store lock) across an await only on an EXPIRED folder: it renames the folder aside, then
    // awaits the audit line. The test holds that identity's audit lock, so the REAL audit append waits on its retry timer, frozen here.
    // A worker then records the same identity afresh, so the delete finds it and meets the mutex the sweep holds. With a second mutex in
    // main.ts the delete would take its own, then meet the sweep's store lock as `locked_other`: 409, and this test fails.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { dir } = h.whole();
    const old = Date.now() - 40 * DAY_MS;
    record({ dir, identity: A, sessionId: S, segments: [{ role: "coach", segment: "seg1", seed: 1 }], at: old, ended: true });
    const lock = holdAuditLock(dir, A);
    const port = await h.startWhole();
    const aside = () => readdirSync(dir).filter((n) => n.startsWith(`${A}.deleting-`));
    expect(aside().length).toBe(1); // the start-up sweep has renamed the expired folder and is awaiting its audit line
    record({ dir, identity: A, sessionId: S, segments: [{ role: "coach", segment: "seg2", seed: 2 }], at: Date.now() });

    const r = await del(port, S);
    expect(r).toStrictEqual({ status: 503, retryAfter: "1", code: "busy", data: { deleted: 0, gone: [], identities: [], pending: [{ identity: A, reason: "busy" }] } });
    expect(aside().length).toBe(1); // the sweep really was mid-await while the delete ran
    expect(existsSync(path.join(dir, A, "coach", "seg2.wav"))).toBe(true);
    expect(marks(A, "coach", dir)).toEqual([]);

    release(lock);
    await vi.advanceTimersByTimeAsync(200); // the audit's retry fires: the sweep writes its line, removes the aside folder, frees the mutex
    vi.useRealTimers();
    await vi.waitFor(() => expect(aside()).toEqual([]));
    expect(deletedLines(A, dir).map((l) => [l.reason, l.by])).toEqual([["expired", "system"]]);

    const retry = await del(port, S);
    expect(retry).toStrictEqual({ status: 200, retryAfter: null, code: undefined, data: { deleted: 1, gone: [], identities: [done(A, 1)], pending: [] } });
    expect(deletedLines(A, dir).map((l) => [l.reason, l.by])).toEqual([["expired", "system"], ["facilitator", BY]]);
    expect((await client(port)(`/sessions/${S}/audio/coach/seg2`)).status).toBe(410);
  });

  it("a replay racing a delete never returns bytes for a segment marked meanwhile: 410 once the mark lands during its audit append", async () => {
    record({ identity: A, sessionId: S, segments: [{ role: "coach", segment: "seg1", seed: 1 }] });
    const real = realAudit();
    let reached!: () => void;
    const atGate = new Promise<void>((r) => { reached = r; });
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const audit = { append: async (identity: string, e: AuditEvent): Promise<boolean> => {
      if (e.type === "audio.played") { reached(); await gate; } // the replay has read the WAV and passed its index re-check
      return real.append(identity, e);
    } };
    const { get, del: remove } = await boot({ audit });
    const replay = get(`/sessions/${S}/audio/coach/seg1`);
    await atGate;
    expect((await remove(S)).status).toBe(200);
    open();
    const r = await replay;
    expect(r.status).toBe(410);
    expect(code(r.body)).toBe("audio_deleted");
    expect(r.body.includes(Buffer.from("RIFF"))).toBe(false);
    expect(r.headers.get("content-type")).toBe("application/json");
  });

  it("a live session (VoiceHost.isLive true) is 409 session_live with nothing written, even with no audio folder (checked before the catalog)", async () => {
    record({ identity: A, sessionId: S, segments: [{ role: "coach", segment: "seg1", seed: 1 }] });
    const { get, del: remove } = await boot({ isLive: (id) => id === S || id === S2 });
    expect(await remove(S)).toStrictEqual({ status: 409, retryAfter: null, code: "session_live", data: { deleted: 0, gone: [], identities: [], pending: [] } });
    expect(await remove(S2)).toStrictEqual({ status: 409, retryAfter: null, code: "session_live", data: { deleted: 0, gone: [], identities: [], pending: [] } }); // no folder: 409, not 404
    expect(deletedLines(A)).toEqual([]);
    expect(marks(A, "coach")).toEqual([]);
    expect((await get(`/sessions/${S}/audio/coach/seg1`)).status).toBe(200);
  });

  it("a session that goes live between identities (isLive asked again per identity) stops with 409 and the work done so far", async () => {
    record({ identity: A, sessionId: S, segments: [{ role: "coach", segment: "seg1", seed: 1 }] });
    record({ identity: B, sessionId: S, segments: [{ role: "coach", segment: "seg2", seed: 2 }] });
    const real = realAudit();
    let live = false;
    const audit = { append: (identity: string, e: AuditEvent): Promise<boolean> => {
      if (e.type === "audio.deleted") live = true; // a worker starts while the first identity is being deleted
      return real.append(identity, e);
    } };
    const { get, del: remove } = await boot({ audit, isLive: () => live });
    expect(await remove(S)).toStrictEqual({ status: 409, retryAfter: null, code: "session_live", data: { deleted: 1, gone: [], identities: [done(A, 1)], pending: [] } });
    expect(deletedLines(B)).toEqual([]);
    expect(marks(B, "coach")).toEqual([]);
    expect((await get(`/sessions/${S}/audio/coach/seg2`)).status).toBe(200);
  });

  it("a second process holding the real store lock (a live worker) is 409 session_live and nothing is written", async () => {
    record({ identity: A, sessionId: S, segments: [{ role: "coach", segment: "seg1", seed: 1 }] });
    await secondProcessHolds(h.ctx.audioDir, A);
    const { get, del: remove } = await boot();
    expect(await remove(S)).toStrictEqual({ status: 409, retryAfter: null, code: "session_live", data: { deleted: 0, gone: [], identities: [], pending: [] } });
    expect(deletedLines(A)).toEqual([]);
    expect(marks(A, "coach")).toEqual([]);
    expect(existsSync(wavPath(A, "coach", "seg1"))).toBe(true);
    expect((await get(`/sessions/${S}/audio/coach/seg1`)).status).toBe(200);
  });

  it("two identity folders for one session, one held by the test: 503 busy with partial counts; a retry finishes the rest, no second line for the first", async () => {
    record({ identity: A, sessionId: S, segments: [{ role: "coach", segment: "seg1", seed: 1 }] });
    record({ identity: B, sessionId: S, segments: [{ role: "coach", segment: "seg2", seed: 2 }, { role: "client", segment: "seg3", seed: 3 }] });
    const mutex = new IdentityMutex();
    const { get, del: remove } = await boot({ mutex });
    const free = mutex.tryTake(B)!;
    expect(await remove(S)).toStrictEqual({ status: 503, retryAfter: "1", code: "busy", data: { deleted: 1, gone: [], identities: [done(A, 1)], pending: [{ identity: B, reason: "busy" }] } });
    expect(deletedLines(B)).toEqual([]);
    expect((await get(`/sessions/${S}/audio/coach/seg2`)).status).toBe(200);
    free();
    expect(await remove(S)).toStrictEqual({ status: 200, retryAfter: null, code: undefined, data: { deleted: 2, gone: [], identities: [done(A, 0), done(B, 2)], pending: [] } });
    expect(deletedLines(A).length).toBe(1);
    expect(deletedLines(B).map((l) => l.segments)).toEqual([2]);
    for (const [role, seg] of [["coach", "seg1"], ["coach", "seg2"], ["client", "seg3"]]) expect((await get(`/sessions/${S}/audio/${role}/${seg}`)).status).toBe(410);
  });

  it("the session scope keeps session.json and every index: replay answers 410, not 404, and a repeat is 200 with deleted 0", async () => {
    record({ identity: A, sessionId: S, segments: [{ role: "coach", segment: "seg1", seed: 1 }, { role: "client", segment: "seg2", seed: 2 }], ended: true });
    const { get, del: remove } = await boot();
    expect((await remove(S)).data).toStrictEqual({ deleted: 2, gone: [], identities: [done(A, 2)], pending: [] });
    expect(existsSync(path.join(h.ctx.audioDir, A, "session.json"))).toBe(true);
    expect(existsSync(path.join(h.ctx.audioDir, A, "ended.json"))).toBe(true);
    expect(existsSync(path.join(h.ctx.audioDir, A, "coach", "index.jsonl"))).toBe(true);
    expect(existsSync(path.join(h.ctx.audioDir, A, "client", "index.jsonl"))).toBe(true);
    expect((await get(`/sessions/${S}/audio/coach/seg1`)).status).toBe(410);
    expect((await get(`/sessions/${S}/audio/client/seg2`)).status).toBe(410);
    expect((await get(`/sessions/${S}/audio`)).status).toBe(200);
    expect(await remove(S)).toStrictEqual({ status: 200, retryAfter: null, code: undefined, data: { deleted: 0, gone: [], identities: [done(A, 0)], pending: [] } });
    expect(deletedLines(A).length).toBe(1);
  });

  it("an untrusted (symlinked) index is 503 store_unsafe for replay and for delete, with no fall-through to another identity's copy", async () => {
    // A and B both hold coach/seg1 for the session (a restart re-recorded it); A comes first in the catalog's order.
    record({ identity: A, sessionId: S, segments: [{ role: "coach", segment: "seg1", seed: 1 }] });
    record({ identity: B, sessionId: S, segments: [{ role: "coach", segment: "seg1", seed: 2 }] });
    const index = path.join(h.ctx.audioDir, A, "coach", "index.jsonl");
    const copy = path.join(h.ctx.root, "index-copy.jsonl");
    copyFileSync(index, copy);
    unlinkSync(index);
    symlinkSync(copy, index); // same content, but a link: it cannot be trusted
    const { get, del: remove } = await boot();
    const r = await get(`/sessions/${S}/audio/coach/seg1`);
    expect(r.status).toBe(503);
    expect(code(r.body)).toBe("store_unsafe");
    expect(r.headers.get("retry-after")).toBeNull();
    expect(r.body.includes(Buffer.from("RIFF"))).toBe(false); // never B's copy
    expect(auditLines(A)).toEqual([]);
    expect(auditLines(B)).toEqual([]);

    const d = await remove(S);
    expect(d).toStrictEqual({ status: 503, retryAfter: null, code: "store_unsafe", data: { deleted: 1, gone: [], identities: [done(B, 1)], pending: [{ identity: A, reason: "store_unsafe" }] } });
    expect(existsSync(wavPath(A, "coach", "seg1"))).toBe(true); // nothing of A touched
    expect(readFileSync(copy, "utf8")).not.toContain("\"deleted\"");
    expect(deletedLines(A)).toEqual([]);
    expect((await get(`/sessions/${S}/audio/coach/seg1`)).status).toBe(503); // still store_unsafe, never 410 from B nor A's bytes
    rmSync(copy);
  });
});

/*
 * Mutation checks (US-0075 Task 9, spec section 10), 2026-11-13. Each change was applied to the PRODUCTION file, the control voice suite
 * run (`pnpm --filter @acr/control exec vitest run src/__tests__/voice`), then reverted (`git diff` clean). Every mutation was killed.
 *
 * | Mutation (production file)                                          | Failing tests (one or more, by name)                                                     |
 * |---------------------------------------------------------------------|------------------------------------------------------------------------------------------|
 * | (a) index marks written before the audit line (audio-delete.ts)      | e2e "an audit line that cannot be written (the real audit lock held by another writer)   |
 * |                                                                     | is 503 audit_unavailable: no mark, no unlink, still playable"; e2e "a crash after the    |
 * |                                                                     | audit line and before the index write ..."; unit "the audit line is appended while every |
 * |                                                                     | index is untouched and every WAV still present" (6 in all)                               |
 * | (b1) AudioService.delete skips its isLive check (audio-routes.ts)    | e2e "a live session (VoiceHost.isLive true) is 409 session_live with nothing written,    |
 * |                                                                     | even with no audio folder (checked before the catalog)"; routes "live (VoiceHost.isLive) |
 * |                                                                     | is 409 session_live ... checked before the catalog" (4 in all)                           |
 * | (b2) deleteAudio skips both of its isLive checks (audio-delete.ts)   | e2e "a session that goes live between identities (isLive asked again per identity) stops |
 * |                                                                     | with 409 and the work done so far"; unit "isLive true returns live: true with nothing    |
 * |                                                                     | written" (5 in all)                                                                      |
 * | (b3) deleteAudio skips only the per-identity re-check                | e2e "a session that goes live between identities ..."; unit "isLive is asked again       |
 * |                                                                     | before each identity: going live after the first stops with the first done" (3 in all)   |
 * | (c) the identity mutex is never taken (store-lock.ts)                | e2e "a DELETE racing the real sweep inside one startControl (ONE shared mutex) is 503    |
 * |                                                                     | pending busy with Retry-After: 1, never 409"; e2e "two identity folders for one session, |
 * |                                                                     | one held by the test ..."; unit "the mutex held (as by the sweep) gives pending busy and |
 * |                                                                     | no audit line" (11 in all)                                                               |
 * | (c2) main.ts gives the audio service a SECOND IdentityMutex          | e2e "a DELETE racing the real sweep inside one startControl (ONE shared mutex) ..." (409 |
 * |                                                                     | instead of 503: the only test that sees the real wiring; 1 in all)                       |
 * | (d) the deleted mark is never written (audio-delete.ts)              | e2e "the real store writes a session and the listing shows it; DELETE by role is 200,    |
 * |                                                                     | those segments replay 410 ..."; e2e "a replay racing a delete never returns bytes ..."   |
 * |                                                                     | (29 in all)                                                                              |
 * | (e) an untrusted index reads as a trusted empty one (audio-catalog)  | e2e "an untrusted (symlinked) index is 503 store_unsafe for replay and for delete, with  |
 * |                                                                     | no fall-through to another identity's copy"; catalog "a symlinked role folder is         |
 * |                                                                     | untrusted (nothing behind it is opened)" (32 in all)                                     |
 * | (f) the unlink uses an unchecked path: no folder or WAV descriptor   | unit "a role folder swapped for a symlink before the unlink is not followed; the         |
 * |     checks, `unlinkSync(join(rolePath, seg.wav))` (audio-delete.ts)  | identity still counts done"; unit "a role folder swapped for ANOTHER real folder before  |
 * |                                                                     | the unlink: nothing in the new folder is removed" (2 in all; the swap needs the unit     |
 * |                                                                     | test's in-process seam, an e2e cannot time it)                                           |
 */
