import { appendFile, mkdir, readFile } from "node:fs/promises";
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

const SESSION_ID = /^[A-Za-z0-9_-]+$/;

export class JsonlEventLog implements EventLog {
  private seq: number | null = null;
  private readonly file: string;
  private readonly mutex = new Mutex();
  constructor(readonly sessionId: string, dir = "data/sessions") {
    if (!SESSION_ID.test(sessionId)) throw new Error(`invalid session id: ${JSON.stringify(sessionId)}`);
    this.file = path.join(dir, `${sessionId}.jsonl`);
  }

  append(body: EventBody, ts: number): Promise<SessionEvent> {
    return this.mutex.run(async () => {
      if (this.seq === null) this.seq = (await this.read()).at(-1)?.seq ?? 0;
      await mkdir(path.dirname(this.file), { recursive: true });
      const e = { ...body, seq: this.seq + 1, ts, sessionId: this.sessionId } as SessionEvent;
      await appendFile(this.file, JSON.stringify(e) + "\n", "utf8");
      this.seq = e.seq; // commit only after a successful write
      return e;
    });
  }

  all(): Promise<SessionEvent[]> { return this.mutex.run(() => this.read()); }

  private async read(): Promise<SessionEvent[]> {
    let raw: string;
    try { raw = await readFile(this.file, "utf8"); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const lines = raw.split("\n");
    const out: SessionEvent[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      try { out.push(JSON.parse(line) as SessionEvent); }
      catch {
        // a crash mid-write can truncate only the final line
        const isFinal = lines.slice(i + 1).every((l) => !l);
        if (isFinal) break;
        throw new Error(`malformed event in ${this.file} at line ${i + 1}`);
      }
    }
    return out;
  }
}
