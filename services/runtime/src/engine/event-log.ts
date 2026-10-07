import { constants as fsConstants } from "node:fs";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Mutex } from "./mutex.js";
import { isKnownEventType, type EventBody, type SessionEvent } from "@acr/events";

/** What a replay of the whole log found: how many events, and how many bytes of a cut-off last line the next append drops (0: none). */
export type ReplayResult = { events: number; partialTailBytes: number };

export interface EventLog {
  readonly sessionId: string;
  append(body: EventBody, ts: number): Promise<SessionEvent>;
  all(): Promise<SessionEvent[]>;
  /** Streams every recorded event, in order, to `fn` (bounded memory; US-0018 restore). */
  replay?(fn: (e: SessionEvent) => void): Promise<ReplayResult>;
  /** Releases the file handle, if any. */
  close?(): Promise<void>;
}

export class MemoryEventLog implements EventLog {
  private events: SessionEvent[] = [];
  private readonly mutex = new Mutex();
  constructor(readonly sessionId: string) {}
  append(body: EventBody, ts: number): Promise<SessionEvent> {
    return this.mutex.run(async () => {
      const e = { ...body, seq: this.events.length + 1, ts, sessionId: this.sessionId } as SessionEvent;
      this.events.push(e);
      return e;
    });
  }
  async all() { return [...this.events]; }
  async replay(fn: (e: SessionEvent) => void): Promise<ReplayResult> {
    for (const e of [...this.events]) fn(e);
    return { events: this.events.length, partialTailBytes: 0 };
  }
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The single source of truth for what a session id may be (it becomes a file name). */
export const isValidSessionId = (id: string): boolean => SESSION_ID.test(id);

/** A session log is a few hundred KiB to a few MiB; refuse anything far larger rather than exhaust memory (the evaluator's cap too). */
export const MAX_SESSION_LOG_BYTES = 64 * 1024 * 1024;
/** No single event comes near this (an utterance is at most a few KiB); a longer line is corruption. */
export const MAX_EVENT_LINE_BYTES = 1024 * 1024;
const CHUNK = 64 * 1024;

/**
 * The log FAILED while being written (a write, an fdatasync or a tail repair failed, or the session lock was lost): fail-stop. The log
 * refuses every later append, because the file may now hold an event the engine never applied; the server must stop and be restarted,
 * and the restart resumes from what the file holds (the log is the source of truth: an event may be on disk that no client saw).
 */
export class LogFailedError extends Error {
  readonly code = "log_failed";
  constructor(readonly reason: string) {
    super(`the session log could not be written (${reason}); this server stopped writing it. Restart the server: the session resumes from its log`);
    this.name = "LogFailedError";
  }
}

/** The log cannot be read as a valid event sequence (corruption beyond a cut-off last line, an unknown event type, a seq gap, ...). */
export class LogCorruptError extends Error {
  readonly code = "log_corrupt";
  constructor(message: string) { super(message); this.name = "LogCorruptError"; }
}

export type JsonlLogOptions = {
  /** Refuse a log larger than this many bytes (default MAX_SESSION_LOG_BYTES). */
  maxBytes?: number;
  /**
   * Runs before every append, again right before the bytes are written and once more after they are synced (the session lock's
   * assertHeld); throws to refuse. A throw whose `code` is "closed" only refuses this append; any other throw makes the log fail-stop.
   */
  guard?: () => void | Promise<void>;
  /**
   * fdatasync after every append (default true: what the server always uses). Only the demo's throwaway in-process systems turn it off,
   * since macOS implements it as a full device flush (F_FULLFSYNC) that serialises parallel test runs; durability is the same code path.
   */
  sync?: boolean;
};

type ScanResult = { lastSeq: number; goodBytes: number; tail: "none" | "cut" | "newline"; partialTailBytes: number; events: number };
const EMPTY_SCAN: ScanResult = { lastSeq: 0, goodBytes: 0, tail: "none", partialTailBytes: 0, events: 0 };

const notRegular = (name: string, isDir: boolean) => Object.assign(new Error(`${name} is not a regular file`), { code: isDir ? "EISDIR" : "EINVAL" });

/** A log must be a regular file with one link, owned by this process's user (where the platform has uids). */
function checkOwnFile(name: string, st: { isFile(): boolean; isDirectory(): boolean; nlink: number; uid: number }): void {
  if (!st.isFile()) throw notRegular(name, st.isDirectory());
  if (st.nlink > 1) throw new LogCorruptError(`${name} has other hard links; it is not used (move the extra links away)`);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) throw new LogCorruptError(`${name} belongs to another user; it is not used`);
}

/** fsyncs a directory so a new or removed entry survives a power cut; tolerated where directories cannot be synced. */
export async function fsyncDir(dir: string): Promise<void> {
  let d: FileHandle | null = null;
  try { d = await open(dir, fsConstants.O_RDONLY); await d.sync(); }
  catch (err) { if (!["EISDIR", "EINVAL", "EPERM", "EBADF", "ENOTSUP", "EACCES"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err; }
  finally { await d?.close().catch(() => undefined); }
}

/**
 * The session log on disk: one JSON event per line, `<dir>/<sessionId>.jsonl`.
 *
 * - One append handle (O_APPEND, O_NOFOLLOW), created mode 0600 (an older, wider file is narrowed to 0600) in a 0700 directory;
 *   every append is followed by fdatasync, so an event a client has seen survives a crash or a power cut.
 * - Reads stream the file in 64 KiB chunks through one descriptor (fstat'd; never a path checked and then opened), capped at
 *   `maxBytes` (memory is bounded by the cap; a scan is linear in the file size).
 * - FAIL-STOP: once a write, an fdatasync or a tail repair fails, or the guard (the session lock) refuses, the log refuses every later
 *   append (LogFailedError). It never continues past an event the engine may not have applied.
 * - Every line is checked: JSON, an integer seq exactly one more than the previous, a finite ts, this session's id and a known event
 *   type. Anything else is a LogCorruptError naming the line. The one exception is a cut-off LAST line (no newline, not JSON): a crash
 *   mid-write. It is ignored on read and cut (ftruncate) before the next append. A complete last event that lacks only its newline
 *   gets the newline. The file is never rewritten.
 */
export class JsonlEventLog implements EventLog {
  private seq: number | null = null;
  readonly file: string;
  private readonly dir: string;
  private readonly maxBytes: number;
  private readonly guard: (() => void | Promise<void>) | undefined;
  private readonly sync: boolean;
  private handle: FileHandle | null = null;
  private closed = false;
  /** Set once writing failed: every later append is refused (fail-stop). */
  private broken: string | null = null;
  private readonly mutex = new Mutex();
  constructor(readonly sessionId: string, dir = "data/sessions", opts: JsonlLogOptions = {}) {
    if (!isValidSessionId(sessionId)) throw new Error(`invalid session id: ${JSON.stringify(sessionId)}`);
    this.dir = dir;
    this.file = path.join(dir, `${sessionId}.jsonl`);
    this.maxBytes = opts.maxBytes ?? MAX_SESSION_LOG_BYTES;
    this.guard = opts.guard;
    this.sync = opts.sync ?? true;
  }

  /** Why the log failed (fail-stop), or null. */
  get failure(): string | null { return this.broken; }

  append(body: EventBody, ts: number): Promise<SessionEvent> {
    return this.mutex.run(async () => {
      if (this.closed) throw Object.assign(new Error("the session log is closed"), { code: "ECLOSED" });
      if (this.broken) throw new LogFailedError(this.broken);
      await this.checkGuard();
      let h: FileHandle;
      try { h = await this.writable(); }
      catch (err) { await this.dropHandle(); throw err; } // nothing was written: an open failure may be retried
      if (this.seq === null) {
        const scan = await this.scan(h, null); // corruption throws here, before anything is written
        try {
          if (scan.tail === "cut") await h.truncate(scan.goodBytes);
          else if (scan.tail === "newline") await writeAll(h, Buffer.from("\n"));
          if (scan.tail !== "none" && this.sync) await h.datasync();
        } catch (err) { throw await this.fail(err); }
        this.seq = scan.lastSeq;
      }
      const e = { ...body, seq: this.seq + 1, ts, sessionId: this.sessionId } as SessionEvent;
      const line = Buffer.from(JSON.stringify(e) + "\n", "utf8");
      await this.checkGuard(); // a server frozen while its lock was taken over must not write after the takeover
      try {
        await writeAll(h, line);
        if (this.sync) await h.datasync();
      } catch (err) { throw await this.fail(err); }
      this.seq = e.seq;
      await this.checkGuard(); // lost while writing: the event is on disk, but nothing more may follow it
      return e;
    });
  }

  /** Runs the guard; a refusal other than "closed" makes the log fail-stop. */
  private async checkGuard(): Promise<void> {
    if (!this.guard) return;
    try { await this.guard(); }
    catch (err) {
      if ((err as { code?: unknown }).code === "closed") throw err;
      throw await this.fail(err, "the session lock was lost");
    }
  }

  /** Fail-stop: remembers why, closes the handle and returns the error to throw. */
  private async fail(err: unknown, reason?: string): Promise<LogFailedError> {
    this.broken ??= reason ?? `${(err as NodeJS.ErrnoException).code ?? "I/O error"} while writing`;
    this.seq = null;
    await this.dropHandle();
    return new LogFailedError(this.broken);
  }

  all(): Promise<SessionEvent[]> {
    return this.mutex.run(async () => {
      const out: SessionEvent[] = [];
      await this.read((e) => out.push(e));
      return out;
    });
  }

  replay(fn: (e: SessionEvent) => void): Promise<ReplayResult> {
    return this.mutex.run(async () => {
      const r = await this.read(fn);
      return { events: r.events, partialTailBytes: r.partialTailBytes };
    });
  }

  /** Closes the handle; later appends are refused (reads still work). */
  close(): Promise<void> { return this.mutex.run(async () => { this.closed = true; await this.dropHandle(); }); }

  private async dropHandle(): Promise<void> {
    const h = this.handle;
    this.handle = null;
    if (h) { try { await h.close(); } catch { /* already closed */ } }
  }

  /** The append handle, opened once: O_APPEND | O_CREAT | O_NOFOLLOW, mode 0600. */
  private async writable(): Promise<FileHandle> {
    if (this.handle) return this.handle;
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const h = await open(this.file, fsConstants.O_RDWR | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW, 0o600);
    try {
      const st = await h.stat();
      checkOwnFile(path.basename(this.file), st);
      if ((st.mode & 0o077) !== 0) await h.chmod(0o600); // a log from before US-0018: owner-only from now on
      if (st.size === 0) await fsyncDir(this.dir); // a new (or empty) log: make its directory entry durable too
    } catch (err) { await h.close(); throw err; }
    this.handle = h;
    return h;
  }

  /** Reads through the append handle when it is open, else through a read-only descriptor; a missing file is an empty log. */
  private async read(fn: (e: SessionEvent) => void): Promise<ScanResult> {
    if (this.handle) return this.scan(this.handle, fn);
    let h: FileHandle;
    try { h = await open(this.file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_SCAN;
      throw err;
    }
    try {
      checkOwnFile(path.basename(this.file), await h.stat());
      return await this.scan(h, fn);
    } finally { await h.close(); }
  }

  private async scan(h: FileHandle, fn: ((e: SessionEvent) => void) | null): Promise<ScanResult> {
    const name = path.basename(this.file);
    const size = (await h.stat()).size;
    if (size > this.maxBytes) throw new LogCorruptError(`${name} is larger than ${Math.round(this.maxBytes / 1024 / 1024)} MiB; it is not read`);
    let lastSeq = 0; let lineNo = 0; let goodBytes = 0; let events = 0;
    let pending: Buffer[] = []; let pendingLen = 0;
    /** One line: "blank", "partial" (only possible for the final, newline-less line) or "event". Throws on anything invalid. */
    const handleLine = (line: Buffer, final: boolean): "blank" | "partial" | "event" => {
      lineNo++;
      const text = line.toString("utf8");
      if (text.trim() === "") return "blank";
      let v: unknown;
      try { v = JSON.parse(text); }
      catch {
        if (final) return "partial"; // a crash mid-write can cut only the last line
        throw new LogCorruptError(`malformed event in ${name} at line ${lineNo}`);
      }
      const e = v as Partial<SessionEvent> | null;
      const where = `in ${name} at line ${lineNo}`;
      if (!e || typeof e !== "object" || Array.isArray(e)) throw new LogCorruptError(`malformed event ${where}: not an object`);
      if (!Number.isSafeInteger(e.seq) || e.seq !== lastSeq + 1) throw new LogCorruptError(`invalid event ${where}: seq ${String(e.seq).slice(0, 20)} where ${lastSeq + 1} was expected (a gap, a duplicate or out of order)`);
      if (typeof e.ts !== "number" || !Number.isFinite(e.ts)) throw new LogCorruptError(`invalid event ${where}: no numeric ts`);
      if (e.sessionId !== this.sessionId) throw new LogCorruptError(`invalid event ${where}: it belongs to another session`);
      if (!isKnownEventType(e.type)) throw new LogCorruptError(`invalid event ${where}: unknown event type (a log written by a newer version?)`);
      lastSeq = e.seq; events++;
      fn?.(e as SessionEvent);
      return "event";
    };
    const buf = Buffer.alloc(CHUNK);
    let pos = 0;
    while (pos < size) {
      const { bytesRead } = await h.read(buf, 0, Math.min(CHUNK, size - pos), pos);
      if (bytesRead === 0) break;
      let start = 0;
      for (let i = buf.indexOf(0x0a, 0); i !== -1 && i < bytesRead; i = buf.indexOf(0x0a, i + 1)) {
        const piece = buf.subarray(start, i);
        const line = pendingLen ? Buffer.concat([...pending, piece]) : piece;
        pending = []; pendingLen = 0;
        handleLine(line, false);
        goodBytes = pos + i + 1;
        start = i + 1;
      }
      if (start < bytesRead) {
        pendingLen += bytesRead - start;
        if (pendingLen > MAX_EVENT_LINE_BYTES) throw new LogCorruptError(`invalid event in ${name} at line ${lineNo + 1}: longer than ${MAX_EVENT_LINE_BYTES} bytes`);
        pending.push(Buffer.from(buf.subarray(start, bytesRead)));
      }
      pos += bytesRead;
    }
    if (pendingLen === 0) return { lastSeq, goodBytes, tail: "none", partialTailBytes: 0, events };
    const last = Buffer.concat(pending);
    const kind = handleLine(last, true);
    if (kind === "event") return { lastSeq, goodBytes: goodBytes + last.length, tail: "newline", partialTailBytes: 0, events };
    return { lastSeq, goodBytes, tail: "cut", partialTailBytes: last.length, events };
  }
}

async function writeAll(h: FileHandle, data: Buffer): Promise<void> {
  let off = 0;
  while (off < data.length) {
    const { bytesWritten } = await h.write(data, off, data.length - off);
    if (bytesWritten <= 0) throw Object.assign(new Error("the log write made no progress"), { code: "EIO" });
    off += bytesWritten;
  }
}
