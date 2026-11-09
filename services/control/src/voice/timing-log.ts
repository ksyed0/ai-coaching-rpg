import { closeSync, constants as fsConstants, fchmodSync, fstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import path from "node:path";

/** US-0072 (EPIC-0003 voice A1c, Task 12): the timing record's file name in CONTROL_LOG_DIR. */
export const TIMING_LOG_FILE = "voice-timing.log";
/** The record stops growing here (about ten thousand lines: far more than a room test needs). */
export const TIMING_LOG_MAX_BYTES = 1024 * 1024;

/**
 * US-0072 (A1c Task 12, VOICE_TIMING_LOG=1): where VoiceHost's timing lines go: `<logDir>/voice-timing.log`, appended one line per
 * acknowledged voice line, created 0600 in the 0700 log folder (an existing wider file is set to 0600), opened with O_NOFOLLOW (a link
 * planted there is refused, never written through) and O_NONBLOCK (a FIFO planted there is refused at once, never waited on: review C M1),
 * and never past `maxBytes`. The lines carry the session id and two millisecond
 * counts only (voice-host.ts builds them); `pnpm voice:timings <file>` reads them. A failure is logged once by error code, a full file
 * once by a fixed sentence; nothing here throws and nothing logs a path.
 */
export function timingLogSink(logDir: string, o: { log: (m: string) => void; maxBytes?: number }): (line: string) => void {
  const file = path.join(logDir, TIMING_LOG_FILE);
  const maxBytes = o.maxBytes ?? TIMING_LOG_MAX_BYTES;
  // Review C M6: one flag per sentence, so a write failure does not hide a full log later (or the other way round).
  let failedOnce = false;
  let fullOnce = false;
  return (line) => {
    let fd: number | undefined;
    try {
      mkdirSync(logDir, { recursive: true, mode: 0o700 });
      fd = openSync(file, fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK, 0o600);
      const st = fstatSync(fd);
      if (!st.isFile()) throw Object.assign(new Error("not a regular file"), { code: "ENOTFILE" });
      fchmodSync(fd, 0o600); // the mode argument only applies to a new file
      const bytes = Buffer.from(`${line}\n`, "utf8");
      if (st.size + bytes.length > maxBytes) {
        if (!fullOnce) { fullOnce = true; o.log("voice timing log is full; no more timing lines are written"); }
        return;
      }
      writeSync(fd, bytes);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (!failedOnce) { failedOnce = true; o.log(`voice timing line could not be written (${typeof code === "string" && /^[A-Z]+$/.test(code) ? code : "error"})`); }
    } finally {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
    }
  };
}
