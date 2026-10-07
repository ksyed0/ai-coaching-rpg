import { LOG_FORMAT, activeElapsedMs, initialState, reduce, type Channel, type EventBody, type FacilitatorCommand, type GmNoVerdictReason, type GmVia, type SessionEvent, type SessionState } from "@acr/events";
import { dueInjects, evaluateExit, nextSceneId, type Inject, type Scenario, type Scene } from "@acr/script";
import type { Clock } from "./clock.js";
import type { EventLog } from "./event-log.js";
import { Mutex } from "./mutex.js";
import { scenarioHash } from "./scenario-hash.js";

/** Why a log cannot be resumed (US-0018). The message never contains event text. */
export type RestoreErrorCode = "not_a_session" | "scenario_mismatch" | "log_format" | "invalid_log";
export class RestoreError extends Error {
  constructor(readonly code: RestoreErrorCode, message: string) { super(message); this.name = "RestoreError"; }
}

/** What restore() found in a log that holds a running session. */
export type ResumeInfo = {
  /** Events replayed. */
  events: number;
  /** The latest ts in the log: the downtime is counted from here. */
  lastTs: number;
  /** The log's format (0: written before US-0018, resumed on scenario id and version only). */
  format: number;
  /** Bytes of a cut-off last line that the first append drops (0 when none). */
  partialTailBytes: number;
  /** The current scene when the server stopped. */
  sceneId: string | null;
  /** seq of the last Game Master decision (or no-verdict) in the current scene; null when none. */
  lastGmSeq: number | null;
  /** The current scene's last line is a player's, with no AI character's line after it, and an AI character is in the scene. */
  pendingLine: boolean;
  /** The session was already paused when the server stopped. */
  wasPaused: boolean;
};
export type RestoreOutcome = { kind: "empty" } | { kind: "ended"; events: number } | { kind: "running"; info: ResumeInfo };

export type EngineErrorCode = "paused" | "not_in_scene" | "stale_scene" | "ended" | "unknown_role" | "unknown_inject" | "log_not_empty" | "npc_role";
export class EngineError extends Error {
  constructor(readonly code: EngineErrorCode, message: string = code) { super(message); this.name = "EngineError"; }
}

export class SessionEngine {
  state: SessionState = initialState();
  private readonly scenario: Scenario;
  private readonly log: EventLog;
  private readonly clock: Clock;
  private readonly listeners = new Set<(e: SessionEvent) => void>();
  private readonly mutex = new Mutex();
  /** The latest ts appended (or replayed): every new ts is clamped to at least this, so a wall clock that moves backwards never reorders time. */
  private lastTs = Number.NEGATIVE_INFINITY;

  constructor(opts: { scenario: Scenario; log: EventLog; clock: Clock }) {
    this.scenario = opts.scenario; this.log = opts.log; this.clock = opts.clock;
  }

  subscribe(fn: (e: SessionEvent) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /** Every role's id and display name (an NPC's character name; a player role has only its id), for recognising speaker labels in model text. */
  speakerNames(): { id: string; name: string }[] {
    return Object.values(this.scenario.roles).map((r) => ({ id: r.id, name: r.type === "npc" ? r.name : r.id }));
  }

  currentScene(): Scene | null {
    const id = this.state.currentScene?.id;
    return id ? this.scenario.script.scenes.find((s) => s.id === id) ?? null : null;
  }

  /** The clock, never earlier than the last recorded event. */
  private now(): number { return Math.max(this.clock.now(), this.lastTs); }

  private async emit(body: EventBody): Promise<SessionEvent> {
    const e = await this.log.append(body, this.now());
    this.lastTs = Math.max(this.lastTs, e.ts);
    this.state = reduce(this.state, e);
    for (const l of this.listeners) l(e);
    return e;
  }

  start(assignments: Record<string, string>): Promise<void> { return this.mutex.run(() => this.doStart(assignments)); }
  private async doStart(assignments: Record<string, string>): Promise<void> {
    // Starting on a non-empty log would corrupt the seq order: a log with events is resumed (restore) or rotated aside, never started over.
    if (this.state.status !== "idle" || (await this.log.all()).length > 0) throw new EngineError("log_not_empty", "the session log already has events; resume it (SESSION_START=resume) or start fresh (SESSION_START=fresh)");
    const roles: Record<string, { kind: "player" | "npc"; participantId?: string }> = {};
    for (const [id, role] of Object.entries(this.scenario.roles)) {
      roles[id] = role.type === "npc" ? { kind: "npc" } : { kind: "player", participantId: assignments[id] };
    }
    await this.emit({ type: "session.started", scenarioId: this.scenario.meta.id, version: this.scenario.meta.version, roles, logFormat: LOG_FORMAT, scenarioHash: scenarioHash(this.scenario) });
    for (const [id, role] of Object.entries(this.scenario.roles)) {
      if (role.type === "npc") await this.emit({ type: "npc.updated", roleId: id, goals: role.goals, knowledge: role.knowledge, released: [] });
    }
    await this.enterScene(this.scenario.script.scenes[0]);
  }

  private async enterScene(scene: Scene): Promise<void> {
    await this.emit({ type: "scene.entered", sceneId: scene.id, participants: scene.participants });
    if (scene.opening_inject) await this.fireInject(scene, scene.injects!.find((i) => i.id === scene.opening_inject)!);
  }

  private async fireInject(scene: Scene, inject: Inject): Promise<void> {
    await this.emit({ type: "inject.fired", injectId: inject.id, sceneId: scene.id, to: inject.to, content: inject.content });
    for (const roleId of inject.to) {
      const npc = this.state.npcs[roleId];
      if (!npc) continue;
      await this.emit({ type: "npc.updated", roleId,
        goals: [...npc.goals, ...(inject.effect?.goals_add ?? [])],
        knowledge: [...npc.knowledge, ...(inject.effect?.knowledge_add ?? [])] });
    }
  }

  /**
   * Serialized facilitator.alert for agents. Returns null (appends nothing) when the session has ended
   * (nothing may follow session.ended) or when `expectSceneId` no longer matches the current scene
   * (the alert belonged to a dropped, stale reply). The check runs inside the mutex, so it is atomic.
   */
  alert(message: string, level: "info" | "warning" = "warning", opts: { expectSceneId?: string } = {}): Promise<SessionEvent | null> {
    return this.mutex.run(async () => {
      if (this.state.status === "ended") return null;
      if (opts.expectSceneId !== undefined && this.state.currentScene?.id !== opts.expectSceneId) return null;
      return this.emit({ type: "facilitator.alert", level, message });
    });
  }

  /** `opts.expectSceneId`: throws EngineError("stale_scene") (appending nothing) if the scene has changed. */
  say(roleId: string, text: string, channel: Channel = "text", opts: { expectSceneId?: string; fallback?: true } = {}): Promise<SessionEvent> { return this.mutex.run(() => this.doSay(roleId, text, channel, opts)); }
  private async doSay(roleId: string, text: string, channel: Channel, opts: { expectSceneId?: string; fallback?: true }): Promise<SessionEvent> {
    if (this.state.status === "ended") throw new EngineError("ended");
    // Participation first: a role outside the current scene must not be able to probe the scene id through the guard.
    if (opts.expectSceneId !== undefined && this.state.roles[roleId]) {
      const cur = this.currentScene();
      if (!cur || !cur.participants.includes(roleId)) throw new EngineError("not_in_scene", `${roleId} is not in the current scene`);
    }
    if (opts.expectSceneId !== undefined && this.state.currentScene?.id !== opts.expectSceneId) throw new EngineError("stale_scene");
    if (!this.state.roles[roleId]) throw new EngineError("unknown_role", `unknown role ${roleId}`);
    if (this.state.paused) throw new EngineError("paused");
    const scene = this.currentScene();
    if (!scene || !scene.participants.includes(roleId)) throw new EngineError("not_in_scene", `${roleId} is not in the current scene`);
    return this.emit({ type: "utterance", roleId, text, channel, ...(opts.fallback ? { fallback: true as const } : {}) });
  }

  /** `opts.expectSceneId`: throws EngineError("stale_scene") (appending nothing) if the scene has changed, so a late `advance` can never end the NEXT scene. */
  command(cmd: FacilitatorCommand, opts: { expectSceneId?: string } = {}): Promise<void> { return this.mutex.run(() => this.doCommand(cmd, opts)); }
  private async doCommand(cmd: FacilitatorCommand, opts: { expectSceneId?: string } = {}): Promise<void> {
    if (this.state.status === "ended") throw new EngineError("ended");
    if (opts.expectSceneId !== undefined && this.state.currentScene?.id !== opts.expectSceneId) throw new EngineError("stale_scene");
    // validate first: a rejected command appends nothing
    let injectToFire: { scene: Scene; inject: Inject } | null = null;
    if (cmd.command === "fire_inject") {
      const scene = this.currentScene();
      const inject = scene?.injects?.find((i) => i.id === cmd.injectId);
      if (!scene || !inject) throw new EngineError("unknown_inject", `no inject ${cmd.injectId} in the current scene`);
      injectToFire = { scene, inject };
    }
    if (cmd.command === "whisper") {
      const target = this.state.roles[cmd.roleId];
      if (!target) throw new EngineError("unknown_role", `unknown role ${cmd.roleId}`);
      if (target.kind !== "player") throw new EngineError("npc_role", `${cmd.roleId} is an NPC; whispers go to player roles only`);
    }
    if (cmd.command === "set_npc_stance" && !this.state.npcs[cmd.roleId]) throw new EngineError("unknown_role", `${cmd.roleId} is not an NPC`);
    await this.emit({ type: "facilitator.command", ...cmd });
    if (injectToFire) await this.fireInject(injectToFire.scene, injectToFire.inject);
    if (cmd.command === "set_npc_stance") await this.doUpdateNpc(cmd.roleId, { goals: cmd.goals });
  }

  updateNpc(roleId: string, patch: { goals?: string[]; knowledge?: string[]; released?: string[] }): Promise<void> { return this.mutex.run(() => this.doUpdateNpc(roleId, patch)); }
  private async doUpdateNpc(roleId: string, patch: { goals?: string[]; knowledge?: string[]; released?: string[] }): Promise<void> {
    const npc = this.state.npcs[roleId];
    if (!npc) throw new EngineError("unknown_role", `${roleId} is not an NPC`);
    await this.emit({ type: "npc.updated", roleId, goals: patch.goals ?? npc.goals, knowledge: patch.knowledge ?? npc.knowledge, released: patch.released ?? npc.released });
  }

  /**
   * Appends a gm.decision for the current scene. Returns true when recorded; false (appending nothing, never throwing)
   * when there is no current scene, the session has ended, or `expectSceneId` no longer matches the current scene
   * (the verdict was computed against an earlier scene). The check runs inside the mutex, so it is atomic with the append.
   */
  recordGmVerdict(condition: string, verdict: boolean, reasoning: string, opts: { expectSceneId?: string; via?: GmVia } = {}): Promise<boolean> {
    return this.mutex.run(() => this.doGmVerdict(condition, verdict, reasoning, opts));
  }
  private async doGmVerdict(condition: string, verdict: boolean, reasoning: string, opts: { expectSceneId?: string; via?: GmVia }): Promise<boolean> {
    const scene = this.currentScene();
    if (!scene || this.state.status !== "running") return false;
    if (opts.expectSceneId !== undefined && scene.id !== opts.expectSceneId) return false;
    await this.emit({ type: "gm.decision", sceneId: scene.id, condition, verdict, reasoning, ...(opts.via ? { via: opts.via } : {}) });
    return true;
  }

  /** Appends a facilitator-only gm.no_verdict for the current scene (same guards as recordGmVerdict). Returns true when recorded. */
  recordGmNoVerdict(condition: string, reason: GmNoVerdictReason, attempts: number, opts: { expectSceneId?: string } = {}): Promise<boolean> {
    return this.mutex.run(async () => {
      const scene = this.currentScene();
      if (!scene || this.state.status !== "running") return false;
      if (opts.expectSceneId !== undefined && scene.id !== opts.expectSceneId) return false;
      await this.emit({ type: "gm.no_verdict", sceneId: scene.id, condition, reason, attempts });
      return true;
    });
  }

  /**
   * US-0018: rebuilds the state from the log by folding every event through the pure reducer (nothing else is read). Only on a
   * fresh engine. "empty": no events. "ended": the session had ended (the caller rotates the log aside and starts fresh; the
   * engine state is left untouched). "running": the state is adopted; the caller then calls markResumed(). Refuses (RestoreError,
   * nothing appended) when the first event is not session.started, the log names another scenario (id, version, or for format 1
   * its sha256), its format is newer than LOG_FORMAT, it names a scene or role the scenario lacks, or the reducer rejects it. The
   * log layer itself refuses corruption beyond a cut-off last line (LogCorruptError).
   */
  restore(): Promise<RestoreOutcome> { return this.mutex.run(() => this.doRestore()); }
  private async doRestore(): Promise<RestoreOutcome> {
    if (this.state.status !== "idle" || this.state.lastSeq !== 0) throw new EngineError("log_not_empty", "restore needs a fresh engine");
    const sc = this.scenario;
    const sceneIds = new Set(sc.script.scenes.map((x) => x.id));
    let s = initialState();
    let count = 0; let maxTs = Number.NEGATIVE_INFINITY; let format = 0; let lastGmSeq: number | null = null;
    const fold = (e: SessionEvent) => {
      if (count === 0) {
        if (e.type !== "session.started") throw new RestoreError("not_a_session", `the log does not begin with session.started (seq 1 is ${e.type})`);
        if (e.scenarioId !== sc.meta.id || e.version !== sc.meta.version) throw new RestoreError("scenario_mismatch", "the log belongs to a different scenario or scenario version than the one loaded");
        const f = e.logFormat ?? 0;
        if (!Number.isSafeInteger(f) || f < 0) throw new RestoreError("log_format", "the log's format field is not a whole number");
        if (f > LOG_FORMAT) throw new RestoreError("log_format", `the log has format ${f}, newer than this version reads (${LOG_FORMAT}); upgrade, or start fresh`);
        if (f >= 1 && e.scenarioHash !== scenarioHash(sc)) throw new RestoreError("scenario_mismatch", "the scenario files changed since this session started (its sha256 differs)");
        format = f;
        const logged = Object.entries(e.roles ?? {});
        const known = Object.values(sc.roles);
        if (logged.length !== known.length || logged.some(([id, r]) => { const k = sc.roles[id]; return !k || (k.type === "npc" ? "npc" : "player") !== r?.kind; })) {
          throw new RestoreError("scenario_mismatch", "the log's roles do not match the scenario's roles");
        }
      } else if (e.type === "session.started") throw new RestoreError("invalid_log", `a second session.started at seq ${e.seq}`);
      if (e.type === "scene.entered" && !sceneIds.has(e.sceneId)) throw new RestoreError("scenario_mismatch", "the log enters a scene the scenario does not have");
      try { s = reduce(s, e); }
      catch (err) { throw new RestoreError("invalid_log", `event ${e.seq} cannot be applied: ${err instanceof Error ? err.message : String(err)}`); }
      if (e.type === "scene.entered") lastGmSeq = null;
      else if ((e.type === "gm.decision" || e.type === "gm.no_verdict") && e.sceneId === s.currentScene?.id) lastGmSeq = e.seq;
      maxTs = Math.max(maxTs, e.ts);
      count++;
    };
    let partialTailBytes = 0;
    if (this.log.replay) partialTailBytes = (await this.log.replay(fold)).partialTailBytes;
    else for (const e of await this.log.all()) fold(e);
    if (count === 0) return { kind: "empty" };
    if (s.status === "ended") return { kind: "ended", events: count };
    this.state = s;
    this.lastTs = maxTs;
    const cur = s.currentScene;
    const last = s.transcript.at(-1);
    const npcsHere = cur ? cur.participants.filter((p) => sc.roles[p]?.type === "npc") : [];
    const pendingLine = !!cur && !!last && last.sceneId === cur.id && s.roles[last.roleId]?.kind === "player" && npcsHere.length > 0;
    return { kind: "running", info: { events: count, lastTs: maxTs, format, partialTailBytes, sceneId: cur?.id ?? null, lastGmSeq, pendingLine, wasPaused: s.paused } };
  }

  /**
   * After restore() returned "running": appends session.resumed (the session comes back PAUSED, the downtime counted as paused time
   * from the last recorded event) and a facilitator-only warning that says so. The facilitator's /resume continues the session.
   */
  markResumed(info: ResumeInfo): Promise<void> {
    return this.mutex.run(async () => {
      if (this.state.status !== "running") return;
      const downSecs = Math.max(0, Math.round((this.now() - info.lastTs) / 1000));
      await this.emit({ type: "session.resumed", downFromTs: info.lastTs });
      const cut = info.partialTailBytes > 0 ? `; a cut-off last line (${info.partialTailBytes} bytes, an event that was never confirmed) was dropped` : "";
      const v0 = info.format === 0 ? "; this log predates log format 1, so it was matched on scenario id and version only" : "";
      await this.emit({ type: "facilitator.alert", level: "warning", message: `session resumed after a server restart, ${downSecs} s after the last recorded event${cut}${v0}. It is paused: /resume to continue${info.pendingLine ? " (the last player line is then answered)" : ""}` });
    });
  }

  tick(): Promise<void> { return this.mutex.run(() => this.doTick()); }
  private async doTick(): Promise<void> {
    const scene = this.currentScene();
    if (!scene || this.state.paused || this.state.status !== "running") return;
    // Pause freezes the scene clock (BUG-0005): elapsed time is active time, excluding paused intervals.
    const elapsedMs = activeElapsedMs(this.state, this.now());
    // R14: only the current scene's injects fire, and never one scheduled past the time box.
    // An inject at exactly the time-box minute still fires, before the exit below.
    const timeBoxMinutes = scene.time_box_minutes;
    for (const inject of dueInjects(scene, elapsedMs, this.state.injectsFired)) {
      if (inject.at_minute !== undefined && inject.at_minute > timeBoxMinutes) continue;
      await this.fireInject(scene, inject);
    }
    const reason = evaluateExit(scene, { elapsedMs, facilitatorAdvance: this.state.advanceRequested, gmVerdicts: this.state.gmVerdicts });
    if (!reason) return;
    await this.emit({ type: "scene.exited", sceneId: scene.id, reason });
    const nextId = nextSceneId(this.scenario.script, scene.id);
    if (nextId) await this.enterScene(this.scenario.script.scenes.find((s) => s.id === nextId)!);
    else await this.emit({ type: "session.ended", reason: "script_complete" });
  }
}
