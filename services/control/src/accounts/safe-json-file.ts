import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

const MAX_BYTES = 1024 * 1024;
const REFUSED = "the file is not usable";

/**
 * The one refusal this file (and the account and owner stores on top of it) throws: fixed text only, never a path, content or value, so
 * a startup failure may log its message (main.ts).
 */
export class UnusableFileError extends Error {
  constructor(reason: string) {
    super(`${REFUSED}: ${reason}`);
    this.name = "UnusableFileError";
  }
}

/** Tests only: inject a failing step or a different current user. */
export type SafeJsonFileHooks = { beforeRename?: () => void; currentUid?: () => number };

/**
 * One JSON file with the safety of `session-list.ts`: the reader opens with O_NOFOLLOW and judges by fstat (regular file, one link,
 * owned by this user, no group/other permission bits, at most 1 MiB). Writes go to a new O_EXCL temp file (0600) in the same
 * directory, are fsynced, renamed over the target, and the directory is fsynced. A file that fails any check, or is not JSON, is
 * REFUSED with a plain error that carries no file content; it is never reported as empty and never replaced (write re-checks it).
 * Only a missing file reads as null.
 */
export class SafeJsonFile {
  constructor(private readonly file: string, private readonly hooks: SafeJsonFileHooks = {}) {}

  read(): unknown | null {
    let fd: number;
    try { fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      throw new UnusableFileError(code === "ELOOP" ? "it is a symbolic link" : `it cannot be opened (${typeof code === "string" && /^[A-Z0-9_]{1,20}$/.test(code) ? code : "error"})`);
    }
    try {
      const st = fstatSync(fd);
      const uid = this.hooks.currentUid ? this.hooks.currentUid() : process.getuid?.();
      if (!st.isFile()) throw new UnusableFileError("it is not a regular file");
      if (st.nlink !== 1) throw new UnusableFileError("it has more than one hard link");
      if (st.size > MAX_BYTES) throw new UnusableFileError("it is larger than 1 MiB");
      if ((st.mode & 0o077) !== 0) throw new UnusableFileError("it is accessible by group or others (it must be mode 0600)");
      if (uid !== undefined && st.uid !== uid) throw new UnusableFileError("it is owned by another user");
      const buf = Buffer.alloc(st.size);
      let got = 0;
      while (got < buf.length) {
        const n = readSync(fd, buf, got, buf.length - got, got);
        if (n === 0) break;
        got += n;
      }
      let parsed: unknown;
      try { parsed = JSON.parse(buf.subarray(0, got).toString("utf8")); } catch { throw new UnusableFileError("it is not valid JSON"); }
      if (parsed === null) throw new UnusableFileError("it holds null"); // a file holding `null` must not read as "missing"
      return parsed;
    } catch (err) {
      throw err instanceof UnusableFileError ? err : new UnusableFileError("it cannot be read");
    } finally { closeSync(fd); }
  }

  write(value: unknown): void {
    const data = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    if (data.length > MAX_BYTES) throw new UnusableFileError("the new content is larger than 1 MiB");
    this.read(); // an existing unusable file is refused, never replaced
    const dir = path.dirname(this.file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.${path.basename(this.file)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try {
        fchmodSync(fd, 0o600);
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
