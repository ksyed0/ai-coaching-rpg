import { MAX_RETRY_AFTER_MS, ModelProviderError, isTransientModelError, type ModelErrorKind } from "./errors.js";
import type { ChatRequest, ModelProvider } from "./types.js";

/** The one place the retry defaults live (the runtime's MODEL_MAX_RETRIES / MODEL_RETRY_BASE_MS defaults import these). */
export const DEFAULT_MODEL_MAX_RETRIES = 2;
export const DEFAULT_MODEL_RETRY_BASE_MS = 500;
export const DEFAULT_MODEL_RETRY_CAP_MS = 4_000;
const JITTER = 0.25;

export type RetryInfo = { attempt: number; kind: ModelErrorKind; status?: number; delayMs: number };

export type RetryOptions = {
  /** Retries after the first attempt (so up to 1 + maxRetries attempts). 0 disables retrying. Default 2. */
  maxRetries?: number;
  /** First backoff; doubles per retry up to capMs. Default 500 ms. */
  baseMs?: number;
  /** Upper bound of the exponential backoff (before jitter). Default 4000 ms. */
  capMs?: number;
  /** Upper bound for honoring a server's Retry-After. Default 10 s. */
  retryAfterCapMs?: number;
  /** Test seams. `sleep` should reject when `signal` aborts; the wrapper also stops waiting on its own. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
  /** Called at most once per stream() call, on its first retry. Receives no secrets: kind, status, attempt number and delay only. */
  onRetry?: (info: RetryInfo) => void;
};

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Resolves like `promise`, but rejects with the signal's reason the moment the signal aborts. */
function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}

function checkNumber(name: string, value: number, min: number, integer: boolean): void {
  if (!Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) {
    throw new RangeError(`${name} must be ${integer ? "an integer" : "a number"} >= ${min}`);
  }
}

/**
 * Retries transient provider failures (ModelProviderError with `transient: true`) while NOTHING has been yielded in the
 * attempt: once any text was yielded, an error propagates unchanged, so output is never duplicated or spliced. Backoff is
 * min(capMs, baseMs * 2^(attempt-1)) with +/-25% jitter, raised to the server's Retry-After when it is longer (capped).
 *
 * Retries can never outlive the caller's deadlines: the wait is cut short by `signal`, which then propagates its abort
 * error. Callers (the NPC agent's first-token and reply deadlines, shutdown) keep owning those deadlines.
 * A permanent error, or the last transient one, is rethrown as a ModelProviderError with the same kind/transient/status
 * and an `attempts` count. Errors that are not ModelProviderErrors (and every abort) pass through untouched.
 * No state is shared between calls, so concurrent stream() calls are independent. `name` is the wrapped provider's.
 */
export class RetryingModelProvider implements ModelProvider {
  readonly name: string;
  private readonly maxRetries: number;
  private readonly baseMs: number;
  private readonly capMs: number;
  private readonly retryAfterCapMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly onRetry?: (info: RetryInfo) => void;

  constructor(private readonly inner: ModelProvider, opts: RetryOptions = {}) {
    this.name = inner.name;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MODEL_MAX_RETRIES;
    this.baseMs = opts.baseMs ?? DEFAULT_MODEL_RETRY_BASE_MS;
    this.capMs = opts.capMs ?? DEFAULT_MODEL_RETRY_CAP_MS;
    this.retryAfterCapMs = opts.retryAfterCapMs ?? MAX_RETRY_AFTER_MS;
    checkNumber("maxRetries", this.maxRetries, 0, true);
    checkNumber("baseMs", this.baseMs, 1, false);
    checkNumber("capMs", this.capMs, 1, false);
    checkNumber("retryAfterCapMs", this.retryAfterCapMs, 0, false);
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? Date.now;
    this.onRetry = opts.onRetry;
  }

  private delayFor(attempt: number, err: ModelProviderError): number {
    const backoff = Math.min(this.capMs, this.baseMs * 2 ** (attempt - 1));
    const jittered = Math.max(0, Math.round(backoff * (1 + (this.random() * 2 - 1) * JITTER)));
    return err.retryAfterMs === undefined ? jittered : Math.max(jittered, Math.min(this.retryAfterCapMs, err.retryAfterMs));
  }

  async *stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<string> {
    const started = this.now();
    for (let attempt = 1; ; attempt++) {
      signal?.throwIfAborted();
      let yielded = false;
      try {
        for await (const chunk of this.inner.stream(req, signal)) { yielded = true; yield chunk; }
        return;
      } catch (err) {
        if (signal?.aborted || yielded || !(err instanceof ModelProviderError)) throw err;
        const exhausted = !isTransientModelError(err) || attempt > this.maxRetries;
        if (exhausted) {
          throw new ModelProviderError(err.message, {
            kind: err.kind, transient: err.transient, status: err.status, retryAfterMs: err.retryAfterMs, attempts: attempt, elapsedMs: this.now() - started,
          });
        }
        const delayMs = this.delayFor(attempt, err);
        if (attempt === 1) {
          try { this.onRetry?.({ attempt, kind: err.kind, ...(err.status !== undefined ? { status: err.status } : {}), delayMs }); } catch { /* logging must never break a call */ }
        }
        await untilAborted(this.sleep(delayMs, signal), signal);
      }
    }
  }
}

/** Convenience: `withRetry(provider, opts)` is `new RetryingModelProvider(provider, opts)`. */
export function withRetry(provider: ModelProvider, opts?: RetryOptions): RetryingModelProvider {
  return new RetryingModelProvider(provider, opts);
}
