import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeSync, fchmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { isSafeId, isValidSessionId } from "@acr/events";

export type Entry = { sessionId: string; scenarioId: string; status: "running" | "stopped" | "ended" };

const STATUSES: readonly string[] = ["running", "stopped", "ended"];
const MAX_BYTES = 1024 * 1024;
const REFUSED = "the session list is not usable";

/** Tests only: inject a failing step or a different current user. */
export type SessionListHooks = { beforeRename?: () => void; currentUid?: () => number };

function isEntry(v: unknown): v is Entry {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  return keys.length === 3 && keys.includes("sessionId") && keys.includes("scenarioId") && keys.includes("status")
    && typeof o.sessionId === "string" && isValidSessionId(o.sessionId)
    && typeof o.scenarioId === "string" && isSafeId(o.scenarioId)
    && typeof o.status === "string" && STATUSES.includes(o.status);
}

/**
 * `sessions.json`: sessionId, scenarioId and status only. Synchronous. Writes go to a new O_EXCL temp file (0600) in the same
 * directory, are fsynced, renamed over the target, and the directory is fsynced. The reader opens with O_NOFOLLOW and judges by fstat
 * (regular file, one link, owned by this user, at most 1 MiB). A file that fails any check, is not JSON, or has the wrong shape is
 * REFUSED with a plain error; it is never replaced by an empty list. (A local atomic writer, not the runtime's secure-json-file: the
 * control service does not import the runtime.)
 */
export class SessionList {
  constructor(private readonly file: string, private readonly hooks: SessionListHooks = {}) {}

  read(): Entry[] {
    let fd: number;
    try { fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error(REFUSED);
    }
    try {
      const st = fstatSync(fd);
      const uid = this.hooks.currentUid ? this.hooks.currentUid() : process.getuid?.();
      if (!st.isFile() || st.nlink !== 1 || st.size > MAX_BYTES || (uid !== undefined && st.uid !== uid)) throw new Error(REFUSED);
      const buf = Buffer.alloc(st.size);
      let got = 0;
      while (got < buf.length) {
        const n = readSync(fd, buf, got, buf.length - got, got);
        if (n === 0) break;
        got += n;
      }
      let parsed: unknown;
      try { parsed = JSON.parse(buf.subarray(0, got).toString("utf8")); } catch { throw new Error(REFUSED); }
      if (!Array.isArray(parsed) || !parsed.every(isEntry)) throw new Error(REFUSED);
      if (new Set(parsed.map((e) => e.sessionId)).size !== parsed.length) throw new Error(REFUSED);
      return parsed.map((e) => ({ sessionId: e.sessionId, scenarioId: e.scenarioId, status: e.status }));
    } catch (err) {
      throw err instanceof Error && err.message === REFUSED ? err : new Error(REFUSED);
    } finally { closeSync(fd); }
  }

  upsert(e: Entry): void {
    if (!isEntry(e)) throw new Error("the session list entry is invalid");
    const entry: Entry = { sessionId: e.sessionId, scenarioId: e.scenarioId, status: e.status };
    const list = this.read();
    const i = list.findIndex((x) => x.sessionId === entry.sessionId);
    if (i >= 0) list[i] = entry; else list.push(entry);
    this.write(list);
  }

  remove(id: string): void {
    const list = this.read();
    const next = list.filter((x) => x.sessionId !== id);
    if (next.length !== list.length) this.write(next);
  }

  private write(list: Entry[]): void {
    const dir = path.dirname(this.file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.${path.basename(this.file)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try {
        fchmodSync(fd, 0o600);
        const data = Buffer.from(`${JSON.stringify(list)}\n`, "utf8");
        let off = 0;
        while (off < data.length) off += writeSync(fd, data, off, data.length - off);
        fsyncSync(fd);
      } finally { closeSync(fd); }
      this.hooks.beforeRename?.();
      renameSync(tmp, this.file);
    } catch (err) {
      try { unlinkSync(tmp); } catch { /* already gone */ }
      throw err;
    }
    const dfd = openSync(dir, constants.O_RDONLY);
    try { fsyncSync(dfd); } finally { closeSync(dfd); }
  }
}
