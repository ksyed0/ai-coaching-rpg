import { activeElapsedMs, initialState, reduce, type Channel, type EventBody, type FacilitatorCommand, type GmNoVerdictReason, type GmVia, type SessionEvent, type SessionState } from "@acr/events";
import { dueInjects, evaluateExit, nextSceneId, type Inject, type Scenario, type Scene } from "@acr/script";
import type { Clock } from "./clock.js";
import type { EventLog } from "./event-log.js";
import { Mutex } from "./mutex.js";

/** Own-property lookup: a client-supplied role id such as `__proto__` or `constructor` must never resolve to an inherited member. */
const own = <T>(map: Record<string, T>, key: string): T | undefined => (Object.hasOwn(map, key) ? map[key] : undefined);

export type EngineErrorCode = "paused" | "not_in_scene" | "stale_scene" | "ended" | "unknown_role" | "unknown_inject" | "log_not_empty" | "npc_role" | "unknown_fact" | "already_released";
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

  private async emit(body: EventBody): Promise<SessionEvent> {
    const e = await this.log.append(body, this.clock.now());
    this.state = reduce(this.state, e);
    for (const l of this.listeners) l(e);
    return e;
  }

  start(assignments: Record<string, string>): Promise<void> { return this.mutex.run(() => this.doStart(assignments)); }
  private async doStart(assignments: Record<string, string>): Promise<void> {
    // Sessions are not resumed from a log: starting on a non-empty log would corrupt the seq order.
    if ((await this.log.all()).length > 0) throw new EngineError("log_not_empty", "the session log already has events; sessions are not resumed, use a fresh session id");
    const roles: Record<string, { kind: "player" | "npc"; participantId?: string }> = {};
    for (const [id, role] of Object.entries(this.scenario.roles)) {
      roles[id] = role.type === "npc" ? { kind: "npc" } : { kind: "player", participantId: assignments[id] };
    }
    await this.emit({ type: "session.started", scenarioId: this.scenario.meta.id, version: this.scenario.meta.version, roles });
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
    if (release) await this.emit({ type: "npc.updated", roleId: release.roleId, goals: release.npc.goals, knowledge: release.npc.knowledge, released: [...release.npc.released, release.text] });
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

  tick(): Promise<void> { return this.mutex.run(() => this.doTick()); }
  private async doTick(): Promise<void> {
    const scene = this.currentScene();
    if (!scene || this.state.paused || this.state.status !== "running") return;
    // Pause freezes the scene clock (BUG-0005): elapsed time is active time, excluding paused intervals.
    const elapsedMs = activeElapsedMs(this.state, this.clock.now());
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
