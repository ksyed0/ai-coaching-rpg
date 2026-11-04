import type { ModelProvider } from "@acr/adapters";
import type { Scenario } from "@acr/script";
import type { AiPlayerSettings } from "@acr/runtime/players";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { cleanHint } from "@acr/runtime/players";
import { ControlError, type SetTimer } from "../supervisor.js";
import { AiPlayerBot } from "./bot.js";
import { BOT_ALERTS } from "./bot-alerts.js";
import type { BotSocket } from "./bot-socket.js";
import { SessionBudget } from "./budget.js";
import type { IntentEntry, IntentLog } from "./intent-log.js";

/** B18: the delay before the first re-attach of a dropped bot; it doubles per consecutive failure up to the cap. */
export const REATTACH_BASE_MS = 2_000;
export const REATTACH_MAX_MS = 30_000;
/** After this many consecutive failed re-attaches the host raises `rejoinFailed` once and stops retrying. */
export const REATTACH_MAX_FAILS = 5;

/** A reservation holds the policy for at most this long (B17). */
export const RESERVATION_TTL_MS = 15_000; // by ruling (spec: 10 s): the hub waits 10 s for a command ack, so the reservation must outlive it
/** A new prompt is refused (ai_busy) this soon after the last one started. */
export const PROMPT_DEBOUNCE_MS = 5_000;

const defaultSetTimer: SetTimer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref(); return () => clearTimeout(t); };
const noop = (): void => undefined;

export type BotHostOptions = {
  provider: ModelProvider; settings: AiPlayerSettings; intents: IntentLog;
  scenarioFor: (sessionId: string) => Promise<Scenario>;
  reissue: (sessionId: string, roleId: string) => Promise<string>;
  alert: (sessionId: string, roleId: string, message: string) => void;
  log?: (m: string) => void; now?: () => number; setTimer?: SetTimer; open?: typeof BotSocket.open;
};

/** Re-attach bookkeeping of one role. A fresh object replaces it when it is cancelled, so a queued stale timer can tell. */
type Retry = { fails: number; attempting: boolean; stopped: boolean; cancel: (() => void) | null };

type Sess = {
  port?: number;
  aiRoles: Set<string>;
  /** Join codes: this Map is the only place they live. */
  codes: Map<string, string>;
  budget?: SessionBudget;
  scenario?: Scenario;
  bots: Map<string, AiPlayerBot>;
  retries: Map<string, Retry>;
  reissuing: Set<string>;
  reissueAlerted: Set<string>;
  /** True once `attach` has run: from then on only roles in `aiRoles` take codes. */
  attached: boolean;
  /** Roles removed by `removeRoles` before any attach. */
  removed: Set<string>;
  /** The port and code each bot was last attached with (to skip a no-op re-attach). */
  bound: Map<string, { port: number; code: string }>;
  /** Prompt reservations by role: the token lives here only (memory), with the timer that expires it. */
  reservations: Map<string, { token: string; cancel: () => void }>;
  lastPrompt: Map<string, number>;
};

/**
 * Note for the supervisor (Task 9): a role switched back to human needs `removeRoles` (B12 deletes its intent file there); `attach` with
 * a reduced role set stops that bot and forgets its code but keeps the intent file.
 *
 * US-0060: owns the live AI player bots of every session: their join codes, the shared per-session model budget, and the re-attach of a
 * dropped bot. Every mutating method runs on a per-session promise chain (one operation at a time; a failed one does not break it). The
 * host never awaits `reissue` inside the chain: its result is queued on the chain as a code assignment. Codes are only ever held in a
 * private Map and never reach `log`, `alert` or an Error message.
 */
export class BotHost {
  private readonly sessions = new Map<string, Sess>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly setTimer: SetTimer;
  private readonly log: (m: string) => void;
  private readonly now: () => number;
  /** Set at the start of close(): every operation queued or enqueued after it does nothing. */
  private closed = false;

  constructor(private readonly o: BotHostOptions) {
    this.setTimer = o.setTimer ?? defaultSetTimer;
    this.log = o.log ?? noop;
    this.now = o.now ?? Date.now;
  }

  // --- public API ---

  /**
   * `codes` (optional) are the join codes of roles that just became AI: stored before the reissue decision, so a role taken in with its
   * code never asks for a reissue. A code for a role not in `aiRoles` is dropped.
   */
  attach(sessionId: string, o: { port: number; aiRoles: string[]; aiCalls?: number; codes?: { roleId: string; code: string }[] }): Promise<void> {
    return this.enqueue(sessionId, async () => {
      const st = this.state(sessionId);
      st.port = o.port;
      st.attached = true;
      st.budget ??= new SessionBudget(this.o.settings.callsPerSession, o.aiCalls ?? 0);
      const wanted = new Set(o.aiRoles);
      await this.stopBots(st, [...st.bots.keys()].filter((r) => !wanted.has(r)));
      for (const r of [...st.aiRoles]) if (!wanted.has(r)) { st.aiRoles.delete(r); st.codes.delete(r); this.cancelRetry(st, r); }
      st.aiRoles = wanted;
      for (const r of wanted) st.removed.delete(r);
      for (const c of o.codes ?? []) if (wanted.has(c.roleId)) st.codes.set(c.roleId, c.code);
      const work: Promise<void>[] = [];
      for (const r of wanted) {
        this.cancelRetry(st, r);
        if (st.codes.has(r)) work.push(this.attemptAttach(st, sessionId, r, true));
        else this.requestCode(st, sessionId, r);
      }
      await Promise.all(work);
    });
  }

  setCodes(sessionId: string, codes: { roleId: string; code: string }[]): Promise<void> {
    return this.enqueue(sessionId, () => {
      const st = this.state(sessionId);
      const take = codes.filter((c) => {
        // Before the first attach any role may be given a code; after it (or once removed) only a current AI role.
        if (!st.attached && !st.removed.has(c.roleId)) return true;
        if (st.aiRoles.has(c.roleId)) return true;
        this.log(`session ${sessionId} ignored a code for a non-AI role ${c.roleId}`);
        return false;
      });
      return this.applyCodes(st, sessionId, take);
    });
  }

  removeRoles(sessionId: string, roles: string[]): Promise<void> {
    return this.enqueue(sessionId, async () => {
      const st = this.state(sessionId);
      await this.stopBots(st, roles);
      for (const r of roles) { st.aiRoles.delete(r); st.codes.delete(r); st.bound.delete(r); st.removed.add(r); }
      // Stopped first: a late model reply of the stopped bot cannot recreate the file.
      for (const r of roles) this.o.intents.remove(sessionId, r);
    });
  }

  // --- prompted turns (B5, B16, B17). Synchronous and outside the chain: they only read bot state and the reservation map. ---

  reserve(sessionId: string, roleId: string): string {
    const st = this.sessions.get(sessionId);
    const bot = st?.bots.get(roleId);
    if (!st || !bot || !st.aiRoles.has(roleId) || !bot.joinedOk) throw new ControlError("ai_absent", "that AI player is not available");
    const last = st.lastPrompt.get(roleId);
    if (bot.speaking || !bot.canPrompt || st.reservations.has(roleId) || (last !== undefined && this.now() - last < PROMPT_DEBOUNCE_MS)) throw new ControlError("ai_busy", "that AI player is busy");
    if (st.budget?.exhausted) throw new ControlError("ai_budget", "the AI player budget for this session is used up");
    const token = randomBytes(16).toString("hex");
    const cancel = this.setTimer(() => { if (st.reservations.get(roleId)?.token === token) { st.reservations.delete(roleId); bot.setHeld(false); } }, RESERVATION_TTL_MS);
    st.reservations.set(roleId, { token, cancel });
    bot.setHeld(true);
    return token;
  }

  /** The reservation of this (session, role) when `token` matches it (constant time); undefined otherwise. */
  private reservationFor(st: Sess, roleId: string, token: string): { token: string; cancel: () => void } | undefined {
    const r = st.reservations.get(roleId);
    // Shape first: timingSafeEqual throws on different byte lengths, which a non-ASCII token of the right length would have.
    if (!r || typeof token !== "string" || !/^[0-9a-f]{32}$/.test(token)) return undefined;
    return timingSafeEqual(Buffer.from(token), Buffer.from(r.token)) ? r : undefined;
  }

  run(sessionId: string, roleId: string, reservation: string, hint: unknown): void {
    const st = this.sessions.get(sessionId);
    const r = st ? this.reservationFor(st, roleId, reservation) : undefined;
    if (!st || !r) throw new ControlError("ai_expired", "that reservation is not valid any more");
    r.cancel();
    st.reservations.delete(roleId); // consumed once
    const bot = st.bots.get(roleId);
    bot?.setHeld(false);
    if (!bot || !bot.joinedOk) throw new ControlError("ai_absent", "that AI player is not available");
    // The hint is cleaned here and goes to the bot only: it is never logged, alerted or put in an error.
    if (!bot.runPrompt(cleanHint(hint))) throw new ControlError("ai_busy", "that AI player is busy");
    st.lastPrompt.set(roleId, this.now());
  }

  release(sessionId: string, roleId: string, reservation: string): void {
    const st = this.sessions.get(sessionId);
    const r = st ? this.reservationFor(st, roleId, reservation) : undefined;
    if (!st || !r) return;
    r.cancel();
    st.reservations.delete(roleId);
    st.bots.get(roleId)?.setHeld(false);
  }

  private clearReservations(st: Sess, roles?: string[]): void {
    for (const [r, v] of [...st.reservations]) {
      if (roles && !roles.includes(r)) continue;
      v.cancel();
      st.reservations.delete(r);
      st.bots.get(r)?.setHeld(false); // the hold belongs to the reservation
    }
  }

  /**
   * Closes the sockets; codes and budget stay. The port is forgotten (a later `attach` supplies it), so a reissue result or a late
   * `setCodes` that arrives after a detach cannot reconnect to a possibly dead port.
   */
  detach(sessionId: string): Promise<void> {
    return this.enqueue(sessionId, async () => {
      const st = this.sessions.get(sessionId);
      if (!st) return;
      for (const r of [...st.retries.keys()]) this.cancelRetry(st, r);
      this.clearReservations(st);
      st.port = undefined;
      st.bound.clear();
      await Promise.allSettled([...st.bots.values()].map((b) => b.detach()));
    });
  }

  /** Stops every bot and forgets codes, port and budget. Intent files stay (B12). */
  end(sessionId: string): Promise<void> {
    return this.enqueue(sessionId, () => this.endNow(sessionId), true);
  }

  forget(sessionId: string): Promise<void> {
    return this.enqueue(sessionId, async () => {
      await this.endNow(sessionId);
      this.o.intents.remove(sessionId);
    }, true);
  }

  intents(sessionId: string, roleId: string): IntentEntry[] { return this.o.intents.read(sessionId, roleId); }

  /** True only when the role's socket is open AND it has joined (`joinedOk`); an open socket that never got a joined does not count. */
  isAiConnected(sessionId: string, roleId: string): boolean { return this.sessions.get(sessionId)?.bots.get(roleId)?.joinedOk ?? false; }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.end(id)));
  }

  // --- the chain ---

  /** Runs `fn` after everything queued before it on this session; a rejection never poisons the chain. */
  private enqueue(sessionId: string, fn: () => Promise<void>, alwaysRun = false): Promise<void> {
    const prev = this.chains.get(sessionId) ?? Promise.resolve();
    const run = prev.then(() => (this.closed && !alwaysRun ? undefined : fn()));
    const tail = run.catch((err) => { this.log(`session ${sessionId} bot host operation failed: ${err instanceof Error ? err.name : "error"}`); });
    this.chains.set(sessionId, tail);
    void tail.then(() => { if (this.chains.get(sessionId) === tail) this.chains.delete(sessionId); });
    return tail;
  }

  private state(sessionId: string): Sess {
    let st = this.sessions.get(sessionId);
    if (!st) {
      st = { aiRoles: new Set(), codes: new Map(), bots: new Map(), retries: new Map(), reissuing: new Set(), reissueAlerted: new Set(), attached: false, removed: new Set(), bound: new Map(), reservations: new Map(), lastPrompt: new Map() };
      this.sessions.set(sessionId, st);
    }
    return st;
  }

  private async endNow(sessionId: string): Promise<void> {
    const st = this.sessions.get(sessionId);
    if (!st) return;
    this.sessions.delete(sessionId);
    for (const r of [...st.retries.keys()]) this.cancelRetry(st, r);
    this.clearReservations(st);
    st.codes.clear();
    await Promise.allSettled([...st.bots.values()].map((b) => b.stop()));
    st.bots.clear();
  }

  private async stopBots(st: Sess, roles: string[]): Promise<void> {
    const stopping: Promise<void>[] = [];
    this.clearReservations(st, roles);
    for (const r of roles) {
      this.cancelRetry(st, r);
      const b = st.bots.get(r);
      st.bots.delete(r);
      st.bound.delete(r);
      if (b) stopping.push(b.stop());
    }
    await Promise.allSettled(stopping);
  }

  // --- codes ---

  private async applyCodes(st: Sess, sessionId: string, codes: { roleId: string; code: string }[]): Promise<void> {
    const work: Promise<void>[] = [];
    for (const c of codes) {
      st.codes.set(c.roleId, c.code);
      st.aiRoles.add(c.roleId);
      this.cancelRetry(st, c.roleId);
      if (st.port !== undefined) work.push(this.attemptAttach(st, sessionId, c.roleId));
    }
    await Promise.all(work);
  }

  /** Asks for ONE new code without waiting for it; the answer is queued on the chain. A failure logs one line and nothing else. */
  private requestCode(st: Sess, sessionId: string, roleId: string): void {
    if (st.reissuing.has(roleId)) return;
    st.reissuing.add(roleId);
    let p: Promise<string>;
    try { p = this.o.reissue(sessionId, roleId); } catch { p = Promise.reject(new Error("reissue failed")); }
    p.then(
      (code) => {
        st.reissuing.delete(roleId);
        void this.enqueue(sessionId, async () => {
          if (this.sessions.get(sessionId) !== st || !st.aiRoles.has(roleId)) return;
          await this.applyCodes(st, sessionId, [{ roleId, code }]);
        });
      },
      (err: unknown) => {
        st.reissuing.delete(roleId);
        this.log(`session ${sessionId} AI player could not get a code`);
        // The supervisor refuses a role that is no longer AI (or uncertain): nothing to retry and nobody to alert.
        if ((err as { code?: unknown } | null)?.code === "ai_role") return;
        // Told once per role (before the start the runtime ignores the alert, B15).
        if (!st.reissueAlerted.has(roleId)) { st.reissueAlerted.add(roleId); this.raise(sessionId, roleId, BOT_ALERTS.rejoinFailed); }
      },
    );
  }

  // --- bots and re-attach ---

  private retry(st: Sess, roleId: string): Retry {
    let rs = st.retries.get(roleId);
    if (!rs) { rs = { fails: 0, attempting: false, stopped: false, cancel: null }; st.retries.set(roleId, rs); }
    return rs;
  }

  private cancelRetry(st: Sess, roleId: string): void {
    const rs = st.retries.get(roleId);
    if (!rs) return;
    rs.cancel?.();
    rs.cancel = null;
    rs.stopped = true;
    st.retries.delete(roleId);
  }

  /** A failure of `scenarioFor` leaves the role botless until the next `attach`. */
  private async botFor(st: Sess, sessionId: string, roleId: string): Promise<AiPlayerBot | null> {
    const have = st.bots.get(roleId);
    if (have) return have;
    try { st.scenario ??= await this.o.scenarioFor(sessionId); } catch {
      this.log(`session ${sessionId} AI player ${roleId} could not start`);
      return null;
    }
    if (this.sessions.get(sessionId) !== st) return null;
    // The budget is created by `attach` (seeded with aiCalls) before any bot exists; a bot is only ever made once a port is known.
    if (!st.budget) return null;
    const bot = new AiPlayerBot({
      sessionId, roleId, scenario: st.scenario, provider: this.o.provider, settings: this.o.settings, budget: st.budget, intents: this.o.intents,
      alert: (a) => this.raise(sessionId, roleId, BOT_ALERTS[a]),
      needCode: () => { if (this.sessions.get(sessionId) === st) this.requestCode(st, sessionId, roleId); },
      log: (m) => this.log(`session ${sessionId} AI player ${roleId}: ${m}`),
      now: this.now, setTimer: this.setTimer, ...(this.o.open ? { open: this.o.open } : {}),
      onDisconnected: (code) => { if (this.sessions.get(sessionId) === st && st.bots.get(roleId) === bot) this.onDropped(st, sessionId, roleId, code); },
      onJoined: () => { const rs = st.retries.get(roleId); if (rs) { rs.fails = 0; rs.attempting = false; } },
    });
    st.bots.set(roleId, bot);
    return bot;
  }

  /** Attaches the role's bot with its remembered code and port; a failure counts as a failed (re-)attach. */
  private async attemptAttach(st: Sess, sessionId: string, roleId: string, skipIfSame = false): Promise<void> {
    const code = st.codes.get(roleId);
    const port = st.port;
    if (code === undefined || port === undefined) return;
    const bot = await this.botFor(st, sessionId, roleId);
    if (!bot || this.sessions.get(sessionId) !== st) return;
    const b = st.bound.get(roleId);
    if (skipIfSame && bot.connected && b && b.port === port && b.code === code) return;
    const rs = this.retry(st, roleId);
    rs.attempting = true;
    st.bound.delete(roleId);
    try { await bot.attach(port, code); st.bound.set(roleId, { port, code }); } catch {
      if (this.sessions.get(sessionId) !== st || st.retries.get(roleId) !== rs) return;
      this.log(`session ${sessionId} AI player ${roleId} could not connect`);
      this.failed(st, sessionId, roleId, rs);
    }
  }

  private onDropped(st: Sess, sessionId: string, roleId: string, code: number): void {
    if (code >= 4001 && code <= 4004) { this.log(`session ${sessionId} AI player ${roleId} was closed for good (code ${code})`); return; }
    const rs = this.retry(st, roleId);
    if (rs.stopped) return;
    if (rs.attempting) { this.failed(st, sessionId, roleId, rs); return; }
    this.schedule(st, sessionId, roleId, rs);
  }

  private failed(st: Sess, sessionId: string, roleId: string, rs: Retry): void {
    rs.fails += 1;
    if (rs.fails >= REATTACH_MAX_FAILS) {
      rs.stopped = true;
      this.log(`session ${sessionId} AI player ${roleId} could not rejoin`);
      this.raise(sessionId, roleId, BOT_ALERTS.rejoinFailed);
      return;
    }
    this.schedule(st, sessionId, roleId, rs);
  }

  private schedule(st: Sess, sessionId: string, roleId: string, rs: Retry): void {
    if (rs.cancel) return;
    const delay = Math.min(REATTACH_BASE_MS * 2 ** rs.fails, REATTACH_MAX_MS);
    rs.cancel = this.setTimer(() => {
      rs.cancel = null;
      void this.enqueue(sessionId, async () => {
        if (this.sessions.get(sessionId) !== st || st.retries.get(roleId) !== rs || rs.stopped) return;
        await this.attemptAttach(st, sessionId, roleId);
      });
    }, delay);
  }

  private raise(sessionId: string, roleId: string, message: string): void {
    try { this.o.alert(sessionId, roleId, message); } catch { this.log(`session ${sessionId} AI player ${roleId} alert failed`); }
  }
}
