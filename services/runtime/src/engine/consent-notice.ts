import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { NOTICE_VERSION_RULE_TEXT, isNoticeVersion } from "@acr/events";
import type { ConsentNotice } from "./consent.js";

/** US-0053: the consent notice players agree to, `<dir>/notice-<version>.md`. */
export const MAX_NOTICE_CHARS = 4_000;
/** UTF-8 needs at most 4 bytes per character: anything larger cannot be a valid notice and is not read. */
const MAX_NOTICE_BYTES = MAX_NOTICE_CHARS * 4;
// Every C0 and C1 control character except \n and \t (a \r is refused too: the text is shown as is).
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;

/**
 * Reads the notice through one descriptor opened without following links and judged by fstat. Throws an Error naming the file and
 * the reason, never any of its content.
 */
export function loadConsentNotice(dir: string, version: string): ConsentNotice {
  if (!isNoticeVersion(version)) throw new Error(`the consent notice version must be ${NOTICE_VERSION_RULE_TEXT}`);
  const name = `notice-${version}.md`;
  const file = path.join(dir, name);
  let fd: number;
  // O_NONBLOCK: a FIFO under the notice's name would otherwise block the start forever before fstat can refuse it.
  try { fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK); }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(`the consent notice ${name} was not found in the consent directory`);
    if (code === "ELOOP" || code === "EMLINK") throw new Error(`the consent notice ${name} is a symbolic link and is not followed`);
    throw new Error(`cannot read the consent notice ${name}: ${code ?? "error"}`);
  }
  let buf: Buffer;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(`the consent notice ${name} is not a regular file`);
    if (st.size > MAX_NOTICE_BYTES) throw new Error(`the consent notice ${name} is longer than ${MAX_NOTICE_CHARS} characters`);
    buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) { const n = readSync(fd, buf, off, buf.length - off, off); if (n === 0) break; off += n; }
    buf = buf.subarray(0, off);
  } finally { closeSync(fd); }
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); }
  catch { throw new Error(`the consent notice ${name} is not valid UTF-8`); }
  if ([...text].length > MAX_NOTICE_CHARS) throw new Error(`the consent notice ${name} is longer than ${MAX_NOTICE_CHARS} characters`);
  if (CONTROL.test(text)) throw new Error(`the consent notice ${name} contains control characters (only line breaks and tabs are allowed)`);
  if (text.trim() === "") throw new Error(`the consent notice ${name} is empty`);
  return { version, text };
}
