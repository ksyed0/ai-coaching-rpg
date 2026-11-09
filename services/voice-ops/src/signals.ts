/**
 * US-0072 (EPIC-0003 voice A1c, Task 7; review B2 F6): the CLI's SIGINT and SIGTERM handling, with the process seams injected.
 *
 * - `up`: the first signal fires the interrupt handlers (voice:up rolls back what it started); every later SIGINT and SIGTERM is ignored
 *   (pnpm relays the terminal's Ctrl-C again and adds a SIGTERM) until the command ends; the CLI then exits 130 (SIGINT) or 143.
 * - every other command (`down`, `check`, `timings`): the first signal ends the process at once, 130 or 143. They roll nothing back, and
 *   ignoring the signal left `voice:check` and `voice:down` running through a Ctrl-C. A voice:down cut short leaves its lock (taken over
 *   by the next run: its pid is dead) and a state it wrote atomically; running it again finishes the job.
 */
export type Interrupt = NodeJS.Signals;
export type SignalHub = { onInterrupt: (fn: () => void) => () => void; signal: () => Interrupt | null };

export const exitCodeOf = (sig: Interrupt): number => (sig === "SIGINT" ? 130 : 143);

export function installSignals(o: { cmd: string | undefined; on: (sig: Interrupt, fn: () => void) => void; exit: (code: number) => void }): SignalHub {
  let got: Interrupt | null = null;
  const handlers = new Set<() => void>();
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    o.on(sig, () => {
      if (got !== null) return; // ignored from the second signal on: the rollback must finish
      got = sig;
      if (o.cmd !== "up") { o.exit(exitCodeOf(sig)); return; }
      for (const fn of handlers) fn();
    });
  }
  return {
    onInterrupt: (fn) => { if (got !== null) queueMicrotask(fn); handlers.add(fn); return () => { handlers.delete(fn); }; },
    signal: () => got,
  };
}
