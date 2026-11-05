import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";

/** Test support: opens a file ONCE and reads its type, mode and text from that one descriptor (no check-then-read on a path). */
export function readOnce(file: string): { text: string; mode: number; isFile: boolean } {
  const fd = openSync(file, "r");
  try {
    const st = fstatSync(fd);
    return { text: readFileSync(fd, "utf8"), mode: st.mode & 0o777, isFile: st.isFile() };
  } finally { closeSync(fd); }
}
