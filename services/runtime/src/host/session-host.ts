import { visibleTranscript, type SessionEvent, type SessionState } from "@acr/events";
import type { NpcRole, Scenario } from "@acr/script";
import type { ModelProvider } from "@acr/adapters";
import type { Clock } from "../engine/clock.js";
import { type SessionEngine } from "../engine/session-engine.js";
import { NpcAgent } from "../agents/npc-agent.js";
import { GameMaster } from "../agents/game-master.js";

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
  private queue: Promise<void> = Promise.resolve();
  private ticker: NodeJS.Timeout | null = null;
  private tickPending = false;

  constructor(opts: { scenario: Scenario; engine: SessionEngine; npcProvider: ModelProvider; gmProvider: ModelProvider; clock: Clock; log?: (msg: string) => void; replyTimeoutMs?: number }) {
    this.scenario = opts.scenario; this.engine = opts.engine;
    this.log = opts.log ?? (() => {});
    for (const role of Object.values(opts.scenario.roles)) {
      if (role.type === "npc") this.npcs.set(role.id, new NpcAgent({ role: role as NpcRole, engine: opts.engine, provider: opts.npcProvider, replyTimeoutMs: opts.replyTimeoutMs }));
    }
    this.gm = new GameMaster({ engine: opts.engine, provider: opts.gmProvider, onError: (err) => this.report("GM", err) });
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

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.engine.start(this.assignments);
  }

  /** Serialises everything that mutates the session so NPC turns never interleave. */
  private enqueue(fn: () => Promise<void>): Promise<void> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async onPlayerUtterance(roleId: string, text: string): Promise<void> {
    if (!this.started) throw new HostError("not_started");
    await this.engine.say(roleId, text); // throws EngineError (paused, ended, ...) before any NPC turn can start
    return this.enqueue(async () => {
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

  async command(cmd: Parameters<SessionEngine["command"]>[0]): Promise<void> {
    await this.engine.command(cmd);
    return this.enqueue(() => this.gm.tick());
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

  /** State snapshot safe to send to `who`: players never get NPC internals, GM verdicts or other scenes' lines. */
  snapshotFor(who: string | "facilitator"): SessionState {
    const s = this.engine.state;
    if (who === "facilitator") return s;
    return { ...s, transcript: visibleTranscript(s, who), npcs: {}, gmVerdicts: {}, injectsFired: [], advanceRequested: false };
  }

  filterFor(who: string | "facilitator"): (e: SessionEvent) => boolean {
    if (who === "facilitator") return () => true;
    return (e) => {
      switch (e.type) {
        case "inject.fired": return e.to.includes(who);
        case "utterance": {
          const u = this.engine.state.transcript.find((x) => x.seq === e.seq);
          const scene = this.engine.state.sceneHistory.find((s) => s.id === u?.sceneId);
          return !!scene && scene.participants.includes(who);
        }
        case "npc.updated": case "gm.decision": case "facilitator.alert": return false;
        case "facilitator.command":
          return e.command === "pause" || e.command === "resume" || (e.command === "whisper" && e.roleId === who);
        default: return true;
      }
    };
  }
}
