import type { Options } from "./commands.js";
import { isFatalError, joinMessage, parseInput, parseServerMessage } from "./commands.js";
import { parseFactsEarned, parseHiddenFacts, renderError, renderEvent, renderHidden, renderJoined, renderNewReleases, sanitizeText } from "./render.js";

export const MAX_PREJOIN_LINES = 100;
export const DEFAULT_IDLE_MS = 1_500;

export type Sock = { send(data: string): void; close(): void; terminate(): void };
export type Io = {
  /** Prints one already-sanitized line (and redraws the prompt). */
  print(line: string): void;
  err(line: string): void;
  closeInput(): void;
  exit(code: number): void;
};

/**
 * Terminal client logic with every side effect injected, so it is testable without a TTY or a socket.
 * Lines typed before `joined` are buffered (max 100, then refused with a message) and flushed in order once joined.
 * Only an error before `joined` is fatal. On stdin EOF after joining nothing more is sent: the client waits for the
 * socket to go quiet (idle window reset by every incoming message) or close, then exits 0.
 */
export function createClient(deps: { opts: Options; sock: Sock; io: Io; idleMs?: number; joinWaitMs?: number }) {
  const { opts, sock, io } = deps;
  const idleMs = deps.idleMs ?? DEFAULT_IDLE_MS;
  const joinWaitMs = deps.joinWaitMs ?? 10_000;
  let joined = false;
  let done = false;
  let eof = false;
  let idleTimer: NodeJS.Timeout | null = null;
  const pending: unknown[] = [];
  // Facilitator only: the hidden facts the server listed at join, and which of them are released (from the snapshot and the live npc.updated events).
  let hiddenFacts = new Map<string, string[]>();
  const released = new Map<string, string[]>();
  // US-0034: the facts the Game Master suggested releasing (joined snapshot, then live gm.fact_earned events).
  let suggested = new Map<string, number[]>();

  function finish(code: number, message?: string, polite = false): void {
    if (done) return;
    done = true;
    if (idleTimer) clearTimeout(idleTimer);
    if (message) io.err(message);
    try { polite ? sock.close() : sock.terminate(); } catch { /* already closed */ }
    io.closeInput();
    io.exit(code);
  }
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => finish(0, undefined, true), idleMs);
  };
  const send = (m: unknown) => sock.send(JSON.stringify(m));

  return {
    onOpen(): void { send(joinMessage(opts)); },
    onError(err: Error): void {
      const e = err as NodeJS.ErrnoException;
      finish(1, `connection failed: ${sanitizeText(e.message || e.code || "unknown error")} (${sanitizeText(opts.url)})`);
    },
    onClose(): void {
      if (done) return;
      if (eof && joined) return finish(0);
      finish(1, "disconnected from server");
    },
    onMessage(raw: string): void {
      if (done) return;
      const m = parseServerMessage(raw);
      if (!m) return;
      if (eof && joined) armIdle();
      if (m.type === "joined") {
        joined = true;
        if (opts.facilitator) {
          hiddenFacts = parseHiddenFacts(m.hiddenFacts);
          suggested = parseFactsEarned((m.state as { factsEarned?: unknown } | undefined)?.factsEarned);
          const npcs = (m.state as { npcs?: unknown } | undefined)?.npcs;
          if (typeof npcs === "object" && npcs !== null) for (const [role, n] of Object.entries(npcs)) {
            const r = (n as { released?: unknown } | null)?.released;
            if (Array.isArray(r)) released.set(role, r.filter((t): t is string => typeof t === "string"));
          }
        }
        for (const l of renderJoined(m)) io.print(l);
        for (const queued of pending.splice(0)) send(queued);
        if (eof) armIdle();
      } else if (m.type === "event") {
        const line = renderEvent(m.event, opts.facilitator ? "facilitator" : opts.role!);
        if (line) io.print(line);
        if (opts.facilitator && m.event.type === "gm.fact_earned" && Number.isInteger(m.event.fact)) {
          const had = suggested.get(m.event.roleId) ?? [];
          if (!had.includes(m.event.fact)) suggested.set(m.event.roleId, [...had, m.event.fact]);
        }
        if (opts.facilitator && m.event.type === "npc.updated") {
          for (const l of renderNewReleases(m.event, hiddenFacts, released)) io.print(l);
          if (Array.isArray(m.event.released)) released.set(m.event.roleId, m.event.released.filter((t): t is string => typeof t === "string"));
        }
      } else if (isFatalError(m.code, joined)) {
        finish(1, renderError(m.code, m.message, !opts.facilitator));
      } else {
        io.print(renderError(m.code, m.message, !opts.facilitator));
      }
    },
    onLine(line: string): void {
      if (done || eof) return;
      const input = parseInput(line, opts.facilitator);
      switch (input.kind) {
        case "none": return;
        case "quit": return finish(0, undefined, true);
        case "help": return io.print(input.message);
        case "hidden":
          if (!joined) return io.print("not joined yet");
          io.print("hidden facts (the numbers are for /release <role> <n>):");
          for (const l of renderHidden(hiddenFacts, released, suggested)) io.print(l);
          return;
        case "send":
          if (joined) send(input.message);
          else if (pending.length < MAX_PREJOIN_LINES) pending.push(input.message);
          else io.print("not joined yet: too many queued lines, dropped");
      }
    },
    onEof(): void {
      if (done) return;
      eof = true;
      if (joined) return armIdle();
      // Piped input can end before the join completes: if lines are queued, wait (bounded) for the join and flush them.
      if (!pending.length) return finish(1, "input ended before joining the session");
      idleTimer = setTimeout(() => finish(1, "input ended and the server never confirmed the join"), joinWaitMs);
    },
    onSigint(): void { finish(0, undefined, true); },
  };
}
