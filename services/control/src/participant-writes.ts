import { access, constants } from "node:fs/promises";
import { REPORT_SENTENCES } from "@acr/events";
import { submitResponse, submitSelfRatings, type RatingInput, type ResponseInput } from "@acr/runtime/participant";
import type { ControlConfig } from "./config.js";
import { isCredentialId, type ReportAccessStore } from "./report-access.js";
import { LOCK_ATTEMPTS as ATTEMPTS, lockBackoffMs } from "./retry.js";

/** Fixed sentences: no id, path or role is ever part of them. */
export const WRITE_CLOSED = "Ratings are closed for this report. Your facilitator can tell you what is possible now.";
export const WRITE_NOT_RELEASED = "This report has not been released, so there is nothing to respond to yet.";
export const WRITE_WITHDRAWN = "This report was withdrawn, so it cannot take a response.";
export const WRITE_TOO_MANY = "You have reached the limit for this report. Your facilitator can take anything further in the terminal.";
/** BUG-0030: this link (credential) has written its RESPONSES_PER_LINK responses; the shared sentence, also shown by the page. */
export const WRITE_LINK_FULL = REPORT_SENTENCES.linkFull;
// Same wording as MESSAGES.reportOldSchema in apps/web/src/lib/messages.ts: change both together.
export const WRITE_OLD_SCHEMA = "This review was opened before online ratings were available. Your facilitator can take your rating or response in the terminal.";
export const WRITE_BUSY = "The review is busy right now. Try again in a moment.";
export const WRITE_INVALID = "That could not be saved. Check what you entered and try again.";
export const WRITE_THROTTLED = "You are saving too quickly. Wait a little and try again.";
const NOT_FOUND = "Not found.";
const UNAVAILABLE = "Your answer could not be saved right now. Try again.";

export const NOT_WRITABLE_LOG = "reports directory is not writable: web ratings and responses are unavailable";

const LOG_EVERY_MS = 60_000;
const WINDOW_MS = 10 * 60_000;
const MAX_WRITES = 20;

export type WriteCode = "closed" | "not_released" | "withdrawn" | "too_many" | "link_full" | "old_schema" | "invalid" | "busy" | "unavailable" | "throttled";
export type WriteOutcome =
  | { status: 200; wrote: number | boolean }
  | { status: 400 | 404 | 409 | 429 | 503; code: WriteCode | "not_found"; message: string; retryAfterMs?: number };

export type ParticipantWriteService = {
  rate(sessionId: string, credentialId: string, ratings: RatingInput[]): Promise<WriteOutcome>;
  respond(sessionId: string, credentialId: string, input: ResponseInput): Promise<WriteOutcome>;
};

type RuntimeResult = { kind: "ok"; wrote: number | boolean } | { kind: Exclude<WriteCode, "throttled"> | "none" };
type Run = (c: { reportsDir: string; sessionId: string; role: string; credentialId: string; now: () => number; secrets: string[] }) => Promise<RuntimeResult>;

const MESSAGES: Record<Exclude<WriteCode, "throttled">, { status: 400 | 409 | 503; message: string }> = {
  closed: { status: 409, message: WRITE_CLOSED },
  not_released: { status: 409, message: WRITE_NOT_RELEASED },
  withdrawn: { status: 409, message: WRITE_WITHDRAWN },
  too_many: { status: 409, message: WRITE_TOO_MANY },
  link_full: { status: 409, message: WRITE_LINK_FULL },
  old_schema: { status: 409, message: WRITE_OLD_SCHEMA },
  invalid: { status: 400, message: WRITE_INVALID },
  busy: { status: 503, message: WRITE_BUSY },
  unavailable: { status: 503, message: UNAVAILABLE },
};

const notFound = (): WriteOutcome => ({ status: 404, code: "not_found", message: NOT_FOUND });

/**
 * Participant writes (ratings and responses) from a report link. The role always comes from the live credential, never from input.
 *
 * Guarantee: no write attempt begins after a revoke or reissue has returned (the credential is re-checked before EVERY attempt); an
 * attempt already past its credential check may still complete. A check inside the review lock would need an async hook in the
 * runtime's `applyCommand` and is out of scope.
 *
 * Writes of one session run one at a time in this process (a promise chain per session id), so players of the same session never
 * collide on `review.lock` with each other; the retry then only covers a concurrent `moderate` command.
 */
export function createParticipantWriteService(d: {
  config: ControlConfig; store: ReportAccessStore; secrets: string[]; now: () => number;
  sleep: (ms: number) => Promise<void>; random: () => number; log?: (m: string) => void;
}): ParticipantWriteService & { /** @internal Tests only: credentials currently held by the throttle. */ trackedCredentials(): number } {
  const { config, store, secrets, now, sleep, random } = d;
  let lastLog = -Infinity;
  const warn = (m: string): void => {
    const t = now();
    if (!d.log || t - lastLog < LOG_EVERY_MS) return;
    lastLog = t;
    d.log(m);
  };

  // Per-session promise chains, removed when idle.
  const chains = new Map<string, Promise<void>>();
  function serialised<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const run = (chains.get(sessionId) ?? Promise.resolve()).then(fn, fn);
    const tail = run.then(() => undefined, () => undefined);
    chains.set(sessionId, tail);
    void tail.then(() => { if (chains.get(sessionId) === tail) chains.delete(sessionId); });
    return run;
  }

  // Per-credential sliding window of counted writes.
  const windows = new Map<string, number[]>();
  let lastSweep = -Infinity;
  const live = (stamps: number[], t: number): number[] => stamps.filter((s) => t - s < WINDOW_MS);
  function sweep(t: number): void {
    if (t - lastSweep < LOG_EVERY_MS) return;
    lastSweep = t;
    for (const [id, stamps] of windows) {
      const kept = live(stamps, t);
      if (kept.length === 0) windows.delete(id); else windows.set(id, kept);
    }
  }
  /** Milliseconds until the oldest counted write leaves the window when the credential is at its limit, else 0. */
  function waitMs(id: string, t: number): number {
    const kept = live(windows.get(id) ?? [], t);
    if (kept.length === 0) windows.delete(id); else windows.set(id, kept);
    return kept.length >= MAX_WRITES ? kept[0]! + WINDOW_MS - t : 0;
  }
  function count(id: string, t: number): void {
    windows.set(id, [...live(windows.get(id) ?? [], t), t]);
  }

  const refuse = (code: Exclude<WriteCode, "throttled">): WriteOutcome => {
    if (code === "unavailable") warn(NOT_WRITABLE_LOG);
    const m = MESSAGES[code];
    return { status: m.status, code, message: m.message };
  };

  async function write(sessionId: string, credentialId: string, run: Run): Promise<WriteOutcome> {
    if (typeof sessionId !== "string" || !isCredentialId(credentialId)) return notFound();
    return serialised(sessionId, async (): Promise<WriteOutcome> => {
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        let look;
        try { look = await store.checkResult(credentialId, sessionId); } catch { look = { kind: "unavailable" as const }; }
        if (look.kind === "unavailable") { warn("report-access store unreadable"); return refuse("unavailable"); }
        if (look.kind === "refused" || look.credential.sessionId !== sessionId) return notFound();
        const t = now();
        sweep(t);
        if (attempt === 1) {
          const wait = waitMs(credentialId, t);
          if (wait > 0) return { status: 429, code: "throttled", message: WRITE_THROTTLED, retryAfterMs: wait };
        }
        let r: RuntimeResult;
        try {
          r = await run({ reportsDir: config.reportsDir, sessionId, role: look.credential.role, credentialId, now, secrets });
        } catch { r = { kind: "unavailable" }; }
        if (r.kind === "busy" && attempt < ATTEMPTS) {
          await sleep(lockBackoffMs(attempt, random));
          continue;
        }
        if (r.kind === "ok") { count(credentialId, t); return { status: 200, wrote: r.wrote }; }
        // 4xx answers (refusals the participant caused) are not counted; a 503 reached the runtime and is.
        if (r.kind === "none") return refuse("not_released");
        if (r.kind === "busy" || r.kind === "unavailable") count(credentialId, t);
        return refuse(r.kind);
      }
      return refuse("busy");
    });
  }

  return {
    rate: (sessionId, credentialId, ratings) => write(sessionId, credentialId, (c) => submitSelfRatings({ ...c, ratings })),
    respond: (sessionId, credentialId, input) => write(sessionId, credentialId, (c) => submitResponse({ ...c, ...input })),
    trackedCredentials: () => windows.size,
  };
}

/**
 * Start-up check: logs one fixed line when the reports directory exists but cannot be written to. A missing directory is quiet
 * (a fresh deploy has none; it is created when the first report is released). Never throws.
 */
export async function warnIfReportsNotWritable(dir: string, log: (m: string) => void): Promise<void> {
  try { await access(dir, constants.W_OK); } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return;
    try { log(NOT_WRITABLE_LOG); } catch { /* a failing logger must not stop start-up */ }
  }
}
