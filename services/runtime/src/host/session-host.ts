import { visibleTranscript, type SessionEvent, type SessionState } from "@acr/events";
import type { NpcRole, Scenario } from "@acr/script";
import type { ModelProvider } from "@acr/adapters";
import type { Clock } from "../engine/clock.js";
import { type ResumeInfo, type SessionEngine } from "../engine/session-engine.js";
import { NpcAgent, type SilentTurn } from "../agents/npc-agent.js";
import { GameMaster, type GmTraceRecord } from "../agents/game-master.js";
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
  /** US-0018: the scene whose last player line went unanswered when the server stopped; answered once, on the facilitator's /resume. */
  private pendingAnswer: string | null = null;
  private readonly silences: SilentTurn[] = [];
  private readonly maxSilencesKept: number;
  private readonly silentListeners = new Set<(t: SilentTurn) => void>();
  private readonly fatalListeners = new Set<(reason: string) => void>();
  private fatal: string | null = null;

  constructor(opts: { scenario: Scenario; engine: SessionEngine; npcProvider: ModelProvider; gmProvider: ModelProvider; clock: Clock; log?: (msg: string) => void; firstTokenTimeoutMs?: number; replyTimeoutMs?: number; npcMaxTokens?: number; gmMaxTokens?: number; npcTemperature?: number; gmTemperature?: number; /** Game Master call deadline (GM_TIMEOUT_MS; default max(reply timeout, 60 s)), one re-ask after an unusable reply (GM_REASK, default true), how often it judges (GM_EVERY_N_UTTERANCES, default 3) and an optional raw-reply trace. */ gmTimeoutMs?: number; gmReask?: boolean; gmEveryN?: number; gmTrace?: (rec: GmTraceRecord) => void; /** US-0034, GM_AUTO_RELEASE (default off): the Game Master releases a hidden fact itself instead of only suggesting it. */ gmAutoRelease?: boolean; /** How many silent turns to remember for the demo's report (default 1000; the oldest are dropped). */ maxSilencesKept?: number }) {
    this.maxSilencesKept = Math.max(1, opts.maxSilencesKept ?? 1000);
    this.scenario = opts.scenario; this.engine = opts.engine;
    this.log = opts.log ?? (() => {});
    // What each AI character may know about the others: name, title and seniority (what every participant sees), never goals or secrets.
    const peers = Object.values(opts.scenario.roles).filter((r): r is NpcRole => r.type === "npc").map((r) => ({ id: r.id, name: r.name, title: r.title, seniority: r.seniority }));
    for (const role of Object.values(opts.scenario.roles)) {
      if (role.type === "npc") this.npcs.set(role.id, new NpcAgent({ role: role as NpcRole, engine: opts.engine, provider: opts.npcProvider, firstTokenTimeoutMs: opts.firstTokenTimeoutMs, replyTimeoutMs: opts.replyTimeoutMs, maxTokens: opts.npcMaxTokens, temperature: opts.npcTemperature, peers, onSilent: (t) => this.noteSilence(t) }));
    }
    // Fail-stop (US-0018): when the log fails or the lock is lost the engine refuses everything; stop the clock and tell the server.
    opts.engine.onFailure((reason) => this.onEngineFailure(reason));
    this.gm = new GameMaster({ engine: opts.engine, provider: opts.gmProvider, onError: (err) => this.report("GM", err), maxTokens: opts.gmMaxTokens, temperature: opts.gmTemperature, evaluationTimeoutMs: opts.gmTimeoutMs ?? gmDeadlineMs(opts.replyTimeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS), reask: opts.gmReask, everyNUtterances: opts.gmEveryN, trace: opts.gmTrace, autoRelease: opts.gmAutoRelease });
  }

  private noteSilence(t: SilentTurn): void {
    this.silences.push(t);
    if (this.silences.length > this.maxSilencesKept) this.silences.splice(0, this.silences.length - this.maxSilencesKept);
    for (const fn of this.silentListeners) { try { fn(t); } catch (err) { this.report("silence listener", err); } }
  }

  /** The turns an AI character chose to stay silent (no utterance and no event: kept in memory for the demo's report). */
  silentTurns(): readonly SilentTurn[] { return this.silences; }

  /** Calls `fn` for each silent turn from now on; returns the unsubscribe function. */
  onSilentTurn(fn: (t: SilentTurn) => void): () => void { this.silentListeners.add(fn); return () => { this.silentListeners.delete(fn); }; }

  /** US-0034: whether the Game Master releases a hidden fact itself when it judges it earned (GM_AUTO_RELEASE), instead of only suggesting it. */
  get gmAutoRelease(): boolean { return this.gm.autoRelease; }

  /** Why the session stopped for good (the log failed or the lock was lost), or null. */
  get fatalReason(): string | null { return this.fatal; }

  /** Calls `fn` once if the session stops for good (see fatalReason). */
  onFatal(fn: (reason: string) => void): () => void { this.fatalListeners.add(fn); return () => { this.fatalListeners.delete(fn); }; }

  private onEngineFailure(reason: string): void {
    if (this.fatal !== null) return;
    this.fatal = reason;
    this.stopTicker();
    for (const fn of this.fatalListeners) { try { fn(reason); } catch (err) { this.report("fatal listener", err); } }
  }

  private report(what: string, err: unknown): void {
    try { this.log(`${what}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`); } catch { /* logging must never throw */ }
  }

  join(roleId: string, participantId: string): { brief: string; privateFacts: string[] } {
    // Own properties only: `__proto__`, `constructor` or `toString` are not roles.
    const role = Object.hasOwn(this.scenario.roles, roleId) ? this.scenario.roles[roleId] : undefined;
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

  /**
   * US-0018: adopts a session the engine restored from its log (call before the server accepts connections). Role claims start empty,
   * as after any disconnect; the Game Master continues from the log; one unanswered player line is answered on the facilitator's /resume.
   */
  resumeFrom(info: ResumeInfo): void {
    this.started = true;
    const scene = info.sceneId;
    const evaluated = info.lastGmSeq === null ? 0 : this.engine.state.transcript.filter((u) => u.sceneId === scene && u.seq < info.lastGmSeq!).length;
    this.gm.restore(scene, evaluated);
    this.pendingAnswer = info.pendingLine ? scene : null;
  }

  /** The scene whose unanswered player line waits for /resume (null when none). */
  get pendingAnswerScene(): string | null { return this.pendingAnswer; }

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
    this.pendingAnswer = null; // a new line supersedes the one from before a restart: the round below answers the conversation as it now stands
    this.scheduleRound();
  }

  /** One NPC round (then a GM tick) in the background. R25: at most one round waits behind the running one; it reads the then-current transcript anyway. */
  private scheduleRound(): void {
    if (this.roundQueued) return;
    this.roundQueued = true;
    this.schedule("npc round", async () => {
      this.roundQueued = false;
      const scene = this.engine.currentScene();
      if (!scene) return;
      const order = this.replyOrder(scene.participants);
      const before = this.engine.state.transcript.length;
      let spoke = false;
      for (const [i, id] of order.entries()) {
        const agent = this.npcs.get(id)!;
        // Nobody has answered yet: the last character of the round must speak, so a player line is never left entirely unanswered.
        try { if (await agent.respond({ mustSpeak: i === order.length - 1 && !spoke })) spoke = true; } catch (err) { this.report(`NPC ${id}`, err); }
      }
      if (order.length > 0 && !spoke && this.engine.state.transcript.length === before && this.engine.currentScene()?.id === scene.id && !this.engine.state.paused && this.engine.state.status === "running") {
        try { await this.engine.alert("every AI character stayed silent for this line", "warning", { expectSceneId: scene.id }); } catch (err) { this.report("silence alert", err); }
      }
      await this.gm.tick();
    });
  }

  /**
   * The AI characters of a scene in reply order: by seniority ascending (junior first, so the senior one reads the junior's reply
   * and answers the players with the decision), ties by the scene's participant order (a stable sort). Deterministic. A scene with one AI character is unaffected.
   */
  private replyOrder(participants: string[]): string[] {
    const seniority = (id: string): number => this.npcs.get(id)?.seniority ?? 3;
    return participants.filter((id) => this.npcs.has(id)).sort((a, b) => seniority(a) - seniority(b));
  }

  async command(cmd: Parameters<SessionEngine["command"]>[0], opts: { expectSceneId?: string } = {}): Promise<void> {
    await this.engine.command(cmd, opts);
    if (cmd.command === "resume" && this.pendingAnswer !== null && !this.engine.state.paused) {
      const sceneId = this.pendingAnswer;
      this.pendingAnswer = null; // exactly once, whatever happens next
      // Not when the facilitator has already asked to leave this scene (the advance takes effect at the next tick).
      if (this.engine.currentScene()?.id === sceneId && this.engine.state.status === "running" && !this.engine.state.advanceRequested) {
        await this.engine.alert("answering the last player line from before the restart", "info", { expectSceneId: sceneId });
        this.scheduleRound();
        return; // the round ends with a Game Master tick
      }
    }
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
    if (this.fatal !== null) return;
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

  /** Every AI character's hidden facts, in the order `release_hidden` numbers them. For the facilitator's `joined` message ONLY: never put this in a player's message or log. */
  hiddenFacts(): Record<string, string[]> {
    return Object.fromEntries(Object.values(this.scenario.roles).filter((r): r is NpcRole => r.type === "npc" && r.hidden.length > 0).map((r) => [r.id, [...r.hidden]]));
  }

  /** State snapshot safe to send to `who`: players never get NPC internals, GM verdicts, participant ids or other scenes' lines. */
  snapshotFor(who: string | "facilitator"): SessionState {
    const s = this.engine.state;
    if (who === "facilitator") return s;
    // Same rule as viewFor: only scenes the player takes part in.
    const mine = s.sceneHistory.filter((sc) => sc.participants.includes(who));
    const currentScene = s.currentScene && s.currentScene.participants.includes(who) ? s.currentScene : null;
    return { ...s, roles: redactRoles(s.roles), currentScene, sceneHistory: mine, transcript: visibleTranscript(s, who), npcs: {}, gmVerdicts: {}, factsEarned: {}, injectsFired: [], advanceRequested: false };
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
      // Like a pause: every participant learns the session came back paused after a restart.
      case "session.resumed": return e;
      // Only for scenes the player takes part in.
      case "scene.entered": return e.participants.includes(who) ? e : null;
      case "scene.exited": return inScene(e.sceneId) ? e : null;
      case "utterance": return inScene(this.engine.state.transcript.find((x) => x.seq === e.seq)?.sceneId) ? e : null;
      // Only when addressed to this role.
      case "inject.fired": return e.to.includes(who) ? e : null;
      // Facilitator controls: players learn of pause/resume and of whispers addressed to them; everything else
      // (advance, fire_inject, set_npc_stance with NPC goals, release_hidden) stays private.
      case "facilitator.command":
        return e.command === "pause" || e.command === "resume" || (e.command === "whisper" && e.roleId === who) ? e : null;
      // Never for players: NPC goals/knowledge and released hidden facts, GM reasoning, facilitator alerts.
      // US-0034: a Game Master release suggestion (or auto-release) names a hidden fact by number and is the facilitator's decision alone.
      case "npc.updated": case "gm.decision": case "gm.no_verdict": case "gm.fact_earned": case "facilitator.alert": return null;
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
