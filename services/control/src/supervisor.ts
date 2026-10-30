import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { isValidSessionId } from "@acr/events";
import { buildChildEnv } from "./child-env.js";
import type { ControlConfig } from "./config.js";
import { readLogStatus } from "./log-tail.js";
import { ChildMessageSchema, ParentMessageSchema, type ChildMessage, type ParentMessage } from "./protocol.js";
import { isAllowedScenario, scenarioDir } from "./scenarios.js";
import type { SessionList } from "./session-list.js";

export type ControlErrorCode = "capacity" | "unknown_scenario" | "start_failed" | "timeout" | "bad_request" | "not_found" | "conflict" | "unavailable";

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
type ExitState = { done: boolean; promise?: Promise<void> };
type Proc = { child: ChildHandle; exit: ExitState };
type Live = {
  scenarioId: string; status: SessionStatus; port?: number; modelLabel?: string; child?: ChildHandle; token?: string; graceCancel?: () => void;
};
type PendingReissue = { sessionId: string; child: ChildHandle; resolve: (code: string) => void; reject: (e: ControlError) => void; cancel: () => void };

const defaultSetTimer: SetTimer = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref();
  return () => clearTimeout(t);
};
const DEFAULT_REISSUE_TIMEOUT_MS = 15_000;
const REISSUE_BEFORE_START = "codes can only be reissued for the whole session before it starts";
const START_FAILED = "the session could not be started";

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
  private closed = false;

  constructor(private readonly o: {
    config: ControlConfig; list: SessionList; scenarios: () => Promise<{ id: string; title: string }[]>; spawn: SpawnFn;
    setTimer?: SetTimer; log?: (m: string) => void; newSessionId?: () => string; newToken?: () => string;
    reissueTimeoutMs?: number; now?: () => number;
    /** What the allowlist copies from (default: this process's environment; the entry point passes it with `.env` merged under). */
    parentEnv?: NodeJS.ProcessEnv;
  }) {
    this.parentEnv = o.parentEnv ?? process.env;
    this.now = o.now ?? Date.now;
    this.reissueTimeoutMs = o.reissueTimeoutMs ?? DEFAULT_REISSUE_TIMEOUT_MS;
    this.setTimer = o.setTimer ?? defaultSetTimer;
    this.logFn = o.log ?? (() => {});
    this.newSessionId = o.newSessionId ?? (() => randomBytes(16).toString("hex"));
    this.newToken = o.newToken ?? (() => randomBytes(32).toString("hex"));
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

      const ready = await this.awaitReady(spawned, true, timer);
      timer.cancel?.();
      this.o.list.upsert({ sessionId, scenarioId, status: "running" });
      listed = true;
      this.goLive(sessionId, scenarioId, spawned, exit, token, ready);
      this.logFn(`session ${sessionId} created`);
      return { sessionId, status: "running", port: ready.port, modelLabel: ready.modelLabel, codes: ready.codes! };
    } catch (err) {
      timer.cancel?.();
      const clean = await this.rollback(sessionId, listed, child, exit, logFile);
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
  private awaitReady(child: ChildHandle, requireCodes: boolean, timer: { cancel?: () => void }): Promise<{ port: number; modelLabel: string; codes?: Codes }> {
    return new Promise((resolve, reject) => {
      let codes: Codes | undefined;
      let settled = false;
      const fail = (e: ControlError): void => { if (!settled) { settled = true; codes = undefined; reject(e); } };
      timer.cancel = this.setTimer(() => fail(new ControlError("timeout", "the session did not become ready in time")), this.o.config.readyTimeoutMs);
      child.onExit(() => fail(new ControlError("start_failed", START_FAILED)));
      child.onMessage((raw) => {
        if (settled) return;
        const parsed = ChildMessageSchema.safeParse(raw);
        if (!parsed.success) return;
        const m = parsed.data;
        if (m.type === "codes") codes = m.codes;
        else if (m.type === "ready") {
          const got = codes !== undefined && codes.length > 0 ? codes : undefined;
          if (requireCodes && got === undefined) { fail(new ControlError("start_failed", START_FAILED)); return; }
          settled = true;
          codes = undefined;
          resolve(got ? { port: m.port, modelLabel: m.modelLabel, codes: got } : { port: m.port, modelLabel: m.modelLabel });
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
   * the list entry, every `<id>.*` file and the child log removed, so a dying child cannot recreate them. The slot (held by the
   * caller's `inflight`) is released only after that. A child that survives forceKill is a bug we cannot resolve: its slot stays reserved
   * (`zombies`) until it does exit, and the cleanup then runs. Returns false in that case. Every step is guarded on its own.
   */
  private async rollback(sessionId: string, listed: boolean, child: ChildHandle | undefined, exit: ExitState, logFile: string): Promise<boolean> {
    this.live.delete(sessionId);
    if (child && !exit.done) {
      if (!(await this.stopChild(child, exit))) {
        this.logFn(`session ${sessionId} child did not exit`);
        this.zombies++;
        void exit.promise!.then(() => { this.cleanup(sessionId, listed, logFile); this.zombies--; });
        return false;
      }
    }
    this.cleanup(sessionId, listed, logFile);
    return true;
  }

  private cleanup(sessionId: string, listed: boolean, logFile: string): void {
    if (listed) { try { this.o.list.remove(sessionId); } catch { /* the entry was never written */ } }
    if (!isValidSessionId(sessionId)) return; // never build a path to delete from an id that is not one
    try {
      for (const name of readdirSync(this.o.config.sessionsDir)) {
        if (!name.startsWith(`${sessionId}.`)) continue;
        try { rmSync(path.join(this.o.config.sessionsDir, name), { force: true }); } catch { this.logFn(`session ${sessionId} cleanup step failed`); }
      }
    } catch { /* no sessions directory yet */ }
    try { rmSync(logFile, { force: true }); } catch { this.logFn(`session ${sessionId} cleanup step failed`); }
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
  private goLive(id: string, scenarioId: string, child: ChildHandle, exit: ExitState, token: string, ready: { port: number; modelLabel: string }): void {
    this.live.get(id)?.graceCancel?.();
    this.live.set(id, { scenarioId, status: "running", port: ready.port, modelLabel: ready.modelLabel, child, token });
    child.onMessage((raw) => {
      const parsed = ChildMessageSchema.safeParse(raw);
      if (!parsed.success) return;
      const m = parsed.data;
      if (m.type === "ended") this.onEnded(id, child, exit);
      else if (m.type === "reissued" || m.type === "reissue_failed") this.onReissueReply(child, m);
    });
    child.onExit(() => this.onChildExit(id, child));
    if (exit.done) this.onChildExit(id, child);
  }

  private onEnded(id: string, child: ChildHandle, exit: ExitState): void {
    const l = this.live.get(id);
    if (!l || l.child !== child || l.status === "ended" || this.closed) return;
    l.status = "ended";
    delete l.token; delete l.port; delete l.modelLabel;
    this.persist(id, l.scenarioId, "ended");
    this.logFn(`session ${id} ended`);
    l.graceCancel = this.setTimer(() => { l.graceCancel = undefined; void this.stopChild(child, exit); }, this.o.config.graceMs);
  }

  private onChildExit(id: string, child: ChildHandle): void {
    for (const [rid, p] of this.pendingReissues) {
      if (p.child !== child) continue;
      this.pendingReissues.delete(rid);
      p.cancel();
      p.reject(new ControlError("unavailable", "the session stopped; restart it and reissue again"));
    }
    const l = this.live.get(id);
    if (!l || l.child !== child) return;
    l.graceCancel?.(); l.graceCancel = undefined;
    delete l.child; delete l.token; delete l.port; delete l.modelLabel;
    if (l.status !== "ended") {
      l.status = "stopped";
      this.persist(id, l.scenarioId, "stopped");
      this.logFn(`session ${id} stopped unexpectedly`);
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
  private async launch(id: string, scenarioId: string, requireCodes: boolean): Promise<{ port: number; modelLabel: string; codes?: Codes }> {
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
      const ready = await this.awaitReady(spawned, requireCodes, timer);
      timer.cancel?.();
      this.persist(id, scenarioId, "running");
      this.goLive(id, scenarioId, spawned, exit, token, ready);
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
      const ready = await this.launch(id, e.scenarioId, false);
      const info = this.get(id)!;
      return ready.codes ? { ...info, codes: ready.codes } : info;
    });
  }

  reissue(id: string, roleId: string, by?: string): Promise<string> {
    const e = this.entryOf(id);
    if (!e) return Promise.reject(new ControlError("not_found", "that session does not exist"));
    const requestId = randomBytes(8).toString("hex");
    const msg = ParentMessageSchema.safeParse({ type: "reissue", requestId, roleId, ...(by !== undefined ? { by } : {}) });
    if (!msg.success) return Promise.reject(new ControlError("bad_request", "that reissue request is not valid"));
    const key = `${id}:${roleId}`;
    if (this.reissuing.has(key)) return Promise.reject(new ControlError("conflict", "a reissue for that role is already in progress"));
    this.reissuing.add(key);
    return this.withLock(id, async () => {
      const l = this.live.get(id);
      if (!l || l.status !== "running" || !l.child) throw new ControlError("conflict", "the session is not running");
      const child = l.child;
      return await new Promise<string>((resolve, reject) => {
        const cancel = this.setTimer(() => {
          this.pendingReissues.delete(requestId);
          reject(new ControlError("timeout", "the reissue may or may not have happened; reissue again"));
        }, this.reissueTimeoutMs);
        this.pendingReissues.set(requestId, { sessionId: id, child, resolve, reject, cancel });
        let sent = false;
        try { sent = child.send(msg.data); } catch { sent = false; }
        if (!sent) {
          this.pendingReissues.delete(requestId);
          cancel();
          reject(new ControlError("unavailable", "the session could not be reached"));
        }
      });
    }).finally(() => { this.reissuing.delete(key); });
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
      const ready = await this.launch(id, e.scenarioId, true);
      this.logFn(`session ${id} codes reissued`);
      return ready.codes!;
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
        await this.launch(e.sessionId, e.scenarioId, false); // any codes are discarded: the facilitator reissues
      } catch {
        this.markStopped(e.sessionId, e.scenarioId); // launch() already logged the reason
      }
    })));
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    for (const l of this.live.values()) { l.graceCancel?.(); l.graceCancel = undefined; }
    for (const [rid, p] of this.pendingReissues) {
      this.pendingReissues.delete(rid);
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
