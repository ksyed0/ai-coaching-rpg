import type { SessionEvent, SessionState } from "@acr/events";
import { initialState } from "@acr/events";
import type { Clock } from "../clock";

/** A stand-in for the browser's EventSource: the test pushes named events and drops or fails the connection by hand. */
export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readyState = 0;
  closed = false;
  onerror: ((e: Event) => void) | null = null;
  onopen: ((e: Event) => void) | null = null;
  private readonly listeners = new Map<string, Set<(e: MessageEvent) => void>>();

  constructor(public readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  static reset(): void { FakeEventSource.instances = []; }
  static last(): FakeEventSource {
    const es = FakeEventSource.instances.at(-1);
    if (!es) throw new Error("no EventSource was opened");
    return es;
  }

  addEventListener(type: string, fn: (e: MessageEvent) => void): void {
    let set = this.listeners.get(type);
    if (!set) { set = new Set(); this.listeners.set(type, set); }
    set.add(fn);
  }
  removeEventListener(type: string, fn: (e: MessageEvent) => void): void { this.listeners.get(type)?.delete(fn); }

  close(): void { this.closed = true; this.readyState = 2; }

  /** A named SSE event as the browser delivers it (a closed source delivers nothing, as in a browser). */
  emit(type: string, data: unknown, lastEventId = ""): void {
    if (this.closed) return;
    this.readyState = 1;
    const ev = new MessageEvent(type, { data: typeof data === "string" ? data : JSON.stringify(data), lastEventId });
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
    // In a browser `onerror` is the handler for every event named "error", so a server-sent `event: error` reaches it too.
    if (type === "error") this.onerror?.(ev);
  }

  /** The connection dropped; the browser will reconnect by itself (readyState CONNECTING). */
  drop(): void { this.readyState = 0; this.error(); }
  /** The browser gave up (a non-200 answer): readyState CLOSED. */
  fail(): void { this.readyState = 2; this.error(); }
  /** A browser fires a plain Event named "error" (no data) to onerror AND to "error" listeners, like a server-sent `event: error`. */
  private error(): void {
    const e = new Event("error");
    this.onerror?.(e);
    for (const fn of this.listeners.get("error") ?? []) fn(e as MessageEvent);
  }
}

/** A clock the test moves; `every` callbacks run only when the test calls `tick`. */
export class FakeClock implements Clock {
  private readonly fns = new Set<() => void>();
  constructor(public t: number) {}
  now = (): number => this.t;
  every = (_ms: number, fn: () => void): (() => void) => {
    this.fns.add(fn);
    return () => { this.fns.delete(fn); };
  };
  tick(ms: number): void {
    this.t += ms;
    for (const fn of [...this.fns]) fn();
  }
  get listeners(): number { return this.fns.size; }
}

/** A recording fetch that answers with an envelope; `hold` keeps answers pending until `release`. */
export function fakeFetch(answer: (url: string, body: unknown) => { status: number; body: unknown } = () => ({ status: 200, body: ok({}) })) {
  const calls: { url: string; init: RequestInit; body: unknown }[] = [];
  let held: (() => void)[] | null = null;
  const fn = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    const body = typeof init.body === "string" ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ url, init, body });
    if (held) await new Promise<void>((r) => held!.push(r));
    const a = answer(url, body);
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "Content-Type": "application/json" } });
  };
  return {
    fetch: fn as typeof fetch,
    calls,
    hold() { held = []; },
    release() { const h = held ?? []; held = null; for (const r of h) r(); },
  };
}

export const ok = (data: unknown) => ({ success: true, data, error: null, meta: { version: "1.0", timestamp: "x" } });
export const refused = (code: string, message: string) => ({ success: false, data: null, error: { code, message }, meta: { version: "1.0", timestamp: "x" } });

/** A redacted join snapshot as a player gets it. */
export function snapshot(over: Partial<SessionState> = {}): SessionState {
  return { ...initialState(), ...over };
}

export function joinedFrame(over: Record<string, unknown> = {}) {
  return {
    roleId: "account_manager",
    brief: "You own the client relationship.",
    privateFacts: ["The contract allows one paid change request."],
    consent: { noticeVersion: "v1", notice: "This session is recorded as text.", given: false },
    scenes: [
      { id: "s1", title: "Kick-off", goal: "Agree the agenda.", timeBoxMinutes: 5 },
      { id: "s2", title: "Client call", goal: "Agree what happens to the module.", timeBoxMinutes: 10 },
    ],
    state: snapshot(),
    logIdentity: "log-1",
    replay: { afterSeq: 0, toSeq: 0, events: 0, complete: true },
    ...over,
  };
}

let seqTs = 1_000;
export function ev<T extends SessionEvent["type"]>(seq: number, type: T, body: Omit<Extract<SessionEvent, { type: T }>, "seq" | "ts" | "sessionId" | "type">, ts?: number): SessionEvent {
  return { seq, ts: ts ?? (seqTs += 1_000), sessionId: "sess-1", type, ...body } as unknown as SessionEvent;
}
