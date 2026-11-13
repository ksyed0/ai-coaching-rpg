import { createHmac, randomBytes } from "node:crypto";
import type { ModelProvider } from "@acr/adapters";
import type { Scenario } from "@acr/script";
import { TurnPolicy, cleanHint, generateLiveLine, liveRoster, pickNudgeTarget, type AiPlayerSettings, type PlayerView, type PolicyEvent, type Trigger, type TurnTicket } from "@acr/runtime/players";
import { NudgeFloor } from "./nudge-floor.js";
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
  /** US-0081: the session's shared nudge floor (BotHost gives every bot of a session the same one); a bot alone gets its own. */
  floor?: NudgeFloor;
};

type Skip = "model_failed" | "timeout" | "unusable";
const SKIP_ALERT: Record<Skip, BotAlert> = { model_failed: "skippedModel", timeout: "skippedTimeout", unusable: "skippedUnusable" };
type Turn = { ticket: TurnTicket; hint: string | null; ac: AbortController; /** US-0081: the human seat a nudge addresses. */ target: string | null };
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
  /** US-0070 (C8): a voice turn is open in the room (the runtime's voice_turn): no reply or nudge begins, human lines are coalesced. */
  private voiceOpen = false;
  /** US-0070: the speaker of the last human line seen while the voice turn was open; observed once when it closes. */
  private deferred: string | null = null;
  /** US-0081: the current scene's participants and the speaker of each of its lines, in order (for the nudge target and the roster). */
  private participants: string[] = [];
  private sceneSpeakers: string[] = [];
  /** US-0081: the human seats the peers roster shows ready. */
  private readyHumans = new Set<string>();
  private readonly floor: NudgeFloor;
  private readonly leaveFloor: () => void;

  constructor(private readonly d: BotDeps) {
    this.policy = new TurnPolicy({ roleId: d.roleId, settings: d.settings.turn, now: d.now });
    this.floor = d.floor ?? new NudgeFloor();
    this.leaveFloor = this.floor.join(d.roleId, {
      // Another AI player's nudge was said in our scene: no nudge from us either until a human speaks.
      nudged: (sceneId) => { if (!this.dead && sceneId === this.sceneId) { this.observe({ kind: "nudged" }); this.arm(); } },
      free: () => { if (!this.dead) this.arm(); },
    });
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
    this.leaveFloor();
    await this.closing;
  }

  /** Begins a "prompt" turn now (the facilitator's steer). False when not connected, a turn is in flight, or the policy refuses. */
  runPrompt(hint: string | null): boolean {
    if (this.dead || this.sock === null || this.current !== null || this.policy.inFlight) return false;
    return this.beginTurn("prompt", hint);
  }

  /** True when `begin("prompt")` could start now (started, not ended, not paused, seated in the scene); mirrors the policy, no side effects. */
  get canPrompt(): boolean { return this.mirror.started && !this.mirror.ended && !this.mirror.paused && this.mirror.inScene; }

  private mirror = { started: false, ended: false, paused: false, inScene: false };

  private observe(e: PolicyEvent): void {
    const m = this.mirror;
    switch (e.kind) {
      case "started": m.started = true; break;
      case "scene": m.inScene = e.participants.includes(this.d.roleId); break;
      case "paused": m.paused = true; break;
      case "resumed": m.paused = false; break;
      case "ended": m.ended = true; break;
    }
    this.policy.observe(e);
  }

  private resetPolicy(): void {
    this.mirror = { started: false, ended: false, paused: false, inScene: false };
    this.policy.reset();
  }

  /**
   * US-0070 (AC-0400, C8): the runtime opened or closed a voice turn. While open the bot begins no reply or nudge and a human line only
   * joins the view; on close the last such line is observed once and the wake time asked again. Independent of the reservation hold
   * (`setHeld`); a prompted turn still runs. Never throws.
   */
  setVoiceTurn(open: boolean): void {
    if (open === this.voiceOpen) return;
    this.voiceOpen = open;
    if (open) { this.wake?.(); this.wake = null; return; }
    const roleId = this.deferred;
    this.deferred = null;
    if (roleId !== null) this.observe({ kind: "line", roleId, ai: false, ...(this.isHuman(roleId) ? { human: true as const } : {}) });
    this.arm();
  }

  /** B17: while held, the policy begins no reply or nudge. Re-asks the wake time, since a release can make a pending reply due. */
  setHeld(held: boolean): void {
    this.policy.setHeld(held);
    this.arm();
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
    this.floor.release(this.d.roleId); // US-0081: a nudge in flight is gone with the room
    this.resetPolicy();
    this.humans = false;
    this.deferred = null;
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
        this.readyHumans = new Set(f.entries.filter((e) => !e.ai && e.ready).map((e) => e.roleId));
        this.observe({ kind: "humans", connected: this.humans });
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
    this.resetPolicy();
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
    this.participants = cs?.participants ?? [];
    this.sceneSpeakers = cs ? j.state.transcript.filter((t) => t.sceneId === cs.id).map((t) => t.roleId) : [];
    // Host contract: `scene` first, then the current scene's lines as replayed history.
    if (j.state.status === "running") this.observe({ kind: "started" });
    if (j.state.status === "ended") this.observe({ kind: "ended" });
    if (cs) this.observe({ kind: "scene", sceneId: cs.id, participants: cs.participants });
    if (j.state.paused) this.observe({ kind: "paused" });
    if (cs) for (const t of j.state.transcript) if (t.sceneId === cs.id) this.observe(this.lineEvent(t.roleId, true));
    this.observe({ kind: "humans", connected: this.humans });
    this.arm();
  }

  private isAi(roleId: string): boolean { return roleId === this.d.roleId || this.aiRoles.has(roleId); }
  /** US-0081: a HUMAN player seat: a player role of the scenario that no AI plays (AI characters and AI players are not). */
  private isHuman(roleId: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.d.scenario.roles, roleId) && this.d.scenario.roles[roleId]!.type === "player" && !this.isAi(roleId);
  }
  private lineEvent(roleId: string, replayed: boolean): Extract<PolicyEvent, { kind: "line" }> {
    return { kind: "line", roleId, ai: this.isAi(roleId), ...(this.isHuman(roleId) ? { human: true as const } : {}), ...(replayed ? { replayed: true as const } : {}) };
  }

  /** US-0081 (AC-0470): the human seat a nudge addresses: of the scene's human seats the roster shows ready, the one that spoke least (pickNudgeTarget); null when none. */
  private nudgeTarget(): string | null {
    const candidates = this.participants.filter((r) => this.isHuman(r) && this.readyHumans.has(r));
    return pickNudgeTarget({ candidates, sceneSpeakers: this.sceneSpeakers, order: Object.keys(this.d.scenario.roles) });
  }

  private onEvent(e: BotEvent): void {
    const replayed = e.seq <= this.lastSeq;
    if (e.type === "utterance") { this.onUtterance(e, replayed); return; }
    if (replayed) return; // already part of the joined snapshot
    switch (e.type) {
      case "session.started":
        this.aiRoles = new Set(e.aiRoles);
        this.observe({ kind: "started" });
        break;
      case "scene.entered":
        if (e.sceneId === this.sceneId) return;
        this.sceneId = e.sceneId;
        this.participants = e.participants;
        this.sceneSpeakers = [];
        this.observe({ kind: "scene", sceneId: e.sceneId, participants: e.participants });
        break;
      case "scene.exited": return;
      case "session.ended": this.deferred = null; this.observe({ kind: "ended" }); break;
      case "session.resumed": this.observe({ kind: "resumed" }); break;
      case "facilitator.command":
        if (e.command === "pause") this.deferred = null; // US-0070: a line deferred by an open voice turn is not answered after a pause
        this.observe({ kind: e.command === "pause" ? "paused" : "resumed" }); break;
    }
    this.arm();
  }

  private onUtterance(e: Extract<BotEvent, { type: "utterance" }>, replayed: boolean): void {
    if (replayed && this.seen.has(e.seq)) return; // a duplicate of a line the snapshot already carried
    this.lines.push({ roleId: e.roleId, text: e.text });
    if (this.lines.length > BOT_MAX_VIEW_LINES) this.lines.shift();
    if (this.sceneId !== null) this.sceneSpeakers.push(e.roleId);
    const ev = this.lineEvent(e.roleId, replayed);
    // US-0070: during an open voice turn a human line is kept for the close (only the last one), not observed now.
    if (!replayed && !ev.ai && this.voiceOpen) {
      this.deferred = e.roleId;
      if (this.d.scenario.roles[e.roleId]?.type === "player") this.nudgeFails = 0;
      return;
    }
    this.observe(ev);
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
    if (this.dead || this.sock === null || this.current !== null || this.voiceOpen) return;
    const at = this.policy.wakeAt();
    if (at === null) return;
    this.wake = this.d.setTimer(() => this.onWake(), Math.max(0, at - this.d.now()));
  }

  private onWake(): void {
    this.wake = null;
    if (this.dead || this.sock === null || this.current !== null) return;
    const due = this.policy.due();
    if (!due) { this.arm(); return; }
    if (due.trigger === "reply") { this.beginTurn("reply", null); return; }
    // A nudge. Nothing re-arms on a refusal here: a human line (or any other event, or the floor coming free) does.
    if (this.nudgeFails >= BOT_MAX_FAILED_NUDGES) return;
    // US-0081: a nudge prompts the quietest human seat in the scene (none: no nudge), and only one AI player of the session nudges at a time.
    const target = this.nudgeTarget();
    if (target === null || !this.floor.claim(this.d.roleId)) return;
    if (!this.beginTurn("nudge", null, target)) this.floor.release(this.d.roleId);
  }

  private beginTurn(trigger: Trigger, hint: string | null, target: string | null = null): boolean {
    const ticket = this.policy.begin(trigger);
    if (!ticket) return false;
    this.wake?.(); this.wake = null;
    const turn: Turn = { ticket, hint, ac: new AbortController(), target };
    this.current = turn;
    void this.runTurn(turn, this.gen);
    return true;
  }

  /** The role's own view. `injects` is always empty: the bot's frames carry no inject events. */
  private buildView(sceneId: string): PlayerView {
    const scene = this.scenes.get(sceneId) ?? { title: sceneId, goal: "" };
    const roster = liveRoster({ scenario: this.d.scenario, participants: this.participants, aiRoles: this.aiRoles, self: this.d.roleId });
    return { roleId: this.d.roleId, brief: this.brief, privateFacts: this.privateFacts, scene, injects: [], lines: this.lines.map((l) => ({ roleId: l.roleId, text: l.text })), roster };
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
      signal: turn.ac.signal, provider: this.d.provider, scenario: this.d.scenario, view: this.buildView(ticket.sceneId), trigger: ticket.trigger, hint: turn.hint, target: turn.target, settings: this.d.settings,
    });
    if (gen !== this.gen || !this.policy.isCurrent(ticket)) {
      if (this.dead) return;
      this.record(turn, "dropped");
      if (this.current === turn) this.current = null;
      this.policy.finish(ticket, false);
      if (ticket.trigger === "nudge") this.floor.release(this.d.roleId);
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
    // US-0081: a said nudge closes the floor for every AI player of the session (until a human line); an unsaid one frees it.
    if (turn.ticket.trigger === "nudge") { if (spoke) this.floor.spoke(this.d.roleId, turn.ticket.sceneId); else this.floor.release(this.d.roleId); }
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
