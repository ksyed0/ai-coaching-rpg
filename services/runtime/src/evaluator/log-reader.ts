import { open } from "node:fs/promises";
import { initialState, reduce, type SessionEvent } from "@acr/events";

/** A session log is a few hundred KiB; refuse anything that would not fit comfortably in memory. */
export const MAX_LOG_BYTES = 64 * 1024 * 1024;

export class SessionLogError extends Error {
  constructor(message: string) { super(message); this.name = "SessionLogError"; }
}

/** Parses JSONL text into events, tolerating a truncated final line (a crash mid-write), and checks seq runs 1..n by replaying the reducer. */
export function parseSessionLog(text: string): SessionEvent[] {
  const lines = text.split("\n");
  const events: SessionEvent[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line) as SessionEvent); }
    catch {
      if (lines.slice(i + 1).every((l) => !l.trim())) break; // only the final line may be cut short
      throw new SessionLogError(`malformed event at line ${i + 1}`);
    }
  }
  if (events.length === 0) throw new SessionLogError("the log holds no events");
  let state = initialState();
  try { for (const e of events) state = reduce(state, e); }
  catch (err) { throw new SessionLogError(`the log is not a valid session log: ${(err as Error).message}`); }
  if (state.scenarioId === null) throw new SessionLogError("the log has no session.started event");
  return events;
}

/** Reads a session JSONL file (bounded) and parses it. */
export async function readSessionLog(file: string): Promise<SessionEvent[]> {
  let text: string;
  let fh;
  try {
    fh = await open(file, "r");
    const { size } = await fh.stat();
    if (size > MAX_LOG_BYTES) throw new SessionLogError(`the log is larger than ${MAX_LOG_BYTES / 1024 / 1024} MiB`);
    text = await fh.readFile("utf8");
  } catch (err) {
    if (err instanceof SessionLogError) throw err;
    throw new SessionLogError(`cannot read the session log (${(err as NodeJS.ErrnoException).code ?? "failed"})`);
  } finally { await fh?.close(); }
  return parseSessionLog(text);
}
