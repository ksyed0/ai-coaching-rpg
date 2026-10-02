import { appendFile, mkdir, readFile, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { Mutex } from "./mutex.js";
import type { EventBody, SessionEvent } from "@acr/events";

export interface EventLog {
  readonly sessionId: string;
  append(body: EventBody, ts: number): Promise<SessionEvent>;
  all(): Promise<SessionEvent[]>;
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
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The single source of truth for what a session id may be (it becomes a file name). */
export const isValidSessionId = (id: string): boolean => SESSION_ID.test(id);

export class JsonlEventLog implements EventLog {
  private seq: number | null = null;
  private readonly file: string;
  private readonly mutex = new Mutex();
  constructor(readonly sessionId: string, dir = "data/sessions") {
    if (!isValidSessionId(sessionId)) throw new Error(`invalid session id: ${JSON.stringify(sessionId)}`);
    this.file = path.join(dir, `${sessionId}.jsonl`);
  }

  append(body: EventBody, ts: number): Promise<SessionEvent> {
    return this.mutex.run(async () => {
      try {
        await mkdir(path.dirname(this.file), { recursive: true });
        if (this.seq === null) {
          const { events, goodText, raw } = await this.scan();
          if (raw !== goodText) await this.repair(raw, goodText);
          this.seq = events.at(-1)?.seq ?? 0;
        }
        const e = { ...body, seq: this.seq + 1, ts, sessionId: this.sessionId } as SessionEvent;
        await appendFile(this.file, JSON.stringify(e) + "\n", "utf8");
        this.seq = e.seq; // commit only after a successful write
        return e;
      } catch (err) {
        this.seq = null; // a failed write may have left a partial line: re-scan and repair before the next append
        throw err;
      }
    });
  }

  all(): Promise<SessionEvent[]> { return this.mutex.run(async () => (await this.scan()).events); }

  /** Cut a corrupt/partial tail so the next append starts on a clean line, keeping every valid event. */
  private async repair(raw: string, goodText: string): Promise<void> {
    if (raw.startsWith(goodText)) await truncate(this.file, Buffer.byteLength(goodText));
    else await writeFile(this.file, goodText, "utf8");
  }

  private async scan(): Promise<{ events: SessionEvent[]; goodText: string; raw: string }> {
    let raw: string;
    try { raw = await readFile(this.file, "utf8"); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { events: [], goodText: "", raw: "" };
      throw err;
    }
    const lines = raw.split("\n");
    const out: SessionEvent[] = [];
    const goodLines: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      try { out.push(JSON.parse(line) as SessionEvent); goodLines.push(line + "\n"); }
      catch {
        // a crash mid-write can truncate only the final line
        const isFinal = lines.slice(i + 1).every((l) => !l);
        if (isFinal) break;
        throw new Error(`malformed event in ${this.file} at line ${i + 1}`);
      }
    }
    return { events: out, goodText: goodLines.join(""), raw };
  }
}
