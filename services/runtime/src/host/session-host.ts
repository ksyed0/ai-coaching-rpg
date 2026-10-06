import { visibleTranscript, type SessionEvent, type SessionState } from "@acr/events";
import type { NpcRole, Scenario } from "@acr/script";
import type { ModelProvider } from "@acr/adapters";
import type { Clock } from "../engine/clock.js";
import { type SessionEngine } from "../engine/session-engine.js";
import { NpcAgent } from "../agents/npc-agent.js";
import { GameMaster } from "../agents/game-master.js";
import { DEFAULT_REPLY_TIMEOUT_MS, gmDeadlineMs } from "../agents/timeouts.js";

export class HostError extends Error {
  constructor(readonly code: "role_taken" | "unknown_role" | "npc_role" | "not_started") { super(code); this.name = "HostError"; }
}

export class SessionHost {
  readonly assignments: Record<string, string> = {};
  readonly engine: SessionEngine;
  private readonly scenario: Scenario;
  private readonly npcs = new Map<string, NpcAgent>();
  private readonly gm: GameMaster;
  private readonly log: (msg: string) => void;
  private started = false;
  private starting: Promise<void> | null = null;
  private queue: Promise<void> = Promise.resolve();
  private ticker: NodeJS.Timeout | null = null;
  private tickPending = false;
  private roundQueued = false;

  constructor(opts: { scenario: Scenario; engine: SessionEngine; npcProvider: ModelProvider; gmProvider: ModelProvider; clock: Clock; log?: (msg: string) => void; firstTokenTimeoutMs?: number; replyTimeoutMs?: number; npcMaxTokens?: number; gmMaxTokens?: number; npcTemperature?: number; gmTemperature?: number }) {
    this.scenario = opts.scenario; this.engine = opts.engine;
    this.log = opts.log ?? (() => {});
    for (const role of Object.values(opts.scenario.roles)) {
      if (role.type === "npc") this.npcs.set(role.id, new NpcAgent({ role: role as NpcRole, engine: opts.engine, provider: opts.npcProvider, firstTokenTimeoutMs: opts.firstTokenTimeoutMs, replyTimeoutMs: opts.replyTimeoutMs, maxTokens: opts.npcMaxTokens, temperature: opts.npcTemperature }));
    }
    this.gm = new GameMaster({ engine: opts.engine, provider: opts.gmProvider, onError: (err) => this.report("GM", err), maxTokens: opts.gmMaxTokens, temperature: opts.gmTemperature, evaluationTimeoutMs: gmDeadlineMs(opts.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS) });
  }

  private report(what: string, err: unknown): void {
    try { this.log(`${what}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`); } catch { /* logging must never throw */ }
  }

  join(roleId: string, participantId: string): { brief: string; privateFacts: string[] } {
    const role = this.scenario.roles[roleId];
    if (!role) throw new HostError("unknown_role");
    if (role.type !== "player") throw new HostError("npc_role");
    if (this.assignments[roleId] && this.assignments[roleId] !== participantId) throw new HostError("role_taken");
    this.assignments[roleId] = participantId;
    return { brief: role.brief, privateFacts: role.private_facts };
  }

  /** Frees a role, but only for the participant who holds it. */
  release(roleId: string, participantId: string): void {
    if (this.assignments[roleId] === participantId) delete this.assignments[roleId];
  }

  /** `started` is set only after engine.start succeeds, so a failed start can be retried (never wedged). */
  async start(): Promise<void> {
    if (this.started) return;
    this.starting ??= this.engine.start(this.assignments)
      .then(() => { this.started = true; })
      .finally(() => { this.starting = null; });
    await this.starting;
  }

  /** Serialises everything that mutates the session so NPC turns never interleave. */
  private enqueue(fn: () => Promise<void>): Promise<void> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Resolves once everything queued so far (NPC rounds, GM ticks) has finished. */
  idle(): Promise<void> { return this.queue; }

  /** Runs in the background: never awaited by callers, errors go to the log callback. */
  private schedule(what: string, fn: () => Promise<void>): void {
    this.enqueue(fn).catch((err) => this.report(what, err));
  }

  /**
   * Records the line and returns. The NPC round and GM tick are scheduled in the background (one NPC turn at
   * a time via the queue), so a caller, and its connection's next message, never waits behind a model call.
   */
  async onPlayerUtterance(roleId: string, text: string, opts: { expectSceneId?: string } = {}): Promise<void> {
    if (!this.started) throw new HostError("not_started");
    await this.engine.say(roleId, text, "text", opts); // throws EngineError (paused, ended, ...) before any NPC turn can start
    // R25: at most one round waits behind the running one; it reads the then-current transcript anyway.
    if (this.roundQueued) return;
    this.roundQueued = true;
    this.schedule("npc round", async () => {
      this.roundQueued = false;
      const scene = this.engine.currentScene();
      if (!scene) return;
      for (const id of scene.participants) {
        const agent = this.npcs.get(id);
        if (!agent) continue;
        try { await agent.respond(); } catch (err) { this.report(`NPC ${id}`, err); }
      }
      await this.gm.tick();
    });
  }

  async command(cmd: Parameters<SessionEngine["command"]>[0], opts: { expectSceneId?: string } = {}): Promise<void> {
    await this.engine.command(cmd, opts);
    this.schedule("gm tick", () => this.gm.tick());
  }

  /**
   * Waits for one final Game Master evaluation of the current scene (see GameMaster.finalEvaluation), serialised with the
   * NPC rounds. A live run's 1 s ticker can judge while a player's line is being recorded, before the characters' replies.
   */
  evaluateFinal(expectSceneId?: string): Promise<boolean> {
    let ran = false;
    return this.enqueue(async () => { ran = await this.gm.finalEvaluation(expectSceneId); }).then(() => ran);
  }

  startTicker(ms: number): void {
    this.stopTicker();
    this.ticker = setInterval(() => {
      if (this.tickPending) return; // a slow tick must not pile up behind itself
      this.tickPending = true;
      this.enqueue(() => this.gm.tick())
        .catch((err) => this.report("ticker", err))
        .finally(() => { this.tickPending = false; });
    }, ms);
  }
  stopTicker(): void { if (this.ticker) clearInterval(this.ticker); this.ticker = null; }

  /** Subscribers are synchronous inside the engine's emit: a throw would abort the operation, so each is isolated. */
  subscribe(fn: (e: SessionEvent) => void): () => void {
    return this.engine.subscribe((e) => {
      try { fn(e); } catch (err) { this.report("subscriber", err); }
    });
  }

  /** State snapshot safe to send to `who`: players never get NPC internals, GM verdicts, participant ids or other scenes' lines. */
  snapshotFor(who: string | "facilitator"): SessionState {
    const s = this.engine.state;
    if (who === "facilitator") return s;
    // Same rule as viewFor: only scenes the player takes part in.
    const mine = s.sceneHistory.filter((sc) => sc.participants.includes(who));
    const currentScene = s.currentScene && s.currentScene.participants.includes(who) ? s.currentScene : null;
    return { ...s, roles: redactRoles(s.roles), currentScene, sceneHistory: mine, transcript: visibleTranscript(s, who), npcs: {}, gmVerdicts: {}, injectsFired: [], advanceRequested: false };
  }

  filterFor(who: string | "facilitator"): (e: SessionEvent) => boolean {
    return (e) => this.viewFor(who, e) !== null;
  }

  /**
   * What `who` may see of `e`, or null. Default-DENY for players: an explicit decision per event type, and the
   * `never` check below makes a new EventBody member a compile error until it is decided here.
   */
  viewFor(who: string | "facilitator", e: SessionEvent): SessionEvent | null {
    if (who === "facilitator") return e;
    const inScene = (sceneId: string | null | undefined) =>
      this.engine.state.sceneHistory.find((s) => s.id === sceneId)?.participants.includes(who) ?? false;
    switch (e.type) {
      // Redacted copy: roles -> kinds only (participant ids/names are other people's display names).
      case "session.started": return { ...e, roles: redactRoles(e.roles) };
      case "session.ended": return e;
      // Only for scenes the player takes part in.
      case "scene.entered": return e.participants.includes(who) ? e : null;
      case "scene.exited": return inScene(e.sceneId) ? e : null;
      case "utterance": return inScene(this.engine.state.transcript.find((x) => x.seq === e.seq)?.sceneId) ? e : null;
      // Only when addressed to this role.
      case "inject.fired": return e.to.includes(who) ? e : null;
      // Facilitator controls: players learn of pause/resume and of whispers addressed to them; everything else
      // (advance, fire_inject, set_npc_stance with NPC goals) stays private.
      case "facilitator.command":
        return e.command === "pause" || e.command === "resume" || (e.command === "whisper" && e.roleId === who) ? e : null;
      // Never for players: NPC goals/knowledge, GM reasoning, facilitator alerts.
      case "npc.updated": case "gm.decision": case "facilitator.alert": return null;
      default: {
        const _exhaustive: never = e; // compile time: a new EventBody member must be decided above
        void _exhaustive;
        return null; // runtime: fail closed on an event type this version does not know
      }
    }
  }
}

function redactRoles(roles: SessionState["roles"]): SessionState["roles"] {
  return Object.fromEntries(Object.entries(roles).map(([id, r]) => [id, { kind: r.kind }]));
}
