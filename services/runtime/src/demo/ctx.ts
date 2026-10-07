import { isClientRoleKey, type SessionEvent } from "@acr/events";
import type { NpcRole, PlayerRole, Scenario } from "@acr/script";
import { Bot, isEvent, type Inbound } from "./bots.js";
import { ensure, type Markers, type Recorder, type RunKind } from "./checks.js";
import type { System, TempRoot } from "./harness.js";
import type { LiveEvidence } from "./live-evidence.js";
import type { Narrator } from "./narrator.js";
import type { ProviderKind } from "./provenance.js";
import type { Transcript } from "./transcript.js";
import { alertsForReply } from "./live-evidence.js";
import { isFallbackReply } from "./provenance.js";
import { isPlausibleJoinCode } from "../cli/join-code.js";

export const ROLE_PLAYERS = [
  ["delivery_lead", "ZedAlphaParticipant"],
  ["tech_lead", "ZedBravoParticipant"],
  ["account_manager", "ZedCharlieParticipant"],
] as const;
export type PlayerId = (typeof ROLE_PLAYERS)[number][0];
/** Names that exist only so the audits can prove they never reach another participant or a model. */
export const OTHER_NAMES = ["ZedMalloryParticipant", "ZedDeltaParticipant", "ZedGhostParticipant", "ZedEchoParticipant"];
export const PARTICIPANT_NAMES = [...ROLE_PLAYERS.map(([, n]) => n), ...OTHER_NAMES];

export type Joined = Extract<Inbound, { type: "joined" }>;
export type Utter = Extract<SessionEvent, { type: "utterance" }>;

export type Ctx = {
  kind: RunKind;
  /** The structured record of the run (Markdown transcript); absent unless --transcript was given. */
  tr?: Transcript;
  /** Whose models answer the AI characters (decides GENERATED vs SCRIPTED); mock when unspecified. */
  provider?: ProviderKind;
  n: Narrator;
  rec: Recorder;
  signal: AbortSignal;
  scenario: Scenario;
  markers: Markers;
  sessionId: string;
  wsUrl: string;
  repoRoot: string;
  /** The in-process system (mock and live runs). Absent with --url. */
  sys?: System;
  tmp?: TempRoot;
  /** How long to wait for an NPC reply (live and --url runs depend on real model latency). */
  npcWaitMs: number;
  /** Everything the narrator printed, for the secrets audit. */
  outputTap: string[];
  /** Log lines from the side room, for the audits. */
  labLogs: string[];
  labHostLog: string[];
  bots: Bot[];
  /** A facilitator token for the --url target (from FACILITATOR_TOKEN); undefined for in-process runs, which are open. Never printed. */
  facilitatorToken?: string;
  /** US-0033: the --url target's player join codes (from JOIN_CODES, role=code pairs). In-process runs use `sys.joinCodes`. Never printed. */
  urlJoinCodes?: Record<string, string>;
  /** US-0023: the `--max-fallbacks` limit of the 29-check run (null or absent: none, the fallback count is only a warning). */
  maxFallbacks?: number | null;
  /** Values that must never appear in the log, any client or the output. */
  secretValues: string[];
  beforeAct?: (name: string) => Promise<void>;
  register: (cleanup: () => Promise<void> | void) => void;
  now: () => number;
};

/** What the story builds up and the audits read. */
export type Story = {
  fac?: Bot;
  facJoined?: Joined;
  players: Partial<Record<PlayerId, Bot>>;
  joined: Partial<Record<PlayerId, Joined>>;
  /** Outcomes of driving steps that a later check turns into evidence (an error becomes the check's failure). */
  ev: Record<string, Attempt>;
  broken: string | null;
  /** US-0023: the AI replies and alerts of the whole run, read from the facilitator's stream at the end (feeds the JSON report). */
  evidence?: LiveEvidence;
};
export type Attempt<T = unknown> = { ok: true; value: T } | { ok: false; error: string };
export const newStory = (): Story => ({ players: {}, joined: {}, ev: {}, broken: null });

export const roleList = (s: Scenario) => Object.values(s.roles);
export const npcRole = (s: Scenario): NpcRole => roleList(s).find((r): r is NpcRole => r.type === "npc")!;
export const playerRole = (s: Scenario, id: string): PlayerRole => s.roles[id] as PlayerRole;
export const sceneIds = (s: Scenario) => s.script.scenes.map((x) => x.id);

export const errCode = (m: Inbound): string => (m.type === "error" ? m.code : m.type);
export const isJoinedMsg = (m: Inbound): m is Joined => m.type === "joined";
export const utterancesOf = (events: SessionEvent[]): Utter[] => events.filter((e): e is Utter => e.type === "utterance");

/** Utterances grouped by the scene they were spoken in (derived from the facilitator's complete stream). */
export function utterancesByScene(events: SessionEvent[]): Record<string, Utter[]> {
  const out: Record<string, Utter[]> = {};
  let cur: string | null = null;
  for (const e of events) {
    if (e.type === "scene.entered") cur = e.sceneId;
    else if (e.type === "scene.exited") cur = null;
    else if (e.type === "utterance" && cur) (out[cur] ??= []).push(e);
  }
  return out;
}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms); });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

export async function attempt<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<Attempt<T>> {
  try { return { ok: true, value: await fn() }; }
  catch (err) {
    if (signal.aborted) throw err;
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
/** Unwraps a recorded attempt inside a check: a failed drive step becomes the check's failure. */
export function got<T>(a: Attempt | undefined, what: string): T {
  ensure(a, `${what}: this step never ran`);
  ensure(a.ok, `${what}: ${a.ok ? "" : a.error}`);
  return a.value as T;
}

/** The facilitator's first message: carries the token only when the --url target needs one. */
export const facilitatorJoin = (ctx: Ctx): { type: "join_facilitator"; sessionId: string; token?: string } =>
  ({ type: "join_facilitator", sessionId: ctx.sessionId, ...(ctx.facilitatorToken !== undefined ? { token: ctx.facilitatorToken } : {}) });

/** The join code the operator would hand to `role` on the main system (in-process: issued by the system; --url: JOIN_CODES). */
export const codeFor = (ctx: Ctx, role: string): string | undefined => (ctx.sys ? ctx.sys.joinCodes[role] : ctx.urlJoinCodes?.[role]);

/** A player's join message, carrying the role's join code (US-0033) unless `extra` overrides it. */
export function playerJoin(ctx: Ctx, role: string, participantId: string, extra: { joinCode?: string; reconnectToken?: string; codes?: Record<string, string>; sessionId?: string; lastSeq?: number } = {}): Record<string, unknown> {
  const { codes, sessionId, ...rest } = extra;
  const code = codes ? codes[role] : codeFor(ctx, role);
  return { type: "join", sessionId: sessionId ?? ctx.sessionId, roleId: role, participantId, ...(code !== undefined ? { joinCode: code } : {}), ...rest };
}

/**
 * `pnpm demo --url`: the target server's player join codes, as its operator was shown them at start, from JOIN_CODES
 * (`role=CODE,role=CODE`). Errors never quote a value.
 */
export function parseJoinCodesEnv(raw: string | undefined): { ok: true; codes: Record<string, string> } | { ok: false; error: string } {
  const codes: Record<string, string> = {};
  if (raw === undefined || raw.trim() === "") return { ok: true, codes };
  for (const part of raw.split(",").map((x) => x.trim()).filter(Boolean)) {
    const eq = part.indexOf("=");
    const role = eq > 0 ? part.slice(0, eq).trim() : "";
    const code = eq > 0 ? part.slice(eq + 1).trim() : "";
    if (!isClientRoleKey(role) || !isPlausibleJoinCode(code) || Object.hasOwn(codes, role)) {
      return { ok: false, error: "error: JOIN_CODES must be comma separated role=CODE pairs, one per player role, with the codes the server printed at start (the value is not shown)" };
    }
    codes[role] = code;
  }
  return { ok: true, codes };
}

/** Every form of a code that must never be printed (as shown, and as the server compares it). */
export const codeSecrets = (codes: Record<string, string>): string[] => Object.values(codes).flatMap((c) => [c, c.replace(/-/g, "")]);

export async function connectBot(ctx: Ctx, label: string, o: { url?: string; autoPong?: boolean; inbox?: Inbound[]; headers?: Record<string, string> } = {}): Promise<Bot> {
  const bot = await Bot.connect(o.url ?? ctx.wsUrl, label, { signal: ctx.signal, autoPong: o.autoPong, inbox: o.inbox, headers: o.headers });
  ctx.bots.push(bot);
  return bot;
}

/** In-process runs let the host finish its background NPC and Game Master work; external runs wait for events instead. */
export async function settle(ctx: Ctx, st?: Story): Promise<void> {
  if (!ctx.sys) return;
  await ctx.sys.host.idle();
  // Everything the engine appended has been broadcast; wait until the facilitator's socket has delivered it too.
  const fac = st?.fac;
  if (fac && fac.isOpen) await fac.waitFor((m) => m.type === "event" && m.event.seq >= ctx.sys!.engine.state.lastSeq, { what: "the facilitator's stream to catch up" });
}

/** One scripted line: sent as the player, confirmed by the server's own echo, narrated, then background work settles. */
export async function say(ctx: Ctx, st: Story, role: PlayerId, text: string): Promise<Utter> {
  const bot = st.players[role]!;
  const from = bot.mark();
  bot.send({ type: "say", text });
  const r = await bot.waitFor((m) => m.type === "error" || isEvent("utterance", (e) => e.roleId === role && e.text === text)(m), { from, what: `${role}'s line to be accepted` });
  ensure(r.type === "event", `${role}'s line was refused: ${errCode(r)}`);
  await ctx.n.say(role, text);
  await settle(ctx, st);
  return (r as Extract<Inbound, { type: "event" }>).event as Utter;
}

/** Waits for the next AI-character line the facilitator sees after `from`, and narrates it. */
export async function awaitNpc(ctx: Ctx, st: Story, from: number): Promise<Utter> {
  const npc = npcRole(ctx.scenario);
  const m = await st.fac!.waitFor(isEvent("utterance", (e) => e.roleId === npc.id), { from, timeoutMs: ctx.npcWaitMs, what: `${npc.id}'s reply` });
  const e = (m as Extract<Inbound, { type: "event" }>).event as Utter;
  const evs = st.fac!.events();
  const canned = isFallbackReply(npc, e, evs[evs.findIndex((x) => x.seq === e.seq) - 1], { legacy: ctx.kind === "url" });
  await ctx.n.say(`${npc.name} (${npc.id})${canned ? ", canned fallback line" : ""}`, e.text);
  // US-0023: the (sanitized) alerts that belong to this reply, right next to it: why it is canned, or what was cut from it.
  for (const a of alertsForReply(evs, e, { secrets: ctx.secretValues, hidden: ctx.markers.hidden, scenario: ctx.scenario, legacy: ctx.kind === "url" })) {
    await ctx.n.note(`alert (${a.level}) for this reply: ${a.fallback ? `fell back to its canned line: ${a.reason}` : a.reason}`);
  }
  return e;
}

/** A facilitator command, confirmed by its echo. Returns normally only when the server accepted it. */
export async function command(ctx: Ctx, st: Story, cmd: Record<string, unknown> & { command: string }, narration?: string): Promise<void> {
  const fac = st.fac!;
  const from = fac.mark();
  fac.send({ type: "command", command: cmd });
  const r = await fac.waitFor((m) => m.type === "error" || isEvent("facilitator.command", (e) => e.command === cmd.command)(m), { from, what: `${cmd.command} to be accepted` });
  ensure(r.type === "event", `facilitator ${cmd.command} was refused: ${errCode(r)}`);
  await ctx.n.step(narration ?? `facilitator: ${cmd.command}`);
  await settle(ctx, st);
}

export const currentSceneFromFac = (st: Story): string | null => {
  let cur: string | null = null;
  for (const e of st.fac!.events()) { if (e.type === "scene.entered") cur = e.sceneId; else if (e.type === "scene.exited") cur = null; }
  return cur;
};

/** Advance-driven progress (live and --url): moves on only if the target scene is not already entered. */
export async function advanceTo(ctx: Ctx, st: Story, sceneId: string | "end"): Promise<void> {
  const fac = st.fac!;
  const reached = () => fac.events().some((e) => (sceneId === "end" ? e.type === "session.ended" : e.type === "scene.entered" && e.sceneId === sceneId));
  if (!reached()) {
    await command(ctx, st, { command: "advance" }, `facilitator: advance (towards ${sceneId === "end" ? "the end" : sceneId})`);
    await fac.waitFor(sceneId === "end" ? isEvent("session.ended") : isEvent("scene.entered", (e) => e.sceneId === sceneId), { timeoutMs: 10_000, what: `the session to reach ${sceneId}` });
  }
}

/** Runs one act. A driving failure ends the story (later acts are skipped, never faked); checks still report. */
export async function act(ctx: Ctx, st: Story, n: number | string, title: string, fn: () => Promise<void>, o: { always?: boolean } = {}): Promise<void> {
  if (st.broken && !o.always) return;
  if (ctx.signal.aborted) throw new Error("run aborted");
  if (ctx.beforeAct) {
    const aborted = new Promise<never>((_, reject) => ctx.signal.addEventListener("abort", () => reject(new Error("run aborted")), { once: true }));
    await Promise.race([ctx.beforeAct(title), aborted]);
  }
  await ctx.n.act(n, title);
  try { await fn(); }
  catch (err) {
    if (ctx.signal.aborted) throw err;
    st.broken = `act ${n} stopped: ${err instanceof Error ? err.message : String(err)}`;
    ctx.n.fail(st.broken);
  }
}
