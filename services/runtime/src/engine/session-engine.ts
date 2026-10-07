import { LOG_FORMAT, activeElapsedMs, initialState, reduce, reduceReplay, type Channel, type EventBody, type FacilitatorCommand, type GmNoVerdictReason, type GmVia, type SessionEvent, type SessionState } from "@acr/events";
import { dueInjects, evaluateExit, nextSceneId, type Inject, type Scenario, type Scene } from "@acr/script";
import type { Clock } from "./clock.js";
import { LogFailedError, type EventLog } from "./event-log.js";
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
  /**
   * Steps of a multi-event operation the crash cut short, completed by markResumed (each is deterministic from the scenario): the
   * initial AI character states of a start, the AI character updates of a fired inject, a scene's opening inject, and the next scene
   * (or the end) after a scene exit.
   */
  repairs: Repair[];
  /** seq of the last Game Master decision (or no-verdict) in the current scene; null when none. */
  lastGmSeq: number | null;
  /** The current scene's last line is a player's, with no AI character's line after it, and an AI character is in the scene. */
  pendingLine: boolean;
  /** The session was already paused when the server stopped. */
  wasPaused: boolean;
};
export type Repair =
  | { kind: "npc_init"; roleId: string }
  | { kind: "inject_effect"; sceneId: string; injectId: string; roleId: string }
  | { kind: "opening_inject"; sceneId: string }
  | { kind: "enter_scene"; sceneId: string }
  | { kind: "end_session" };
export const describeRepair = (r: Repair): string =>
  r.kind === "npc_init" ? `set up AI character ${r.roleId}` : r.kind === "inject_effect" ? `applied inject ${r.injectId} to ${r.roleId}`
    : r.kind === "opening_inject" ? `fired the opening inject of ${r.sceneId}` : r.kind === "enter_scene" ? `entered scene ${r.sceneId}` : "ended the session (the last scene had ended)";
/** What markResumed reports for the operator. */
export type ResumeNotes = { downSecs: number; clockBehindSecs: number; repairs: string[] };
export type RestoreOutcome = { kind: "empty" } | { kind: "ended"; events: number } | { kind: "running"; info: ResumeInfo };

/** Own-property lookup: a client-supplied role id such as `__proto__` or `constructor` must never resolve to an inherited member. */
const own = <T>(map: Record<string, T>, key: string): T | undefined => (Object.hasOwn(map, key) ? map[key] : undefined);

export type EngineErrorCode = "paused" | "not_in_scene" | "stale_scene" | "ended" | "unknown_role" | "unknown_inject" | "log_not_empty" | "npc_role" | "unknown_fact" | "already_released" | "log_failed";
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
  /** Set when the log failed or the engine diverged from it (fail-stop): every later operation that would append is refused. */
  private failure: string | null = null;
  private readonly failureListeners = new Set<(reason: string) => void>();

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

  /** Why the engine stopped (fail-stop), or null while healthy. */
  get failed(): string | null { return this.failure; }

  /** Called once when the engine fail-stops (the log failed, the lock was lost, or the state diverged from the log). */
  onFailure(fn: (reason: string) => void): () => void { this.failureListeners.add(fn); return () => this.failureListeners.delete(fn); }

  /** Fail-stop: from now on every operation that would append is refused with EngineError("log_failed"). Idempotent. */
  halt(reason: string): void {
    if (this.failure !== null) return;
    this.failure = reason;
    for (const fn of this.failureListeners) { try { fn(reason); } catch { /* a listener must not break the halt */ } }
  }

  private refused(): EngineError {
    return new EngineError("log_failed", `the session log failed (${this.failure}); this server accepts nothing more. Restart it: the session resumes from its log`);
  }

  private async emit(body: EventBody): Promise<SessionEvent> {
    if (this.failure !== null) throw this.refused();
    let e: SessionEvent;
    try { e = await this.log.append(body, this.now()); }
    catch (err) {
      if (err instanceof LogFailedError) { this.halt(err.reason); throw this.refused(); }
      throw err;
    }
    this.lastTs = Math.max(this.lastTs, e.ts);
    // The event is on disk. If the state cannot take it, the engine and the log disagree: never append anything after it.
    try { this.state = reduce(this.state, e); }
    catch (err) { this.halt(`the state rejected event ${e.seq}: ${err instanceof Error ? err.message : String(err)}`); throw this.refused(); }
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
    if (opts.expectSceneId !== undefined && own(this.state.roles, roleId)) {
      const cur = this.currentScene();
      if (!cur || !cur.participants.includes(roleId)) throw new EngineError("not_in_scene", `${roleId} is not in the current scene`);
    }
    if (opts.expectSceneId !== undefined && this.state.currentScene?.id !== opts.expectSceneId) throw new EngineError("stale_scene");
    if (!own(this.state.roles, roleId)) throw new EngineError("unknown_role", `unknown role ${roleId}`);
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
      const target = own(this.state.roles, cmd.roleId);
      if (!target) throw new EngineError("unknown_role", `unknown role ${cmd.roleId}`);
      if (target.kind !== "player") throw new EngineError("npc_role", `${cmd.roleId} is an NPC; whispers go to player roles only`);
    }
    if (cmd.command === "set_npc_stance" && !own(this.state.npcs, cmd.roleId)) throw new EngineError("unknown_role", `${cmd.roleId} is not an NPC`);
    let release: { roleId: string; npc: SessionState["npcs"][string]; text: string } | null = null;
    if (cmd.command === "release_hidden") {
      const role = own(this.scenario.roles, cmd.roleId);
      const npc = own(this.state.npcs, cmd.roleId);
      if (!role) throw new EngineError("unknown_role", `unknown role ${cmd.roleId}`);
      if (role.type !== "npc" || !npc) throw new EngineError("npc_role", `${cmd.roleId} is a player role; only an AI character has hidden facts`);
      const text = Number.isInteger(cmd.fact) && cmd.fact >= 1 ? role.hidden[cmd.fact - 1] : undefined;
      if (text === undefined) throw new EngineError("unknown_fact", `${cmd.roleId} has ${role.hidden.length} hidden fact(s); there is no fact ${cmd.fact}`);
      if (npc.released.includes(text)) throw new EngineError("already_released", `fact ${cmd.fact} of ${cmd.roleId} is already released`);
      release = { roleId: cmd.roleId, npc, text };
    }
    await this.emit({ type: "facilitator.command", ...cmd });
    // The command event above carries no fact text. The text goes only in this npc.updated, which players never receive.
    // Two appends: the npc.updated is the source of truth. If this second append fails the command is an orphan (it changed nothing, so a retry is accepted).
    if (release) await this.emit({ type: "npc.updated", roleId: release.roleId, goals: release.npc.goals, knowledge: release.npc.knowledge, released: [...release.npc.released, release.text] });
    if (injectToFire) await this.fireInject(injectToFire.scene, injectToFire.inject);
    if (cmd.command === "set_npc_stance") await this.doUpdateNpc(cmd.roleId, { goals: cmd.goals });
  }

  updateNpc(roleId: string, patch: { goals?: string[]; knowledge?: string[]; released?: string[] }): Promise<void> { return this.mutex.run(() => this.doUpdateNpc(roleId, patch)); }
  private async doUpdateNpc(roleId: string, patch: { goals?: string[]; knowledge?: string[]; released?: string[] }): Promise<void> {
    const npc = own(this.state.npcs, roleId);
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
    // An inject's AI character updates follow its inject.fired directly; this tracks the ones still due if the log ends here.
    let injectDue: { sceneId: string; injectId: string; roles: string[] } | null = null;
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
        if (logged.length !== known.length || logged.some(([id, r]) => { const k = own(sc.roles, id); return !k || (k.type === "npc" ? "npc" : "player") !== r?.kind; })) {
          throw new RestoreError("scenario_mismatch", "the log's roles do not match the scenario's roles");
        }
      } else if (e.type === "session.started") throw new RestoreError("invalid_log", `a second session.started at seq ${e.seq}`);
      if (e.type === "scene.entered" && !sceneIds.has(e.sceneId)) throw new RestoreError("scenario_mismatch", "the log enters a scene the scenario does not have");
      const npcsBefore = s.npcs;
      try { s = reduceReplay(s, e); } // linear: appends in place to the arrays this fold owns
      catch (err) { throw new RestoreError("invalid_log", `event ${e.seq} cannot be applied: ${err instanceof Error ? err.message : String(err)}`); }
      if (e.type === "inject.fired") injectDue = { sceneId: e.sceneId, injectId: e.injectId, roles: e.to.filter((r) => own(npcsBefore, r) !== undefined) };
      else if (e.type === "npc.updated" && injectDue && injectDue.roles[0] === e.roleId) injectDue.roles.shift();
      else injectDue = null;
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
    const pendingLine = !!cur && !!last && last.sceneId === cur.id && own(s.roles, last.roleId)?.kind === "player" && npcsHere.length > 0;
    const repairs: Repair[] = [];
    for (const [id, role] of Object.entries(sc.roles)) if (role.type === "npc" && !own(s.npcs, id)) repairs.push({ kind: "npc_init", roleId: id });
    const due = injectDue as { sceneId: string; injectId: string; roles: string[] } | null; // assigned inside the fold
    for (const roleId of due?.roles ?? []) repairs.push({ kind: "inject_effect", sceneId: due!.sceneId, injectId: due!.injectId, roleId });
    if (!cur) {
      const lastScene = s.sceneHistory.at(-1)?.id;
      const next = lastScene === undefined ? sc.script.scenes[0]?.id : nextSceneId(sc.script, lastScene);
      repairs.push(next ? { kind: "enter_scene", sceneId: next } : { kind: "end_session" });
    } else {
      const opening = sc.script.scenes.find((x) => x.id === cur.id)?.opening_inject;
      if (opening && !s.injectsFired.includes(opening)) repairs.push({ kind: "opening_inject", sceneId: cur.id });
    }
    return { kind: "running", info: { events: count, lastTs: maxTs, format, partialTailBytes, sceneId: cur?.id ?? null, lastGmSeq, pendingLine, wasPaused: s.paused, repairs } };
  }

  /**
   * After restore() returned "running": appends session.resumed (the session comes back PAUSED, the downtime counted as paused time
   * from the last recorded event) and a facilitator-only warning that says so. The facilitator's /resume continues the session.
   */
  markResumed(info: ResumeInfo): Promise<ResumeNotes> {
    return this.mutex.run(async () => {
      const notes: ResumeNotes = { downSecs: 0, clockBehindSecs: 0, repairs: info.repairs.map(describeRepair) };
      if (this.state.status !== "running") return notes;
      const raw = this.clock.now();
      notes.clockBehindSecs = Math.max(0, Math.round((info.lastTs - raw) / 1000));
      notes.downSecs = Math.max(0, Math.round((this.now() - info.lastTs) / 1000));
      await this.emit({ type: "session.resumed", downFromTs: info.lastTs });
      const down = notes.clockBehindSecs > 0
        ? `the server clock is ${notes.clockBehindSecs} s BEHIND the last recorded event (it moved backwards), so the downtime is unknown and counted as 0 s`
        : `${notes.downSecs} s after the last recorded event`;
      const cut = info.partialTailBytes > 0 ? `; a cut-off last line (${info.partialTailBytes} bytes, an event that was never confirmed) was dropped` : "";
      const v0 = info.format === 0 ? "; this log predates log format 1, so it was matched on scenario id and version only" : "";
      const fixed = notes.repairs.length > 0 ? `; the restart completed what the crash cut short: ${notes.repairs.join(", ")}` : "";
      await this.emit({ type: "facilitator.alert", level: "warning", message: `session resumed after a server restart, ${down}${cut}${v0}${fixed}. It is paused: /resume to continue${info.pendingLine ? " (the last player line is then answered)" : ""}` });
      for (const r of info.repairs) await this.applyRepair(r);
      return notes;
    });
  }

  /** Completes one step a crash cut short (see ResumeInfo.repairs), exactly as the live operation would have. */
  private async applyRepair(r: Repair): Promise<void> {
    const sc = this.scenario;
    if (r.kind === "npc_init") {
      const role = own(sc.roles, r.roleId);
      if (role?.type === "npc") await this.emit({ type: "npc.updated", roleId: r.roleId, goals: role.goals, knowledge: role.knowledge, released: [] });
    } else if (r.kind === "inject_effect") {
      const inject = sc.script.scenes.find((x) => x.id === r.sceneId)?.injects?.find((i) => i.id === r.injectId);
      const npc = own(this.state.npcs, r.roleId);
      if (inject && npc) await this.emit({ type: "npc.updated", roleId: r.roleId, goals: [...npc.goals, ...(inject.effect?.goals_add ?? [])], knowledge: [...npc.knowledge, ...(inject.effect?.knowledge_add ?? [])] });
    } else if (r.kind === "opening_inject") {
      const scene = sc.script.scenes.find((x) => x.id === r.sceneId);
      const inject = scene?.injects?.find((i) => i.id === scene.opening_inject);
      if (scene && inject) await this.fireInject(scene, inject);
    } else if (r.kind === "enter_scene") {
      const scene = sc.script.scenes.find((x) => x.id === r.sceneId);
      if (scene) await this.enterScene(scene);
    } else await this.emit({ type: "session.ended", reason: "script_complete" });
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
