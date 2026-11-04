import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { isValidSessionId } from "@acr/events";
import type { BotHost } from "./bots/bot-host.js";
import { buildChildEnv } from "./child-env.js";
import type { ControlConfig } from "./config.js";
import { readLogStatus } from "./log-tail.js";
import { ChildMessageSchema, ParentMessageSchema, RoleIdSchema, type ChildMessage, type ParentMessage } from "./protocol.js";
import { loadScenario } from "@acr/script";
import { isAllowedScenario, scenarioDir } from "./scenarios.js";
import type { SessionList } from "./session-list.js";

export type ControlErrorCode =
  | "capacity" | "unknown_scenario" | "start_failed" | "timeout" | "bad_request" | "not_found" | "conflict" | "unavailable"
  | "ai_role" | "ai_notice" | "ai_started" | "ai_no_human" | "ai_too_many" | "ai_invalid";

/** A plain, safe-to-show failure: the message never carries a path, port, token or code. */
export class ControlError extends Error {
  constructor(readonly code: ControlErrorCode, message: string) { super(message); this.name = "ControlError"; }
}

export type ChildHandle = {
  send(m: ParentMessage): boolean;
  onMessage(fn: (m: ChildMessage) => void): void;
  onExit(fn: (code: number | null) => void): void;
  kill(): void;
  /** SIGKILL: used when kill() was not enough. */
  forceKill(): void;
  disconnect(): void;
};
export type SpawnFn = (o: { env: NodeJS.ProcessEnv; logFile: string }) => ChildHandle;
/** Returns a cancel function. */
export type SetTimer = (fn: () => void, ms: number) => () => void;

export type SessionStatus = "running" | "stopped" | "ended";
export type SessionInfo = { sessionId: string; scenarioId: string; status: SessionStatus; port?: number; modelLabel?: string };
export type CreateResult = { sessionId: string; status: "running"; port: number; modelLabel: string; codes: { roleId: string; code: string }[] };

type Codes = { roleId: string; code: string }[];
type ReadyInfo = { port: number; modelLabel: string; codes?: Codes; aiRoles?: string[]; aiCalls?: number };
type ExitState = { done: boolean; promise?: Promise<void> };
type Proc = { child: ChildHandle; exit: ExitState };
type Live = {
  scenarioId: string; status: SessionStatus; port?: number; modelLabel?: string; child?: ChildHandle; token?: string; graceCancel?: () => void;
  /** The AI roles of the latest ready or successful set_ai_roles; a ready without aiRoles resets it. */
  aiRoles?: string[];
};
/** The runtime's fixed refusal reasons (services/runtime/src/host/set-ai-roles.ts, AI_ROLES_REFUSED) and the control code each becomes. */
export const AI_REFUSALS = new Map<string, ControlErrorCode>([
  ["the consent notice in use does not mention AI players", "ai_notice"],
  ["AI roles can only be changed before the start", "ai_started"],
  ["not a player role of this session", "ai_invalid"],
  ["at least one player role must stay human", "ai_no_human"],
  ["at most 8 player roles can be AI players", "ai_too_many"],
]);
export const AI_ROLES_FAILED = "the AI roles could not be changed";
const AI_ROLE_REFUSED = "switch the role back to human first";
export type AiRolesResult = { roles: string[]; codes: Codes };

type PendingAiRoles = { sessionId: string; child: ChildHandle; resolve: (codes: Codes) => void; reject: (e: ControlError) => void; cancel: () => void; roles: string[] };
type PendingReissue = { sessionId: string; child: ChildHandle; resolve: (code: string) => void; reject: (e: ControlError) => void; cancel: () => void };

const defaultSetTimer: SetTimer = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref();
  return () => clearTimeout(t);
};
const DEFAULT_REISSUE_TIMEOUT_MS = 15_000;
const REISSUE_BEFORE_START = "codes can only be reissued for the whole session before it starts";
const START_FAILED = "the session could not be started";

/** What the BotHost is built with: the supervisor's own reissue and alert, handed over once through the `bots` factory. */
export type BotDeps = { reissue: (id: string, roleId: string) => Promise<string>; alert: (sessionId: string, roleId: string, message: string) => void };
const BOTS_CLOSE_TIMEOUT_MS = 3_000;

export class Supervisor {
  protected readonly live = new Map<string, Live>();
  private inflight = 0;
  /** Children that survived kill and forceKill: their slots stay reserved so MAX_SESSIONS stays honest until they exit. */
  private zombies = 0;
  private readonly setTimer: SetTimer;
  private readonly logFn: (m: string) => void;
  private readonly newSessionId: () => string;
  private readonly newToken: () => string;
  private readonly now: () => number;
  private readonly parentEnv: NodeJS.ProcessEnv;
  private readonly reissueTimeoutMs: number;
  /** The newest child process of each session until it exits (also children we gave up stopping): the next start waits for it. */
  private readonly procs = new Map<string, Proc>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly reissuing = new Set<string>();
  private readonly pendingReissues = new Map<string, PendingReissue>();
  private readonly pendingAiRoles = new Map<string, PendingAiRoles>();
  private readonly settingAiRoles = new Set<string>();
  /** The player roles in scenario order, from the create result's codes; orders the AI set setAiRoles returns. */
  private readonly roleOrder = new Map<string, string[]>();
  /** B14: roles a timed-out set_ai_roles may have switched; cleared by the next set or a launch that issues codes. */
  private readonly uncertain = new Map<string, string[]>();
  private closed = false;
  private readonly bots?: BotHost;

  constructor(private readonly o: {
    config: ControlConfig; list: SessionList; scenarios: () => Promise<{ id: string; title: string }[]>; spawn: SpawnFn;
    setTimer?: SetTimer; log?: (m: string) => void; newSessionId?: () => string; newToken?: () => string;
    reissueTimeoutMs?: number; now?: () => number;
    /** What the allowlist copies from (default: this process's environment; the entry point passes it with `.env` merged under). */
    parentEnv?: NodeJS.ProcessEnv;
    /** US-0060: the live AI players. Optional: without it no bot is ever started. */
    bots?: (deps: BotDeps) => BotHost;
  }) {
    this.parentEnv = o.parentEnv ?? process.env;
    this.now = o.now ?? Date.now;
    this.reissueTimeoutMs = o.reissueTimeoutMs ?? DEFAULT_REISSUE_TIMEOUT_MS;
    this.setTimer = o.setTimer ?? defaultSetTimer;
    this.logFn = o.log ?? (() => {});
    this.newSessionId = o.newSessionId ?? (() => randomBytes(16).toString("hex"));
    this.newToken = o.newToken ?? (() => randomBytes(32).toString("hex"));
    this.bots = o.bots?.({ reissue: (id, roleId) => this.reissueAiRole(id, roleId), alert: (id, roleId, message) => this.botAlert(id, roleId, message) });
  }

  /** Sessions that hold a slot: everything not ended, plus creates still starting. */
  private slotsUsed(): number {
    return this.o.list.read().filter((e) => e.status !== "ended").length + this.inflight + this.zombies;
  }

  async create(scenarioId: string): Promise<CreateResult> {
    const allowed = await this.o.scenarios();
    if (!isAllowedScenario(allowed, scenarioId)) throw new ControlError("unknown_scenario", "that scenario is not available");
    // No await between this check and the increment: concurrent creates cannot both take the last slot.
    if (this.slotsUsed() >= this.o.config.maxSessions) throw new ControlError("capacity", "the maximum number of sessions is reached");
    this.inflight++;
    const sessionId = this.newSessionId();
    let listed = false;
    let child: ChildHandle | undefined;
    let exit: ExitState = { done: false };
    const timer: { cancel?: () => void } = {};
    const logFile = path.join(this.o.config.logDir, `${sessionId}.log`);
    try {
      if (!isValidSessionId(sessionId)) throw new ControlError("start_failed", START_FAILED);
      const folder = scenarioDir(this.o.config.scenariosDir, scenarioId);
      const token = this.newToken();
      const env = buildChildEnv({ config: this.o.config, parentEnv: this.parentEnv, sessionId, scenarioDir: folder, token, start: "fresh" });
      mkdirSync(this.o.config.logDir, { recursive: true, mode: 0o700 });
      chmodSync(this.o.config.logDir, 0o700);
      const spawned = this.o.spawn({ env, logFile });
      child = spawned;
      exit = this.trackExit(sessionId, spawned);

      const endedSeen = { v: false };
      const ready = await this.awaitReady(spawned, true, timer, endedSeen);
      timer.cancel?.();
      this.o.list.upsert({ sessionId, scenarioId, status: "running" });
      listed = true;
      this.goLive(sessionId, scenarioId, spawned, exit, token, ready, endedSeen.v);
      this.logFn(`session ${sessionId} created`);
      return { sessionId, status: "running", port: ready.port, modelLabel: ready.modelLabel, codes: ready.codes!.filter((c) => !(ready.aiRoles ?? []).includes(c.roleId)) };
    } catch (err) {
      timer.cancel?.();
      const clean = await this.rollback(sessionId, listed, child, exit);
      this.logFn(`session ${sessionId} create failed`);
      if (!clean) throw new ControlError("start_failed", START_FAILED);
      throw err instanceof ControlError ? err : new ControlError("start_failed", START_FAILED);
    } finally {
      this.inflight--;
    }
  }

  /** Records the child's exit (and forgets it as the session's newest process once it has gone). */
  private trackExit(sessionId: string, child: ChildHandle): ExitState {
    const exit: ExitState = { done: false };
    exit.promise = new Promise<void>((resolve) => child.onExit(() => {
      exit.done = true;
      if (this.procs.get(sessionId)?.child === child) this.procs.delete(sessionId);
      resolve();
    }));
    this.procs.set(sessionId, { child, exit });
    return exit;
  }

  /**
   * Waits for `ready` (bounded by readyTimeoutMs on the injected timer, cancel handle left in `timer`). Codes seen before ready are
   * kept in this closure only: a child that dies, times out or never says ready discards them. With `requireCodes` (a brand-new
   * session, or a whole-session reissue) a ready without codes is a failed start; otherwise (restart/resume) it is normal.
   */
  private awaitReady(child: ChildHandle, requireCodes: boolean, timer: { cancel?: () => void }, endedSeen: { v: boolean }): Promise<ReadyInfo> {
    return new Promise((resolve, reject) => {
      let codes: Codes | undefined;
      let settled = false;
      const fail = (e: ControlError): void => { if (!settled) { settled = true; codes = undefined; reject(e); } };
      timer.cancel = this.setTimer(() => fail(new ControlError("timeout", "the session did not become ready in time")), this.o.config.readyTimeoutMs);
      child.onExit(() => fail(new ControlError("start_failed", START_FAILED)));
      child.onMessage((raw) => {
        // BUG-0016: a child may send `ended` right after `ready` (a resume repaired to ended); the live handler is installed only after
        // this promise's continuation runs, so the message is recorded here and applied by goLive. After ready nothing else matters
        // here, so every other message is dropped without being parsed.
        if (settled) {
          if (typeof raw !== "object" || raw === null || (raw as { type?: unknown }).type !== "ended") return;
          if (ChildMessageSchema.safeParse(raw).success) endedSeen.v = true;
          return;
        }
        const parsed = ChildMessageSchema.safeParse(raw);
        if (!parsed.success) return;
        const m = parsed.data;
        if (m.type === "codes") codes = m.codes;
        else if (m.type === "ready") {
          const got = codes !== undefined && codes.length > 0 ? codes : undefined;
          if (requireCodes && got === undefined) { fail(new ControlError("start_failed", START_FAILED)); return; }
          settled = true;
          codes = undefined;
          resolve({ port: m.port, modelLabel: m.modelLabel, ...(got ? { codes: got } : {}), ...(m.aiRoles ? { aiRoles: m.aiRoles } : {}), ...(m.aiCalls !== undefined ? { aiCalls: m.aiCalls } : {}) });
        }
      });
    });
  }

  /** Resolves true when the child exited within `ms`, false otherwise (the injected timer, cancelled on exit). */
  private waitExit(exit: ExitState, ms: number): Promise<boolean> {
    if (exit.done || !exit.promise) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const cancel = this.setTimer(() => resolve(false), ms);
      void exit.promise!.then(() => { cancel(); resolve(true); });
    });
  }

  /** The one way to stop a child: kill, wait up to graceMs, forceKill, wait up to graceMs. True when it is gone. */
  private async stopChild(child: ChildHandle, exit: ExitState): Promise<boolean> {
    if (exit.done) return true;
    try { child.kill(); } catch { /* already gone */ }
    let gone = await this.waitExit(exit, this.o.config.graceMs);
    if (!gone) {
      try { child.forceKill(); } catch { /* already gone */ }
      gone = await this.waitExit(exit, this.o.config.graceMs);
    }
    return gone;
  }

  /**
   * Undo a failed create. The child is stopped FIRST and its exit awaited (stopChild); only then are
   * the list entry and every `<id>.*` file removed, so a dying child cannot recreate them. The child's log is KEPT (0600 in the 0700 log
   * directory): it is the only record of why the child failed. The slot (held by the
   * caller's `inflight`) is released only after that. A child that survives forceKill is a bug we cannot resolve: its slot stays reserved
   * (`zombies`) until it does exit, and the cleanup then runs. Returns false in that case. Every step is guarded on its own.
   */
  private async rollback(sessionId: string, listed: boolean, child: ChildHandle | undefined, exit: ExitState): Promise<boolean> {
    this.live.delete(sessionId);
    if (child && !exit.done) {
      if (!(await this.stopChild(child, exit))) {
        this.logFn(`session ${sessionId} child did not exit`);
        this.zombies++;
        void exit.promise!.then(() => { this.cleanup(sessionId, listed); this.zombies--; });
        return false;
      }
    }
    this.cleanup(sessionId, listed);
    return true;
  }

  private cleanup(sessionId: string, listed: boolean): void {
    this.roleOrder.delete(sessionId);
    this.uncertain.delete(sessionId);
    this.botForget(sessionId);
    if (listed) { try { this.o.list.remove(sessionId); } catch { /* the entry was never written */ } }
    if (!isValidSessionId(sessionId)) return; // never build a path to delete from an id that is not one
    try {
      for (const name of readdirSync(this.o.config.sessionsDir)) {
        if (!name.startsWith(`${sessionId}.`)) continue;
        try { rmSync(path.join(this.o.config.sessionsDir, name), { force: true }); } catch { this.logFn(`session ${sessionId} cleanup step failed`); }
      }
    } catch { /* no sessions directory yet */ }
  }

  private info(id: string, scenarioId: string, status: SessionStatus): SessionInfo {
    const l = this.live.get(id);
    const out: SessionInfo = { sessionId: id, scenarioId, status: l?.status ?? status };
    if (l?.port !== undefined && out.status === "running") out.port = l.port;
    if (l?.modelLabel !== undefined && out.status === "running") out.modelLabel = l.modelLabel;
    return out;
  }

  get(id: string): SessionInfo | undefined {
    const e = this.o.list.read().find((x) => x.sessionId === id);
    return e ? this.info(e.sessionId, e.scenarioId, e.status) : undefined;
  }

  list(): SessionInfo[] {
    return this.o.list.read().map((e) => this.info(e.sessionId, e.scenarioId, e.status));
  }

  facilitator(id: string): { port: number; token: string } | undefined {
    const l = this.live.get(id);
    if (!l || l.status !== "running" || l.port === undefined || l.token === undefined) return undefined;
    return { port: l.port, token: l.token };
  }

  // ---- lifecycle (11b) ----

  private persist(id: string, scenarioId: string, status: SessionStatus): void {
    try { this.o.list.upsert({ sessionId: id, scenarioId, status }); }
    catch { this.logFn(`session ${id} could not be recorded as ${status}`); }
  }

  private entryOf(id: string): { scenarioId: string; status: SessionStatus } | undefined {
    if (typeof id !== "string" || !isValidSessionId(id)) return undefined;
    const e = this.o.list.read().find((x) => x.sessionId === id);
    if (!e) return undefined;
    return { scenarioId: e.scenarioId, status: this.live.get(id)?.status ?? e.status };
  }

  /** One restart, reissue or reissueAll at a time per session. */
  private withLock<R>(id: string, fn: () => Promise<R>): Promise<R> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(() => undefined, () => undefined);
    this.locks.set(id, tail);
    void tail.then(() => { if (this.locks.get(id) === tail) this.locks.delete(id); });
    return run;
  }

  /** Registers a started child as the session's live process and installs its handlers. */
  private goLive(id: string, scenarioId: string, child: ChildHandle, exit: ExitState, token: string, ready: ReadyInfo, endedEarly = false): void {
    this.live.get(id)?.graceCancel?.();
    if (ready.codes) this.roleOrder.set(id, ready.codes.map((c) => c.roleId));
    this.uncertain.delete(id); // a ready's aiRoles is the truth again
    this.live.set(id, { scenarioId, status: "running", port: ready.port, modelLabel: ready.modelLabel, child, token, aiRoles: ready.aiRoles ?? [] });
    child.onMessage((raw) => {
      const parsed = ChildMessageSchema.safeParse(raw);
      if (!parsed.success) return;
      const m = parsed.data;
      if (m.type === "ended") this.onEnded(id, child, exit);
      else if (m.type === "reissued" || m.type === "reissue_failed") this.onReissueReply(child, m);
      else if (m.type === "ai_roles_set" || m.type === "ai_roles_failed") this.onAiRolesReply(id, child, m);
    });
    child.onExit(() => this.onChildExit(id, child));
    // A child already gone or ended gets no attach (it would join a dead port or an ended runtime); the end/detach below stops any bots.
    if (!exit.done && !endedEarly) this.attachBots(id, ready);
    if (exit.done) this.onChildExit(id, child);
    else if (endedEarly) this.onEnded(id, child, exit);
  }

  /**
   * Hands the new child's port and AI roles to the BotHost (also with [], which stops stale bots). Never awaited: the host runs its
   * own per-session chain, and a lock is held here. A throw (or a rejection) is logged by name only and never reaches the caller.
   */
  private attachBots(id: string, ready: ReadyInfo): void {
    const bots = this.bots;
    if (!bots || this.closed) return;
    const failed = (err: unknown): void => this.logFn(`session ${id} bots attach failed (${err instanceof Error ? err.name : "error"})`);
    const aiRoles = ready.aiRoles ?? [];
    // A launch that issued fresh codes hands the AI roles' codes over now, so the host never asks to reissue them.
    const codes = (ready.codes ?? []).filter((c) => aiRoles.includes(c.roleId));
    try { bots.attach(id, { port: ready.port, aiRoles, aiCalls: ready.aiCalls, ...(codes.length > 0 ? { codes } : {}) }).catch(failed); }
    catch (err) { failed(err); }
  }

  /** Fire-and-forget calls into the BotHost for the session's end and the child's exit; never throws, never awaited. */
  private botsCall(id: string, what: "end" | "detach"): void {
    const bots = this.bots;
    if (!bots) return;
    const failed = (err: unknown): void => this.logFn(`session ${id} bots ${what} failed (${err instanceof Error ? err.name : "error"})`);
    try { bots[what](id).catch(failed); } catch (err) { failed(err); }
  }

  /** A live AI player's alert for the facilitator, sent to the running child. Dropped when it is not running; never throws. */
  botAlert(id: string, roleId: string, message: string): void {
    try {
      const l = this.live.get(id);
      if (!l || l.status !== "running" || !l.child) return;
      const msg = ParentMessageSchema.safeParse({ type: "bot_alert", roleId, message });
      if (!msg.success) return;
      l.child.send(msg.data);
    } catch { this.logFn(`session ${id} bot alert could not be sent`); }
  }

  private onEnded(id: string, child: ChildHandle, exit: ExitState): void {
    const l = this.live.get(id);
    if (!l || l.child !== child || l.status === "ended" || this.closed) return;
    l.status = "ended";
    this.roleOrder.delete(id);
    this.uncertain.delete(id);
    delete l.token; delete l.port; delete l.modelLabel;
    this.persist(id, l.scenarioId, "ended");
    this.logFn(`session ${id} ended`);
    this.botsCall(id, "end");
    l.graceCancel = this.setTimer(() => { l.graceCancel = undefined; void this.stopChild(child, exit); }, this.o.config.graceMs);
  }

  private onChildExit(id: string, child: ChildHandle): void {
    for (const [rid, p] of this.pendingReissues) {
      if (p.child !== child) continue;
      this.pendingReissues.delete(rid);
      p.cancel();
      p.reject(new ControlError("unavailable", "the session stopped; restart it and reissue again"));
    }
    for (const [rid, p] of this.pendingAiRoles) {
      if (p.child !== child) continue;
      this.pendingAiRoles.delete(rid);
      p.cancel();
      p.reject(new ControlError("unavailable", "the session stopped; restart it and set the AI roles again"));
    }
    const l = this.live.get(id);
    if (!l || l.child !== child) return;
    this.botsCall(id, "detach"); // not end: codes and budget stay, so a restart rejoins with the same codes on the new port
    l.graceCancel?.(); l.graceCancel = undefined;
    delete l.child; delete l.token; delete l.port; delete l.modelLabel;
    if (l.status !== "ended") {
      l.status = "stopped";
      // During shutdown() the exits are expected: the list keeps "running", so a service restart resumes the lobby either way.
      if (!this.closed) {
        this.persist(id, l.scenarioId, "stopped");
        this.logFn(`session ${id} stopped unexpectedly`);
      }
    }
  }

  private onReissueReply(child: ChildHandle, m: Extract<ChildMessage, { type: "reissued" | "reissue_failed" }>): void {
    const p = this.pendingReissues.get(m.requestId);
    if (!p || p.child !== child) return;
    this.pendingReissues.delete(m.requestId);
    p.cancel();
    if (m.type === "reissued") p.resolve(m.code);
    else p.reject(new ControlError("conflict", m.reason));
  }

  private onAiRolesReply(id: string, child: ChildHandle, m: Extract<ChildMessage, { type: "ai_roles_set" | "ai_roles_failed" }>): void {
    const p = this.pendingAiRoles.get(m.requestId);
    if (!p || p.child !== child) return;
    this.pendingAiRoles.delete(m.requestId);
    p.cancel();
    if (m.type === "ai_roles_failed") {
      const code = AI_REFUSALS.get(m.reason);
      p.reject(code ? new ControlError(code, m.reason) : new ControlError("conflict", AI_ROLES_FAILED)); // an unknown reason is never echoed
      return;
    }
    const l = this.live.get(id);
    if (l && l.child === child) l.aiRoles = p.roles;
    p.resolve(m.codes);
  }

  /** The AI roles of the session's latest ready or successful set; [] when unknown. */
  aiRolesOf(id: string): string[] {
    return [...(this.live.get(id)?.aiRoles ?? [])];
  }

  /**
   * Switches the session's AI roles over IPC (no HTTP route yet). Codes of roles now AI go only to the bots and are never returned;
   * codes of roles now human are returned. `roles` is the new AI set in scenario order.
   */
  setAiRoles(id: string, roles: string[]): Promise<AiRolesResult> {
    if (!this.entryOf(id)) return Promise.reject(new ControlError("not_found", "that session does not exist"));
    if (!Array.isArray(roles) || roles.length > 256 || !roles.every((r) => RoleIdSchema.safeParse(r).success)) return Promise.reject(new ControlError("bad_request", "that AI roles request is not valid"));
    if (this.settingAiRoles.has(id)) return Promise.reject(new ControlError("conflict", "the AI roles are already being changed"));
    this.settingAiRoles.add(id);
    return this.withLock(id, () => this.sendAiRolesLocked(id, roles, this.uncertain.get(id) ?? [])).finally(() => { this.settingAiRoles.delete(id); });
  }

  /**
   * The set_ai_roles exchange and the split of its reply. Runs INSIDE `withLock`; it never takes the lock and never awaits the bots.
   * `uncertain` (B14) are roles a timed-out earlier set may have switched: after this set, each one the reply did not cover gets its own
   * reissue (a retry of a set that applied returns no codes), BEFORE the bots are told, so a code is never issued twice.
   */
  private async sendAiRolesLocked(id: string, wanted: string[], uncertain: string[] = []): Promise<AiRolesResult> {
    const l = this.live.get(id);
    if (!l || l.status !== "running" || !l.child) throw new ControlError("conflict", "the session is not running");
    const child = l.child;
    const requestId = randomBytes(8).toString("hex");
    const parsed = ParentMessageSchema.safeParse({ type: "set_ai_roles", requestId, roles: wanted });
    if (!parsed.success) throw new ControlError("bad_request", "that AI roles request is not valid");
    const msg = parsed.data;
    const order = await this.playerOrder(id, l.scenarioId);
    const rank = (r: string): number => { const i = order.indexOf(r); return i < 0 ? order.length : i; };
    const aiNow = [...wanted].sort((a, b) => rank(a) - rank(b));
    const before = l.aiRoles ?? [];
    let reply: Codes;
    try {
      reply = await new Promise<Codes>((resolve, reject) => {
        const cancel = this.setTimer(() => {
          this.pendingAiRoles.delete(requestId);
          reject(new ControlError("timeout", "the AI roles may or may not have changed; reissue the changed roles"));
        }, this.reissueTimeoutMs);
        this.pendingAiRoles.set(requestId, { sessionId: id, child, resolve, reject, cancel, roles: aiNow });
        let sent = false;
        try { sent = child.send(msg); } catch { sent = false; }
        if (!sent) {
          this.pendingAiRoles.delete(requestId);
          cancel();
          reject(new ControlError("unavailable", "the session could not be reached"));
        }
      });
    } catch (err) {
      if (err instanceof ControlError && err.code === "timeout") {
        // B14: the roles this request would have switched may or may not have been; no code of them leaves until the next set.
        const changed = [...new Set([...before.filter((r) => !wanted.includes(r)), ...wanted.filter((r) => !before.includes(r)), ...uncertain])];
        this.uncertain.set(id, changed);
      }
      throw err;
    }
    const covered = new Set(reply.map((c) => c.roleId));
    const all: Codes = [...reply];
    try {
      for (const r of uncertain) {
        if (covered.has(r)) continue;
        const msg2 = this.reissueMessage(r);
        if (!msg2) continue;
        all.push({ roleId: r, code: await this.reissueLocked(id, msg2) });
      }
    } catch {
      // The set applied but a recovery reissue failed: the reply's codes are lost with this call. Every role the reply or the loop
      // touched stays uncertain (no code of it leaves), the next set reissues them all and routes them by its wanted set. The reissue's
      // own message is never passed on.
      this.uncertain.set(id, [...new Set([...uncertain, ...reply.map((c) => c.roleId), ...all.map((c) => c.roleId)])]);
      throw new ControlError("timeout", "the AI roles may or may not have changed; reissue the changed roles");
    }
    this.uncertain.delete(id);
    const aiSet = new Set(aiNow);
    const toBots = all.filter((c) => aiSet.has(c.roleId));
    const codes = all.filter((c) => !aiSet.has(c.roleId));
    const bots = this.bots;
    const now = this.live.get(id);
    // The bots are told only while the same child still runs on a known port (nothing is awaited here: the host has its own chain).
    if (bots && now && now.child === child && now.status === "running" && now.port !== undefined) {
      const failed = (what: string) => (err: unknown): void => this.logFn(`session ${id} bots ${what} failed (${err instanceof Error ? err.name : "error"})`);
      const left = before.filter((r) => !aiSet.has(r));
      // Order matters: removeRoles first, then ONE attach that takes the new AI roles in with their codes (setCodes would drop them).
      if (left.length > 0) { try { void bots.removeRoles(id, left).catch(failed("removeRoles")); } catch (err) { failed("removeRoles")(err); } }
      try { void bots.attach(id, { port: now.port, aiRoles: [...aiNow], codes: toBots }).catch(failed("attach")); } catch (err) { failed("attach")(err); }
    }
    return { roles: [...aiNow], codes };
  }

  /**
   * After a launch that issued codes (reissueAll, restart, resumeAll). The runtime drops the AI-role file when it issues fresh codes, so
   * with an empty log the captured set is sent again; with a started log it is not (the runtime would refuse `started`) and the roles the
   * child restored (`ready.aiRoles`) stand. Codes of AI roles go to the bots only; the result holds the human roles' codes.
   * Runs INSIDE `withLock` and calls only unlocked helpers.
   */
  // KNOWN GAP (M-1): after a control-service restart `captured` is empty (nothing is kept in memory), so if fresh codes dropped the
  // lobby's <id>.ai-roles.json its AI roles silently come back as human. Follow-up: persist the AI set beside the session list.
  private async afterCodedLaunch(id: string, ready: ReadyInfo, captured: string[]): Promise<Codes> {
    const issued = ready.codes ?? [];
    let ai = ready.aiRoles ?? [];
    let status: "empty" | "running" | "ended";
    try { status = readLogStatus(path.join(this.o.config.sessionsDir, `${id}.jsonl`)); } catch { status = "running"; }
    if (status === "empty" && captured.length > 0 && !(captured.length === ai.length && captured.every((r) => ai.includes(r)))) {
      try {
        const sent = await this.sendAiRolesLocked(id, captured);
        ai = sent.roles;
        // The re-send's human codes are newer than the launch's: they win (a role that flipped to human gets its NEW code).
        const newer = new Map(sent.codes.map((c) => [c.roleId, c.code]));
        const merged = issued.map((c) => ({ roleId: c.roleId, code: newer.get(c.roleId) ?? c.code }));
        for (const [roleId, code] of newer) if (!merged.some((c) => c.roleId === roleId)) merged.push({ roleId, code });
        return merged.filter((c) => !ai.includes(c.roleId));
      } catch { throw new ControlError("conflict", "the codes were reissued but the AI roles could not be set again; set them again"); }
    }
    return issued.filter((c) => !ai.includes(c.roleId));
  }

  /** Stops the session's bots and deletes its intent files; never awaited. */
  private botForget(id: string): void {
    const bots = this.bots;
    if (!bots) return;
    const failed = (err: unknown): void => this.logFn(`session ${id} bots forget failed (${err instanceof Error ? err.name : "error"})`);
    try { bots.forget(id).catch(failed); } catch (err) { failed(err); }
  }

  /** The session's player roles in scenario order: the create codes if known, else the scenario file; [] if neither is readable. */
  private async playerOrder(id: string, scenarioId: string): Promise<string[]> {
    const known = this.roleOrder.get(id);
    if (known) return known;
    try {
      const sc = await loadScenario(scenarioDir(this.o.config.scenariosDir, scenarioId));
      const order = Object.values(sc.roles).filter((r) => r.type === "player").map((r) => r.id);
      this.roleOrder.set(id, order);
      return order;
    } catch { return []; }
  }

  private markStopped(id: string, scenarioId: string): void {
    const l = this.live.get(id);
    if (l) {
      l.graceCancel?.(); l.graceCancel = undefined;
      delete l.child; delete l.token; delete l.port; delete l.modelLabel;
      l.status = "stopped";
    }
    this.persist(id, scenarioId, "stopped");
  }

  /** An old child still draining holds the session lock: wait for it (bounded) before a new one is spawned. */
  private async waitPrevious(id: string): Promise<void> {
    const p = this.procs.get(id);
    if (!p || p.exit.done) return;
    if (!(await this.waitExit(p.exit, this.o.config.graceMs))) throw new ControlError("conflict", "the previous process is still shutting down");
  }

  /**
   * Spawns a resumed child for an EXISTING session and waits for ready. On any failure the new child is stopped, its files are left
   * alone, the session is marked stopped and a plain ControlError is thrown. Codes are returned only if the child issued some.
   */
  private async launch(id: string, scenarioId: string, requireCodes: boolean): Promise<ReadyInfo> {
    const timer: { cancel?: () => void } = {};
    let child: ChildHandle | undefined;
    let exit: ExitState | undefined;
    try {
      const folder = scenarioDir(this.o.config.scenariosDir, scenarioId);
      const token = this.newToken();
      const env = buildChildEnv({ config: this.o.config, parentEnv: this.parentEnv, sessionId: id, scenarioDir: folder, token, start: "resume" });
      mkdirSync(this.o.config.logDir, { recursive: true, mode: 0o700 });
      chmodSync(this.o.config.logDir, 0o700);
      const spawned = this.o.spawn({ env, logFile: path.join(this.o.config.logDir, `${id}.log`) });
      child = spawned;
      exit = this.trackExit(id, spawned);
      const endedSeen = { v: false };
      const ready = await this.awaitReady(spawned, requireCodes, timer, endedSeen);
      timer.cancel?.();
      this.persist(id, scenarioId, "running");
      this.goLive(id, scenarioId, spawned, exit, token, ready, endedSeen.v);
      this.logFn(`session ${id} started`);
      return ready;
    } catch (err) {
      timer.cancel?.();
      if (child && exit && !(await this.stopChild(child, exit))) this.logFn(`session ${id} child did not exit`);
      this.markStopped(id, scenarioId);
      this.logFn(`session ${id} start failed`);
      throw err instanceof ControlError ? err : new ControlError("start_failed", START_FAILED);
    }
  }

  restart(id: string): Promise<SessionInfo & { codes?: Codes }> {
    const known = this.entryOf(id);
    if (!known) return Promise.reject(new ControlError("not_found", "that session does not exist"));
    return this.withLock(id, async () => {
      const e = this.entryOf(id);
      if (!e) throw new ControlError("not_found", "that session does not exist");
      if (e.status === "ended") throw new ControlError("conflict", "the session has ended");
      if (e.status === "running") throw new ControlError("conflict", "already running");
      await this.waitPrevious(id);
      const captured = this.aiRolesOf(id);
      const ready = await this.launch(id, e.scenarioId, false);
      const codes = ready.codes ? await this.afterCodedLaunch(id, ready, captured) : undefined;
      const info = this.get(id)!;
      return codes ? { ...info, codes } : info;
    });
  }

  reissue(id: string, roleId: string, by?: string, reason?: "removed"): Promise<string> {
    const e = this.entryOf(id);
    if (!e) return Promise.reject(new ControlError("not_found", "that session does not exist"));
    const msg = this.reissueMessage(roleId, by, reason);
    if (!msg) return Promise.reject(new ControlError("bad_request", "that reissue request is not valid"));
    const key = `${id}:${roleId}`;
    if (this.reissuing.has(key)) return Promise.reject(new ControlError("conflict", "a reissue for that role is already in progress"));
    this.reissuing.add(key);
    return this.withLock(id, () => {
      // Inside the lock: a set_ai_roles queued ahead may just have made the role AI. Nothing is sent for an AI role.
      if (this.aiRolesOf(id).includes(roleId) || this.uncertain.get(id)?.includes(roleId)) return Promise.reject(new ControlError("ai_role", AI_ROLE_REFUSED));
      return this.reissueLocked(id, msg);
    }).finally(() => { this.reissuing.delete(key); });
  }

  /**
   * The BotHost's `reissue` dep: takes the session lock itself (it is called, not awaited, from the host's chain, so it queues behind
   * whatever holds the lock). It must never be awaited while a lock is held. The code it resolves with belongs to the host and is never logged.
   */
  private reissueAiRole(id: string, roleId: string): Promise<string> {
    if (!this.entryOf(id)) return Promise.reject(new ControlError("not_found", "that session does not exist"));
    const msg = this.reissueMessage(roleId);
    if (!msg) return Promise.reject(new ControlError("bad_request", "that reissue request is not valid"));
    return this.withLock(id, () => this.reissueLocked(id, msg));
  }

  private reissueMessage(roleId: string, by?: string, reason?: "removed"): Extract<ParentMessage, { type: "reissue" }> | undefined {
    const requestId = randomBytes(8).toString("hex");
    const msg = ParentMessageSchema.safeParse({ type: "reissue", requestId, roleId, ...(by !== undefined ? { by } : {}), ...(reason !== undefined ? { reason } : {}) });
    return msg.success && msg.data.type === "reissue" ? msg.data : undefined;
  }

  /** The reissue exchange with the live child. Runs INSIDE `withLock`; it never takes the lock. */
  private reissueLocked(id: string, msg: Extract<ParentMessage, { type: "reissue" }>): Promise<string> {
    const l = this.live.get(id);
    if (!l || l.status !== "running" || !l.child) return Promise.reject(new ControlError("conflict", "the session is not running"));
    const child = l.child;
    const requestId = msg.requestId;
    return new Promise<string>((resolve, reject) => {
      const cancel = this.setTimer(() => {
        this.pendingReissues.delete(requestId);
        reject(new ControlError("timeout", "the reissue may or may not have happened; reissue again"));
      }, this.reissueTimeoutMs);
      this.pendingReissues.set(requestId, { sessionId: id, child, resolve, reject, cancel });
      let sent = false;
      try { sent = child.send(msg); } catch { sent = false; }
      if (!sent) {
        this.pendingReissues.delete(requestId);
        cancel();
        reject(new ControlError("unavailable", "the session could not be reached"));
      }
    });
  }

  reissueAll(id: string, _by?: string): Promise<Codes> {
    if (!this.entryOf(id)) return Promise.reject(new ControlError("not_found", "that session does not exist"));
    return this.withLock(id, async () => {
      const e = this.entryOf(id);
      if (!e) throw new ControlError("not_found", "that session does not exist");
      if (e.status === "ended") throw new ControlError("conflict", "the session has ended");
      let status: "empty" | "running" | "ended";
      try { status = readLogStatus(path.join(this.o.config.sessionsDir, `${id}.jsonl`)); }
      catch { throw new ControlError("unavailable", "the session log cannot be read"); }
      if (status !== "empty") throw new ControlError("conflict", REISSUE_BEFORE_START);

      const p = this.procs.get(id);
      if (p && !p.exit.done && !(await this.stopChild(p.child, p.exit))) {
        this.markStopped(id, e.scenarioId);
        this.logFn(`session ${id} child did not exit`);
        throw new ControlError("unavailable", "the session could not be stopped");
      }
      // The early check above only fails fast: the child was live and accepting players until now. With it gone the log is stable, so
      // check AGAIN. If the session started meanwhile, the codes file is NOT touched (reissue is "before the start only", a guarantee):
      // the session is relaunched unchanged (resume, new token, as restart does) so it is not left down, or left stopped if that
      // fails, and the call is refused. The per-session lock is held throughout.
      let after: "empty" | "running" | "ended" | "unreadable";
      try { after = readLogStatus(path.join(this.o.config.sessionsDir, `${id}.jsonl`)); } catch { after = "unreadable"; }
      if (after !== "empty") {
        try { await this.launch(id, e.scenarioId, false); } catch { /* launch() marked it stopped and logged */ }
        throw new ControlError("conflict", REISSUE_BEFORE_START);
      }
      const codesFile = path.join(this.o.config.sessionsDir, `${id}.codes.json`);
      try { renameSync(codesFile, `${codesFile}.reissued-${this.now()}`); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          this.markStopped(id, e.scenarioId);
          throw new ControlError("start_failed", START_FAILED);
        }
      }
      const captured = this.aiRolesOf(id);
      this.botForget(id); // the old bots and their intent files go with the old codes (B12)
      const ready = await this.launch(id, e.scenarioId, true);
      this.logFn(`session ${id} codes reissued`);
      return await this.afterCodedLaunch(id, ready, captured);
    });
  }

  async resumeAll(): Promise<void> {
    const entries = this.o.list.read().filter((e) => e.status !== "ended");
    await Promise.allSettled(entries.map((e) => this.withLock(e.sessionId, async () => {
      if (this.live.get(e.sessionId)?.status === "running" || this.live.get(e.sessionId)?.status === "ended") return;
      let tail: "empty" | "running" | "ended";
      try { tail = readLogStatus(path.join(this.o.config.sessionsDir, `${e.sessionId}.jsonl`)); }
      catch {
        this.markStopped(e.sessionId, e.scenarioId);
        this.logFn(`session ${e.sessionId} log could not be checked`);
        return;
      }
      if (tail === "ended") {
        const l = this.live.get(e.sessionId);
        if (l) l.status = "ended";
        this.persist(e.sessionId, e.scenarioId, "ended");
        this.logFn(`session ${e.sessionId} had already ended`);
        return;
      }
      try {
        await this.waitPrevious(e.sessionId);
        const captured = this.aiRolesOf(e.sessionId);
        const ready = await this.launch(e.sessionId, e.scenarioId, false);
        // Codes issued here are not returned (nobody asked); the AI roles' codes still reach the bots, the human ones are discarded: the facilitator reissues.
        if (ready.codes) await this.afterCodedLaunch(e.sessionId, ready, captured).catch(() => this.logFn(`session ${e.sessionId} AI roles could not be set again`));
      } catch {
        this.markStopped(e.sessionId, e.scenarioId); // launch() already logged the reason
      }
    })));
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.bots) {
      // Bounded: a slow close must not eat the shutdown budget before the children are disconnected.
      let cancel = (): void => {};
      const timedOut = new Promise<"timeout">((resolve) => { cancel = this.setTimer(() => resolve("timeout"), BOTS_CLOSE_TIMEOUT_MS); });
      try {
        const r = await Promise.race([this.bots.close().then(() => "closed" as const), timedOut]);
        if (r === "timeout") this.logFn("bots did not close in time");
      } catch (err) { this.logFn(`bots close failed (${err instanceof Error ? err.name : "error"})`); }
      cancel();
    }
    for (const l of this.live.values()) { l.graceCancel?.(); l.graceCancel = undefined; }
    for (const [rid, p] of this.pendingReissues) {
      this.pendingReissues.delete(rid);
      p.cancel();
      p.reject(new ControlError("unavailable", "the service is shutting down"));
    }
    for (const [rid, p] of this.pendingAiRoles) {
      this.pendingAiRoles.delete(rid);
      p.cancel();
      p.reject(new ControlError("unavailable", "the service is shutting down"));
    }
    const procs = [...this.procs.values()].filter((p) => !p.exit.done);
    for (const p of procs) { try { p.child.disconnect(); } catch { /* already gone */ } }
    const allGone = (): Promise<boolean> => this.waitAll(procs, this.o.config.graceMs);
    if (await allGone()) return;
    for (const p of procs) if (!p.exit.done) { try { p.child.forceKill(); } catch { /* already gone */ } }
    if (!(await allGone())) this.logFn("some sessions did not exit at shutdown");
  }

  /** True when every process has exited within `ms` (one shared deadline). */
  private waitAll(procs: Proc[], ms: number): Promise<boolean> {
    const open = procs.filter((p) => !p.exit.done);
    if (open.length === 0) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const cancel = this.setTimer(() => resolve(false), ms);
      void Promise.all(open.map((p) => p.exit.promise)).then(() => { cancel(); resolve(true); });
    });
  }
}
