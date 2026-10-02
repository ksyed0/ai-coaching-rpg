import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { EventBody, SessionEvent } from "@acr/events";

export interface EventLog {
  readonly sessionId: string;
  append(body: EventBody, ts: number): Promise<SessionEvent>;
  all(): Promise<SessionEvent[]>;
}

export class MemoryEventLog implements EventLog {
  private events: SessionEvent[] = [];
  constructor(readonly sessionId: string) {}
  async append(body: EventBody, ts: number): Promise<SessionEvent> {
    const e = { ...body, seq: this.events.length + 1, ts, sessionId: this.sessionId } as SessionEvent;
    this.events.push(e);
    return e;
  }
  async all() { return [...this.events]; }
}

export class JsonlEventLog implements EventLog {
  private seq = 0;
  private file: string;
  constructor(readonly sessionId: string, dir = "data/sessions") { this.file = path.join(dir, `${sessionId}.jsonl`); }
  async append(body: EventBody, ts: number): Promise<SessionEvent> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const e = { ...body, seq: ++this.seq, ts, sessionId: this.sessionId } as SessionEvent;
    await appendFile(this.file, JSON.stringify(e) + "\n", "utf8");
    return e;
  }
  async all(): Promise<SessionEvent[]> {
    try { return (await readFile(this.file, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as SessionEvent); }
    catch { return []; }
  }
}
