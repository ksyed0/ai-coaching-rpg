import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

// Test support: what a test asserts about a file or directory comes from ONE descriptor, never from a stat of a path followed by a
// read of the same path (a check-then-use race, CodeQL js/file-system-race; L-0003, L-0017).

/** Opens `file` once (no symlink followed) and reads its permission bits, inode and text from that descriptor. */
export function readOnce(file: string): { text: string; mode: number; ino: number } {
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const st = fstatSync(fd);
    return { text: readFileSync(fd, "utf8"), mode: st.mode & 0o777, ino: st.ino };
  } finally { closeSync(fd); }
}

/** The permission bits of directory `dir`, from a descriptor opened on it (O_DIRECTORY: anything else is refused). */
export function dirMode(dir: string): number {
  const fd = openSync(dir, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try { return fstatSync(fd).mode & 0o777; } finally { closeSync(fd); }
}
