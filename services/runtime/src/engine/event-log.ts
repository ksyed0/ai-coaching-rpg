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

/** The log cannot be read as a valid event sequence (corruption beyond a cut-off last line, an unknown event type, a seq gap, ...). */
export class LogCorruptError extends Error {
  readonly code = "log_corrupt";
  constructor(message: string) { super(message); this.name = "LogCorruptError"; }
}

export type JsonlLogOptions = {
  /** Refuse a log larger than this many bytes (default MAX_SESSION_LOG_BYTES). */
  maxBytes?: number;
  /** Runs before every append; throws to refuse it (the session lock's assertHeld). */
  guard?: () => void;
  /**
   * fdatasync after every append (default true: what the server always uses). Only the demo's throwaway in-process systems turn it off,
   * since macOS implements it as a full device flush (F_FULLFSYNC) that serialises parallel test runs; durability is the same code path.
   */
  sync?: boolean;
};

type ScanResult = { lastSeq: number; goodBytes: number; tail: "none" | "cut" | "newline"; partialTailBytes: number; events: number };
const EMPTY_SCAN: ScanResult = { lastSeq: 0, goodBytes: 0, tail: "none", partialTailBytes: 0, events: 0 };

const notRegular = (name: string, isDir: boolean) => Object.assign(new Error(`${name} is not a regular file`), { code: isDir ? "EISDIR" : "EINVAL" });

/**
 * The session log on disk: one JSON event per line, `<dir>/<sessionId>.jsonl`.
 *
 * - One append handle (O_APPEND, O_NOFOLLOW), created mode 0600 (an older, wider file is narrowed to 0600) in a 0700 directory;
 *   every append is followed by fdatasync, so an event a client has seen survives a crash or a power cut.
 * - Reads stream the file in 64 KiB chunks through one descriptor (fstat'd; never a path checked and then opened), capped at
 *   `maxBytes`, so memory and time stay bounded.
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
  private readonly guard: (() => void) | undefined;
  private readonly sync: boolean;
  private handle: FileHandle | null = null;
  private closed = false;
  private readonly mutex = new Mutex();
  constructor(readonly sessionId: string, dir = "data/sessions", opts: JsonlLogOptions = {}) {
    if (!isValidSessionId(sessionId)) throw new Error(`invalid session id: ${JSON.stringify(sessionId)}`);
    this.dir = dir;
    this.file = path.join(dir, `${sessionId}.jsonl`);
    this.maxBytes = opts.maxBytes ?? MAX_SESSION_LOG_BYTES;
    this.guard = opts.guard;
    this.sync = opts.sync ?? true;
  }

  append(body: EventBody, ts: number): Promise<SessionEvent> {
    return this.mutex.run(async () => {
      if (this.closed) throw Object.assign(new Error("the session log is closed"), { code: "ECLOSED" });
      try {
        this.guard?.();
        const h = await this.writable();
        if (this.seq === null) {
          const scan = await this.scan(h, null);
          if (scan.tail === "cut") await h.truncate(scan.goodBytes);
          else if (scan.tail === "newline") await writeAll(h, Buffer.from("\n"));
          this.seq = scan.lastSeq;
        }
        const e = { ...body, seq: this.seq + 1, ts, sessionId: this.sessionId } as SessionEvent;
        await writeAll(h, Buffer.from(JSON.stringify(e) + "\n", "utf8"));
        if (this.sync) await h.datasync();
        this.seq = e.seq; // commit only after a successful, synced write
        return e;
      } catch (err) {
        this.seq = null; // a failed write may have left a partial line: re-scan and repair before the next append
        await this.dropHandle();
        throw err;
      }
    });
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
      if (!st.isFile()) throw notRegular(path.basename(this.file), st.isDirectory());
      if ((st.mode & 0o077) !== 0) await h.chmod(0o600); // a log from before US-0018: owner-only from now on
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
      const st = await h.stat();
      if (!st.isFile()) throw notRegular(path.basename(this.file), st.isDirectory());
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
