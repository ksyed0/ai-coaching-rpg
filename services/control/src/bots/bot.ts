import { createHmac, randomBytes } from "node:crypto";
import type { ModelProvider } from "@acr/adapters";
import type { Scenario } from "@acr/script";
import { TurnPolicy, cleanHint, generateLiveLine, type AiPlayerSettings, type PlayerView, type PolicyEvent, type Trigger, type TurnTicket } from "@acr/runtime/players";
import type { SetTimer } from "../supervisor.js";
import { BOT_AUTH_BACKOFF_MS, BotSocket } from "./bot-socket.js";
import type { BotEvent, BotFrame } from "./bot-frames.js";
import { type BotAlert } from "./bot-alerts.js";
import type { SessionBudget } from "./budget.js";
import type { IntentLog } from "./intent-log.js";

/** B16: how long a `say` may wait for the bot's own `utterance` event (or an `error` frame) before it counts as dropped. */
export const BOT_SAY_CONFIRM_MS = 10_000;
/** The view keeps at most this many of the latest lines. */
export const BOT_MAX_VIEW_LINES = 200;
/**
 * Nudge failures are bounded only by the session budget, so after this many CONSECUTIVE failed or skipped nudges (model, timeout,
 * unusable, budget, or a say that was refused or never confirmed) the bot stops nudging until a HUMAN line arrives (a line from a player
 * role that is not an AI player; AI characters and other AI players do not count). A reply is never held back by this, and a spoken line
 * (of any kind) also clears the count.
 */
export const BOT_MAX_FAILED_NUDGES = 3;
/** A socket that opened but got no parseable `joined` within this long is given up on: `rejoinFailed` once, then `onDisconnected(BOT_NO_JOIN_CODE)`. */
export const BOT_JOIN_WAIT_MS = 15_000;
/** The synthetic close code passed to `onDisconnected` for that case (WebSocket 1011, "internal error"); not final, the host may re-attach. */
export const BOT_NO_JOIN_CODE = 1011;

export type BotDeps = {
  sessionId: string; roleId: string; scenario: Scenario; provider: ModelProvider; settings: AiPlayerSettings;
  budget: SessionBudget; intents: IntentLog; alert: (a: BotAlert) => void; needCode: () => void;
  now: () => number; setTimer: SetTimer; open?: typeof BotSocket.open;
  /**
   * Called when a socket of the current generation closes without us closing it (never after detach, stop or attach). The bot itself never
   * reconnects. Codes 4001 to 4004 are final: the host must NOT re-attach on them; any other code (1006 ...) the host may answer with attach().
   */
  onDisconnected?: (code: number) => void;
  /** Called on every `joined` frame of the current generation (the host resets its re-attach backoff on it). */
  onJoined?: () => void;
  /** Receives short, secret-free diagnostics (an error name only) from the socket's handlers. */
  log?: (m: string) => void;
};

type Skip = "model_failed" | "timeout" | "unusable";
const SKIP_ALERT: Record<Skip, BotAlert> = { model_failed: "skippedModel", timeout: "skippedTimeout", unusable: "skippedUnusable" };
type Turn = { ticket: TurnTicket; hint: string | null; ac: AbortController };
type Joined = Extract<BotFrame, { type: "joined" }>;
const noop = (): void => undefined;

/**
 * US-0060: one live AI player. A state machine around one loopback socket, the pure `TurnPolicy` and one model call per turn.
 *
 * Generations: `gen` moves on every attach, detach, stop, socket loss and refusal. A socket's frames and close, and a model reply that
 * began under an older generation, are ignored or dropped; a reply also needs `policy.isCurrent(ticket)` (a pause, scene change, end or
 * reset since the turn began kills it). The bot never reconnects by itself: every close leaves it disconnected and the host (BotHost)
 * calls `attach` again. The one retry it makes alone is the single 65 s wait before the new code is tried once more after a second
 * `unauthorized`. Secrets: the join code is only ever an argument of `attach`/`connect` (the retry timer closes over it, no field
 * holds it); the reconnect token is a private field; no alert, intent entry or Error carries either.
 */
export class AiPlayerBot {
  readonly participantId = "ai-" + randomBytes(8).toString("hex");
  private readonly policy: TurnPolicy;
  private gen = 0;
  private dead = false;
  private sock: BotSocket | null = null;
  private reconnectToken: string | undefined;
  private closing: Promise<void> = Promise.resolve();
  /** The open() in flight, resolving to the socket (null when it failed). Never two sockets: drop() closes it as soon as it arrives. */
  private opening: Promise<BotSocket | null> | null = null;
  /** A keyed digest (HMAC, a fresh random key per bot) of the last code: tells whether a different code arrived without keeping any digest of the code itself. */
  private readonly codeKey = randomBytes(32);
  private codeDigest: string | null = null;
  private joinedSeen = false;
  private joinWait: (() => void) | null = null;
  private joinAlerted = false;
  private openAbort: AbortController | null = null;
  private wake: (() => void) | null = null;
  private retry: (() => void) | null = null;
  private current: Turn | null = null;
  private awaiting: { turn: Turn; cancel: () => void } | null = null;
  private lines: { roleId: string; text: string }[] = [];
  private seen = new Set<number>();
  private lastSeq = -1;
  private brief = "";
  private privateFacts: string[] = [];
  private scenes = new Map<string, { title: string; goal: string }>();
  private sceneId: string | null = null;
  private aiRoles = new Set<string>();
  private humans = false;
  private skipStreak = false;
  private nudgeFails = 0;
  private authRefusals = 0;

  constructor(private readonly d: BotDeps) {
    this.policy = new TurnPolicy({ roleId: d.roleId, settings: d.settings.turn, now: d.now });
  }

  /** The socket is open. It does NOT mean the bot has joined: see `joinedOk`. */
  get connected(): boolean { return this.sock !== null; }
  /** The socket is open AND a `joined` frame was parsed on it (the bot is seated and sees the room). */
  get joinedOk(): boolean { return this.sock !== null && this.joinedSeen; }
  get speaking(): boolean { return this.current !== null; }

  /** Closes any old socket (waiting for it), then opens one with `code` and the last reconnect token. Rejects when the socket cannot open. */
  async attach(port: number, code: string): Promise<void> {
    if (this.dead) return;
    // After rejoinFailed only a fresh attach with a NEW code re-arms the refusal count (a keyed digest, never the code, is kept to tell).
    const digest = createHmac("sha256", this.codeKey).update(code).digest("hex");
    if (this.authRefusals >= 3 && digest !== this.codeDigest) this.authRefusals = 0;
    this.codeDigest = digest;
    this.drop();
    const gen = this.gen;
    await this.closing;
    if (gen !== this.gen || this.dead) return;
    await this.connect(port, code, gen);
  }

  async detach(): Promise<void> {
    this.drop();
    await this.closing;
  }

  async stop(): Promise<void> {
    this.dead = true;
    this.drop();
    await this.closing;
  }

  /** Begins a "prompt" turn now (the facilitator's steer). False when not connected, a turn is in flight, or the policy refuses. */
  runPrompt(hint: string | null): boolean {
    if (this.dead || this.sock === null || this.current !== null || this.policy.inFlight) return false;
    return this.beginTurn("prompt", hint);
  }

  // --- connection ---

  private async connect(port: number, code: string, gen: number): Promise<void> {
    const open = this.d.open ?? BotSocket.open.bind(BotSocket);
    const ac = new AbortController();
    this.openAbort = ac;
    const attempt = open({
      port, sessionId: this.d.sessionId, roleId: this.d.roleId, participantId: this.participantId, code,
      ...(this.reconnectToken !== undefined ? { reconnectToken: this.reconnectToken } : {}), setTimer: this.d.setTimer, signal: ac.signal, ...(this.d.log ? { log: this.d.log } : {}),
      onFrame: (f) => { if (gen === this.gen) this.onFrame(f, port, code); },
      onClose: (c, info) => { if (!info.byUs && gen === this.gen) { this.drop(); this.d.onDisconnected?.(c); } },
    });
    const tracked = attempt.then((x) => x, () => null);
    this.opening = tracked;
    let s: BotSocket;
    try { s = await attempt; } catch (err) { if (gen !== this.gen || this.dead) return; throw err; } finally { if (this.opening === tracked) this.opening = null; if (this.openAbort === ac) this.openAbort = null; }
    // A drop() while the open was pending already chained this socket's close into `closing`.
    if (gen !== this.gen || this.dead) return;
    this.sock = s;
    // An open socket with no parseable joined (e.g. a frame the parser refuses) would sit mute: give up on it after a while.
    this.joinWait = this.d.setTimer(() => {
      this.joinWait = null;
      if (gen !== this.gen || this.joinedSeen) return;
      if (!this.joinAlerted) { this.joinAlerted = true; this.d.alert("rejoinFailed"); }
      this.drop();
      this.d.onDisconnected?.(BOT_NO_JOIN_CODE);
    }, BOT_JOIN_WAIT_MS);
    this.arm();
  }

  /** Forgets the room and the socket at once (the generation moves, so everything in flight is dropped); the old socket closes in the background (`closing`). */
  private drop(): void {
    this.gen += 1;
    this.wake?.(); this.wake = null;
    this.retry?.(); this.retry = null;
    this.joinWait?.(); this.joinWait = null;
    this.joinedSeen = false;
    this.openAbort?.abort(); this.openAbort = null;
    const a = this.awaiting;
    this.awaiting = null;
    if (a) { a.cancel(); this.record(a.turn, "dropped"); }
    this.current?.ac.abort();
    this.current = null;
    this.policy.reset();
    this.humans = false;
    const pending = this.opening;
    this.opening = null;
    if (pending) this.closing = Promise.all([this.closing, pending.then((x) => x?.close()).catch(noop)]).then(noop);
    const old = this.sock;
    this.sock = null;
    if (old) {
      const prev = this.closing;
      const closed = old.close().catch(noop);
      this.closing = Promise.all([prev, closed]).then(noop);
    }
  }

  // --- frames ---

  private onFrame(f: BotFrame, port: number, code: string): void {
    switch (f.type) {
      case "joined": this.seed(f); return;
      case "event": this.onEvent(f.event); return;
      case "roster":
        this.humans = f.entries.some((e) => !e.ai && e.ready);
        this.policy.observe({ kind: "humans", connected: this.humans });
        this.arm();
        return;
      case "error":
        if (f.code === "unauthorized") this.onUnauthorized(port, code);
        else if (this.awaiting) this.settleSay("dropped");
        return;
      case "ignored": return;
    }
  }

  private seed(j: Joined): void {
    this.policy.reset();
    this.joinedSeen = true;
    this.joinWait?.(); this.joinWait = null;
    this.authRefusals = 0;
    this.reconnectToken = j.reconnectToken;
    this.d.onJoined?.();
    this.brief = j.brief;
    this.privateFacts = j.privateFacts;
    this.scenes = new Map(j.scenes.map((s) => [s.id, { title: s.title, goal: s.goal }]));
    this.aiRoles = new Set(j.state.aiRoles);
    this.lastSeq = j.state.lastSeq;
    this.lines = j.state.transcript.slice(-BOT_MAX_VIEW_LINES).map((t) => ({ roleId: t.roleId, text: t.text }));
    this.seen = new Set(j.state.transcript.map((t) => t.seq));
    const cs = j.state.currentScene;
    this.sceneId = cs?.id ?? null;
    // Host contract: `scene` first, then the current scene's lines as replayed history.
    if (j.state.status === "running") this.policy.observe({ kind: "started" });
    if (j.state.status === "ended") this.policy.observe({ kind: "ended" });
    if (cs) this.policy.observe({ kind: "scene", sceneId: cs.id, participants: cs.participants });
    if (j.state.paused) this.policy.observe({ kind: "paused" });
    if (cs) for (const t of j.state.transcript) if (t.sceneId === cs.id) this.policy.observe({ kind: "line", roleId: t.roleId, ai: this.isAi(t.roleId), replayed: true });
    this.policy.observe({ kind: "humans", connected: this.humans });
    this.arm();
  }

  private isAi(roleId: string): boolean { return roleId === this.d.roleId || this.aiRoles.has(roleId); }

  private onEvent(e: BotEvent): void {
    const replayed = e.seq <= this.lastSeq;
    if (e.type === "utterance") { this.onUtterance(e, replayed); return; }
    if (replayed) return; // already part of the joined snapshot
    switch (e.type) {
      case "session.started":
        this.aiRoles = new Set(e.aiRoles);
        this.policy.observe({ kind: "started" });
        break;
      case "scene.entered":
        if (e.sceneId === this.sceneId) return;
        this.sceneId = e.sceneId;
        this.policy.observe({ kind: "scene", sceneId: e.sceneId, participants: e.participants });
        break;
      case "scene.exited": return;
      case "session.ended": this.policy.observe({ kind: "ended" }); break;
      case "session.resumed": this.policy.observe({ kind: "resumed" }); break;
      case "facilitator.command": this.policy.observe({ kind: e.command === "pause" ? "paused" : "resumed" }); break;
    }
    this.arm();
  }

  private onUtterance(e: Extract<BotEvent, { type: "utterance" }>, replayed: boolean): void {
    if (replayed && this.seen.has(e.seq)) return; // a duplicate of a line the snapshot already carried
    this.lines.push({ roleId: e.roleId, text: e.text });
    if (this.lines.length > BOT_MAX_VIEW_LINES) this.lines.shift();
    const ev: PolicyEvent = { kind: "line", roleId: e.roleId, ai: this.isAi(e.roleId), ...(replayed ? { replayed: true as const } : {}) };
    this.policy.observe(ev);
    if (!replayed) {
      if (e.roleId === this.d.roleId) { if (this.awaiting) { this.settleSay("spoken"); return; } }
      else if (!ev.ai && this.d.scenario.roles[e.roleId]?.type === "player") this.nudgeFails = 0;
    }
    this.arm();
  }

  /** The first refusal asks the host for ONE new code; a second waits BOT_AUTH_BACKOFF_MS and tries that code once more; a third gives up. */
  private onUnauthorized(port: number, code: string): void {
    const n = ++this.authRefusals;
    this.drop();
    const gen = this.gen;
    if (n === 1) this.d.needCode();
    else if (n === 2) {
      this.retry = this.d.setTimer(() => {
        this.retry = null;
        if (gen !== this.gen || this.dead) return;
        this.connect(port, code, gen).catch(() => { if (gen === this.gen && !this.dead) this.d.alert("rejoinFailed"); });
      }, BOT_AUTH_BACKOFF_MS);
    } else this.d.alert("rejoinFailed");
  }

  // --- turns ---

  /** The one timer: at `policy.wakeAt()`, re-armed after every event, finish and attach. */
  private arm(): void {
    this.wake?.(); this.wake = null;
    if (this.dead || this.sock === null || this.current !== null) return;
    const at = this.policy.wakeAt();
    if (at === null) return;
    this.wake = this.d.setTimer(() => this.onWake(), Math.max(0, at - this.d.now()));
  }

  private onWake(): void {
    this.wake = null;
    if (this.dead || this.sock === null || this.current !== null) return;
    const due = this.policy.due();
    if (!due) { this.arm(); return; }
    // Nothing re-arms here: a human line (or any other event) does.
    if (due.trigger === "nudge" && this.nudgeFails >= BOT_MAX_FAILED_NUDGES) return;
    this.beginTurn(due.trigger, null);
  }

  private beginTurn(trigger: Trigger, hint: string | null): boolean {
    const ticket = this.policy.begin(trigger);
    if (!ticket) return false;
    this.wake?.(); this.wake = null;
    const turn: Turn = { ticket, hint, ac: new AbortController() };
    this.current = turn;
    void this.runTurn(turn, this.gen);
    return true;
  }

  /** The role's own view. `injects` is always empty: the bot's frames carry no inject events. */
  private buildView(sceneId: string): PlayerView {
    const scene = this.scenes.get(sceneId) ?? { title: sceneId, goal: "" };
    return { roleId: this.d.roleId, brief: this.brief, privateFacts: this.privateFacts, scene, injects: [], lines: this.lines.map((l) => ({ roleId: l.roleId, text: l.text })) };
  }

  private async runTurn(turn: Turn, gen: number): Promise<void> {
    const { ticket } = turn;
    // Every begun turn costs one unit, taken before the call, whatever becomes of its line.
    if (!this.d.budget.take()) {
      this.record(turn, "skipped", "budget");
      if (!this.d.budget.budgetAlerted) { this.d.budget.budgetAlerted = true; this.d.alert("budget"); }
      this.endTurn(turn, false);
      return;
    }
    const line = await generateLiveLine({
      signal: turn.ac.signal, provider: this.d.provider, scenario: this.d.scenario, view: this.buildView(ticket.sceneId), trigger: ticket.trigger, hint: turn.hint, settings: this.d.settings,
    });
    if (gen !== this.gen || !this.policy.isCurrent(ticket)) {
      if (this.dead) return;
      this.record(turn, "dropped");
      if (this.current === turn) this.current = null;
      this.policy.finish(ticket, false);
      this.arm();
      return;
    }
    if (!line.ok) {
      this.record(turn, "skipped", line.reason);
      if (!this.skipStreak) { this.skipStreak = true; this.d.alert(SKIP_ALERT[line.reason]); }
      this.endTurn(turn, false);
      return;
    }
    const sock = this.sock;
    if (sock === null) { this.record(turn, "dropped"); this.endTurn(turn, false, false); return; }
    sock.say(line.text, ticket.sceneId);
    this.awaiting = { turn, cancel: this.d.setTimer(() => this.settleSay("dropped"), BOT_SAY_CONFIRM_MS) };
  }

  /** A turn that ended without a line being said. */
  private endTurn(turn: Turn, spoke: boolean, countNudge = true): void {
    this.policy.finish(turn.ticket, spoke);
    if (this.current === turn) this.current = null;
    if (countNudge && !spoke && turn.ticket.trigger === "nudge") this.nudgeFails += 1;
    this.arm();
  }

  /** B16: `spoken` only on the bot's own utterance event; `dropped` on an error frame or after BOT_SAY_CONFIRM_MS. */
  private settleSay(outcome: "spoken" | "dropped"): void {
    const a = this.awaiting;
    if (!a) return;
    this.awaiting = null;
    a.cancel();
    this.record(a.turn, outcome);
    if (outcome === "spoken") { this.skipStreak = false; this.nudgeFails = 0; }
    this.endTurn(a.turn, outcome === "spoken", outcome === "dropped");
  }

  private record(turn: Turn, outcome: "spoken" | "skipped" | "dropped", reason?: Skip | "budget"): void {
    const { ticket } = turn;
    const hint = ticket.trigger === "prompt" && turn.hint !== null ? cleanHint(turn.hint) : null;
    this.d.intents.append(this.d.sessionId, this.d.roleId, {
      ts: this.d.now(), sceneId: ticket.sceneId, trigger: ticket.trigger, outcome, ...(reason ? { reason } : {}), ...(hint !== null ? { hint } : {}),
    });
  }
}
