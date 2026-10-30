import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { isValidSessionId } from "@acr/events";
import { buildChildEnv } from "./child-env.js";
import type { ControlConfig } from "./config.js";
import { ChildMessageSchema, type ChildMessage, type ParentMessage } from "./protocol.js";
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

type Live = { scenarioId: string; status: SessionStatus; port?: number; modelLabel?: string; child?: ChildHandle; token?: string };

const defaultSetTimer: SetTimer = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref();
  return () => clearTimeout(t);
};
const NOT_IMPLEMENTED = "not implemented";

export class Supervisor {
  protected readonly live = new Map<string, Live>();
  private inflight = 0;
  /** Children that survived kill and forceKill: their slots stay reserved so MAX_SESSIONS stays honest until they exit. */
  private zombies = 0;
  private readonly setTimer: SetTimer;
  private readonly logFn: (m: string) => void;
  private readonly newSessionId: () => string;
  private readonly newToken: () => string;

  constructor(private readonly o: {
    config: ControlConfig; list: SessionList; scenarios: () => Promise<{ id: string; title: string }[]>; spawn: SpawnFn;
    setTimer?: SetTimer; log?: (m: string) => void; newSessionId?: () => string; newToken?: () => string;
  }) {
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
    const exit: { done: boolean; promise?: Promise<void> } = { done: false };
    const timer: { cancel?: () => void } = {};
    const logFile = path.join(this.o.config.logDir, `${sessionId}.log`);
    try {
      if (!isValidSessionId(sessionId)) throw new ControlError("start_failed", "the session could not be started");
      const folder = scenarioDir(this.o.config.scenariosDir, scenarioId);
      const token = this.newToken();
      const env = buildChildEnv({ config: this.o.config, parentEnv: process.env, sessionId, scenarioDir: folder, token, start: "fresh" });
      mkdirSync(this.o.config.logDir, { recursive: true, mode: 0o700 });
      chmodSync(this.o.config.logDir, 0o700);
      const spawned = this.o.spawn({ env, logFile });
      child = spawned;
      exit.promise = new Promise<void>((resolve) => spawned.onExit(() => { exit.done = true; resolve(); }));

      const ready = await new Promise<{ port: number; modelLabel: string; codes: { roleId: string; code: string }[] }>((resolve, reject) => {
        let codes: { roleId: string; code: string }[] | undefined;
        let settled = false;
        const fail = (e: ControlError): void => { if (!settled) { settled = true; codes = undefined; reject(e); } };
        timer.cancel = this.setTimer(() => fail(new ControlError("timeout", "the session did not become ready in time")), this.o.config.readyTimeoutMs);
        spawned.onExit(() => fail(new ControlError("start_failed", "the session could not be started")));
        spawned.onMessage((raw) => {
          if (settled) return;
          const parsed = ChildMessageSchema.safeParse(raw);
          if (!parsed.success) return;
          const m = parsed.data;
          if (m.type === "codes") codes = m.codes;
          else if (m.type === "ready") {
            if (codes === undefined || codes.length === 0) { fail(new ControlError("start_failed", "the session could not be started")); return; }
            settled = true;
            resolve({ port: m.port, modelLabel: m.modelLabel, codes });
            codes = undefined;
          }
        });
      });
      timer.cancel?.();
      this.o.list.upsert({ sessionId, scenarioId, status: "running" });
      listed = true;
      this.live.set(sessionId, { scenarioId, status: "running", port: ready.port, modelLabel: ready.modelLabel, child: spawned, token });
      this.logFn(`session ${sessionId} created`);
      return { sessionId, status: "running", port: ready.port, modelLabel: ready.modelLabel, codes: ready.codes };
    } catch (err) {
      timer.cancel?.();
      const clean = await this.rollback(sessionId, listed, child, exit, logFile);
      this.logFn(`session ${sessionId} create failed`);
      if (!clean) throw new ControlError("start_failed", "the session could not be started");
      throw err instanceof ControlError ? err : new ControlError("start_failed", "the session could not be started");
    } finally {
      this.inflight--;
    }
  }

  /** Resolves true when the child exited within `ms`, false otherwise (the injected timer, cancelled on exit). */
  private waitExit(exit: { done: boolean; promise?: Promise<void> }, ms: number): Promise<boolean> {
    if (exit.done || !exit.promise) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const cancel = this.setTimer(() => resolve(false), ms);
      void exit.promise!.then(() => { cancel(); resolve(true); });
    });
  }

  /**
   * Undo a failed create. The child is stopped FIRST and its exit awaited (kill, then forceKill, each bounded by graceMs); only then are
   * the list entry, every `<id>.*` file and the child log removed, so a dying child cannot recreate them. The slot (held by the
   * caller's `inflight`) is released only after that. A child that survives forceKill is a bug we cannot resolve: its slot stays reserved
   * (`zombies`) until it does exit, and the cleanup then runs. Returns false in that case. Every step is guarded on its own.
   */
  private async rollback(sessionId: string, listed: boolean, child: ChildHandle | undefined, exit: { done: boolean; promise?: Promise<void> }, logFile: string): Promise<boolean> {
    this.live.delete(sessionId);
    if (child && !exit.done) {
      try { child.kill(); } catch { /* already gone */ }
      let gone = await this.waitExit(exit, this.o.config.graceMs);
      if (!gone) {
        try { child.forceKill(); } catch { /* already gone */ }
        gone = await this.waitExit(exit, this.o.config.graceMs);
      }
      if (!gone) {
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

  // 11b
  reissue(_id: string, _roleId: string, _by?: string): Promise<string> { return Promise.reject(new Error(NOT_IMPLEMENTED)); }
  reissueAll(_id: string, _by?: string): Promise<{ roleId: string; code: string }[]> { return Promise.reject(new Error(NOT_IMPLEMENTED)); }
  restart(_id: string): Promise<SessionInfo> { return Promise.reject(new Error(NOT_IMPLEMENTED)); }
  resumeAll(): Promise<void> { return Promise.reject(new Error(NOT_IMPLEMENTED)); }
  shutdown(): Promise<void> { return Promise.reject(new Error(NOT_IMPLEMENTED)); }
}
