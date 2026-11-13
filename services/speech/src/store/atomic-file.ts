import { randomBytes } from "node:crypto";
import path from "node:path";
import { writeFully } from "./index-file.js";
import { CREATE_FLAGS, type StoreFs } from "./store-fs.js";

/**
 * Writes `<dir>/<name>` atomically (shared by `ended.json` and `session.json`): a private 0600 temp file created exclusively without
 * following a link, fsync, rename over the target (a link already at the target is replaced, never followed), then fsync of the folder.
 * Throws on any failure after removing the temp file this call created; the caller decides what a failure means. Never logs.
 */
export function writeFileAtomic(fs: StoreFs, dir: string, name: string, data: Buffer): void {
  const tmp = path.join(dir, `.${name}.${randomBytes(8).toString("hex")}.tmp`);
  let fd: number | null = null;
  let created = false;
  try {
    fd = fs.openSync(tmp, CREATE_FLAGS, 0o600);
    created = true;
    writeFully(fd, data, (f, b, o, l) => fs.writeSync(f, b, o, l));
    fs.fsyncSync(fd);
    const open = fd; fd = null; fs.closeSync(open);
    fs.renameSync(tmp, path.join(dir, name));
    created = false; // the temp name is gone now: nothing left to remove
    fs.fsyncDir(dir);
  } catch (err) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* best effort */ } }
    if (created) { try { fs.unlinkSync(tmp); } catch { /* best effort */ } }
    throw err;
  }
}
