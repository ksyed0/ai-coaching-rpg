import type { SessionEvent } from "@acr/events";
import type { NpcRole, PlayerRole, Scenario } from "@acr/script";
import type { CheckResult } from "./report.js";

export type RunKind = "mock" | "live" | "url";
/** any: runs everywhere. inproc: needs the in-process server (not --url). scripted: also needs the scripted models and fake clock (mock only). */
export type CheckKind = "any" | "inproc" | "scripted";
export type CheckDef = { id: string; title: string; kind: CheckKind };

export const CHECKS: readonly CheckDef[] = [
  { id: "F-01", title: "Players join and each receives only their own brief and private facts", kind: "any" },
  { id: "F-02", title: "A role cannot be claimed without its join code (one generic refusal for a taken, free, NPC or unknown role); the holder keeps the role", kind: "any" },
  { id: "F-03", title: "Players cannot start or command; speech before the start is refused", kind: "any" },
  { id: "F-04", title: "Only the facilitator starts the session", kind: "any" },
  { id: "F-05", title: "session.started is redacted for players and complete for the facilitator", kind: "any" },
  { id: "F-06", title: "Scene 1 starts and its opening inject reaches its recipients (and, in-process, only them)", kind: "any" },
  { id: "F-07", title: "The timed inject fires at its fake-clock minute, not before", kind: "scripted" },
  { id: "F-08", title: "The AI character answers once per player line where it is present", kind: "any" },
  { id: "F-09", title: "The AI character is silent where absent; absent roles cannot speak", kind: "any" },
  { id: "F-10", title: "A stalled model gives the fallback line plus a facilitator alert", kind: "inproc" },
  { id: "F-11", title: "An empty model reply gives the fallback line, never an empty utterance", kind: "inproc" },
  { id: "F-12", title: "A Game Master verdict exits a scene (gm_detects)", kind: "scripted" },
  { id: "F-13", title: "A malformed Game Master reply is re-asked once, then recorded as gm.no_verdict with no decision", kind: "scripted" },
  { id: "F-14", title: "The Game Master cannot record a verdict for a scene that has ended", kind: "inproc" },
  { id: "F-15", title: "Pause refuses speech and appends nothing; resume restores it", kind: "any" },
  { id: "F-16", title: "Facilitator advance moves to the next scene", kind: "any" },
  { id: "F-17", title: "A whisper reaches only its target; whispering an NPC is refused", kind: "any" },
  { id: "F-18", title: "Players never receive facilitator-only events, other roles' secrets or participant identities", kind: "any" },
  { id: "F-19", title: "Model prompts never contain the rubric, other roles' secrets, hidden facts or names", kind: "scripted" },
  { id: "F-20", title: "Malformed, unknown and oversized frames are rejected and the server survives", kind: "any" },
  { id: "F-21", title: "Hostile text is rendered safely in the terminal client", kind: "any" },
  { id: "F-22", title: "A dropped player rejoins with the reconnect token and is replayed the events it missed; an imposter is refused", kind: "any" },
  { id: "F-23", title: "A client that stops answering pings is dropped and its role freed", kind: "inproc" },
  { id: "F-24", title: "A restart rotates the old log aside intact and starts a new session at seq 1", kind: "inproc" },
  { id: "F-25", title: "The session ends with script_complete and refuses later speech", kind: "any" },
  { id: "F-26", title: "The on-disk event log is monotonic, complete and matches what the facilitator saw", kind: "inproc" },
  { id: "F-27", title: "The event sequence is sane", kind: "any" },
  { id: "F-28", title: "No API key or environment value reached the log, any client or the output", kind: "inproc" },
  { id: "F-29", title: "No background failure was swallowed", kind: "inproc" },
] as const;

/** Opt-in (`pnpm demo --security`): the in-process security room for US-0017. The default run keeps its 29 checks. */
export const SECURITY_CHECKS: readonly CheckDef[] = [
  { id: "F-31", title: "With a facilitator token set, a missing, empty, wrong or over-long token is refused and closed; the right one joins; the token is never echoed", kind: "inproc" },
  { id: "F-32", title: "A client that floods the server is throttled and closed while another client carries on unchanged", kind: "inproc" },
  { id: "F-33", title: "Connection caps (total and per address), the Origin check and the join timeout refuse abusers at the handshake", kind: "inproc" },
] as const;

/** Opt-in (`pnpm demo --resume`): the in-process resume room for US-0018. The default run keeps its 29 checks. */
export const RESUME_CHECKS: readonly CheckDef[] = [
  { id: "F-34", title: "A server killed mid-scene restarts into the same state from its log, paused, with the scene time it had", kind: "inproc" },
  { id: "F-35", title: "Nothing that came due during the downtime fires on /resume; a timed inject fires once, at its minute of active time", kind: "inproc" },
  { id: "F-36", title: "The player line left unanswered by the crash is answered exactly once, after /resume", kind: "inproc" },
  { id: "F-37", title: "After a restart players rejoin with the same join codes (none without) and each gets only the history and missed events it may see", kind: "inproc" },
  { id: "F-38", title: "A restart against changed scenario files is refused and the log is left untouched", kind: "inproc" },
  { id: "F-39", title: "A log corrupt in the middle is refused untouched; a cut-off last line is cut and the session resumes", kind: "inproc" },
  { id: "F-40", title: "SESSION_START=fresh moves the log aside byte for byte and starts a new session at seq 1", kind: "inproc" },
  { id: "F-41", title: "A restart over a session that had ended moves its log aside and starts fresh", kind: "inproc" },
  { id: "F-42", title: "While one server holds a session log, a second one is refused by the lock and changes nothing", kind: "inproc" },
  { id: "F-43", title: "A log cut between the events of one operation (a scene exit, an inject and its effect) is completed on restart, and the completion is logged", kind: "inproc" },
] as const;

export const CHECK_IDS: readonly string[] = CHECKS.map((c) => c.id);
export const def = (id: string): CheckDef => {
  const d = CHECKS.find((c) => c.id === id);
  if (!d) throw new Error(`unknown check ${id}`);
  return d;
};

/** Why a check is not applicable in this kind of run, or null when it runs. */
export function skipReason(d: CheckDef, kind: RunKind): string | null {
  if (kind === "url" && d.kind !== "any") return "skipped (needs in-process server)";
  if (kind === "live" && d.kind === "scripted") return "skipped (live mode)";
  return null;
}

export class CheckFailure extends Error {}
/** Throws a CheckFailure (the check's recorded evidence) when the condition does not hold. */
export function ensure(cond: unknown, message: string): asserts cond {
  if (!cond) throw new CheckFailure(message);
}

/** Collects one result per check. A failing check never stops the others; dependents are skipped, never hidden. */
export class Recorder {
  private readonly results = new Map<string, CheckResult>();
  private readonly defs: readonly CheckDef[];
  constructor(private readonly o: {
    kind: RunKind; now: () => number; forceFail?: ReadonlySet<string>; bypass?: ReadonlySet<string>; onResult?: (r: CheckResult) => void; aborted?: () => boolean;
    /** The checks this run owns (default: the 29 feature checks; the showcase passes its own list). */
    defs?: readonly CheckDef[];
  }) {
    this.defs = o.defs ?? CHECKS;
    for (const d of this.defs) {
      const reason = skipReason(d, o.kind);
      if (reason) this.put({ id: d.id, title: d.title, status: "skipped", details: reason, durationMs: 0 });
    }
  }
  private put(r: CheckResult): void { this.results.set(r.id, r); this.o.onResult?.(r); }
  status(id: string): CheckResult["status"] | undefined { return this.results.get(id)?.status; }
  passed(id: string): boolean { return this.status(id) === "passed"; }
  private defOf(id: string): CheckDef {
    const d = this.defs.find((c) => c.id === id);
    if (!d) throw new Error(`unknown check ${id}`);
    return d;
  }
  /** Whether this run defines the check at all (opt-in checks exist only when asked for). */
  has(id: string): boolean { return this.defs.some((c) => c.id === id); }
  applicable(id: string): boolean { return skipReason(this.defOf(id), this.o.kind) === null; }

  /** Runs one check. `fn` returns the one-line evidence; throwing marks it failed. Returns whether it passed. */
  async run(id: string, fn: () => Promise<string> | string, needs: string[] = []): Promise<boolean> {
    const d = this.defOf(id);
    if (!this.applicable(id) || this.o.bypass?.has(id)) return false; // a bypassed check is left unrecorded (test hook)
    const blocked = needs.filter((n) => !this.passed(n));
    if (blocked.length) {
      this.put(this.notRun(d, `prerequisite failed: ${blocked.join(", ")}`));
      return false;
    }
    const t0 = this.o.now();
    let status: CheckResult["status"] = "passed";
    let details: string;
    try {
      details = await fn();
    } catch (err) {
      if (this.o.aborted?.()) throw err;
      status = "failed";
      details = err instanceof CheckFailure ? err.message : `error: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (status === "passed" && this.o.forceFail?.has(id)) { status = "failed"; details = "forced failure (test hook)"; }
    this.put({ id, title: d.title, status, details, durationMs: this.o.now() - t0 });
    return status === "passed";
  }

  /**
   * A check that did not run. Mode-based skips (live, --url) were recorded up front by the constructor; anything else that
   * did not run is a FAILURE in every mode, so a silent code-path bypass can never exit 0 because something else passed.
   */
  private notRun(d: CheckDef, reason: string): CheckResult {
    return { id: d.id, title: d.title, status: "failed", details: `did not run (${reason})`, durationMs: 0 };
  }

  /** Records every check that never ran (see notRun). */
  finish(reason: string): void {
    for (const d of this.defs) if (!this.results.has(d.id)) this.put(this.notRun(d, reason));
  }
  ordered(): CheckResult[] { return this.defs.map((d) => this.results.get(d.id)).filter((r): r is CheckResult => r !== undefined); }
}

// ---- pure helpers shared by the acts --------------------------------------------------------------------------

/** Control characters, bidi overrides and C1 controls: none may survive into terminal output. */
export const UNSAFE_CHARS = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069]");

/** The markers (strings that really exist in the scenario) that must stay out of places they do not belong. */
export type Markers = {
  /** Rubric ids, criteria, learning-objective text and facilitator notes: never in any model prompt. */
  rubric: string[];
  /** NPC hidden facts: never in a prompt until the Game Master releases one. */
  hidden: string[];
  /** Every player role's brief and private facts, whole and distinctive fragments. */
  secretsByRole: Record<string, string[]>;
  /** What only the facilitator may see: NPC goals and knowledge. */
  npcInternals: string[];
};

/** Distinctive fragments of the shipped scenario (they must exist in it: assertMarkersExist proves it). */
const FRAGMENTS: Record<string, string[]> = {
  delivery_lead: ["6 person-weeks", "You run the programme day to day", "2,400 per person-day"],
  tech_lead: ["half the effort", "puts the go-live date at", "ingestion layer", "You own the architecture"],
  account_manager: ["three times this programme", "renewal decision maker", "You own price, commercial terms"],
};
const RUBRIC_FRAGMENTS = ["individual_delivery_v2", "group_collaboration_v1", "commercial_judgement", "team_alignment", "role_clarity",
  "Protect scope and margin while preserving the relationship", "agreeing to the module in scene 2 without pricing it"];
const HIDDEN_FRAGMENTS = ["phased delivery after go-live if the risk"];

export function buildMarkers(scenario: Scenario): Markers {
  const roles = Object.values(scenario.roles);
  const players = roles.filter((r): r is PlayerRole => r.type === "player");
  const npcs = roles.filter((r): r is NpcRole => r.type === "npc");
  const secretsByRole: Record<string, string[]> = {};
  for (const p of players) secretsByRole[p.id] = [p.brief, ...p.private_facts, ...(FRAGMENTS[p.id] ?? [])];
  const m = scenario.meta;
  return {
    rubric: [...m.rubrics, ...m.learning_objectives.map((lo) => lo.statement), ...(m.facilitator_notes ? [m.facilitator_notes] : []), ...RUBRIC_FRAGMENTS].filter(Boolean),
    hidden: [...npcs.flatMap((n) => n.hidden), ...HIDDEN_FRAGMENTS],
    secretsByRole,
    npcInternals: npcs.flatMap((n) => [...n.goals, ...n.knowledge, ...n.hidden]),
  };
}

/** Proves every marker really exists in the scenario, so an absence audit is never vacuous. Returns the missing ones. */
export function missingMarkers(scenario: Scenario, markers: Markers): string[] {
  const hay = JSON.stringify(scenario);
  const all = [...markers.rubric, ...markers.hidden, ...Object.values(markers.secretsByRole).flat(), ...markers.npcInternals];
  return all.filter((x) => !hay.includes(JSON.stringify(x).slice(1, -1)));
}

/** Markers found in `haystack`, de-duplicated and shortened for evidence. */
export function findMarkers(haystack: string, markers: string[]): string[] {
  return [...new Set(markers.filter((x) => x && haystack.includes(x)))].map((x) => (x.length > 40 ? `${x.slice(0, 40)}…` : x));
}

/** One short token per event, for the scene-level trace. */
export function sceneTrace(events: SessionEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.type === "scene.entered") out.push(`entered:${e.sceneId}`);
    else if (e.type === "scene.exited") out.push(`exited:${e.sceneId}:${e.reason}`);
    else if (e.type === "session.ended") out.push(`ended:${e.reason}`);
  }
  return out;
}

/** Problems with a log's shape: seq 1..n without gaps, ts and sessionId on every event. */
export function logShapeProblems(events: SessionEvent[], sessionId: string): string[] {
  const problems: string[] = [];
  events.forEach((e, i) => {
    if (e.seq !== i + 1) problems.push(`event ${i + 1} has seq ${e.seq}`);
    if (typeof e.ts !== "number" || !Number.isFinite(e.ts)) problems.push(`event ${e.seq} has no numeric ts`);
    if (e.sessionId !== sessionId) problems.push(`event ${e.seq} has a different sessionId`);
    if (i > 0 && typeof e.ts === "number" && e.ts < events[i - 1]!.ts) problems.push(`event ${e.seq} goes back in time`);
  });
  return problems.slice(0, 5);
}

/** Injects (by scene) whose text reached `inboxJson` although they are not addressed to `role`. Matches the JSON-escaped form. */
export function findInjectLeaks(inboxJson: string, role: string, scenes: Scenario["script"]["scenes"]): string[] {
  const out: string[] = [];
  for (const scene of scenes) {
    for (const inj of scene.injects ?? []) {
      if (!inj.to.includes(role) && inboxJson.includes(JSON.stringify(inj.content).slice(1, -1))) out.push(inj.id);
    }
  }
  return out;
}

/** Before the restarted session starts, the data dir must hold the rotated log and NO `<sessionId>.jsonl` (judged from a directory listing, never a stat of a path read later). */
export function assertRotatedOnly(listing: string[], sessionId: string, rotatedName: string): void {
  ensure(listing.includes(rotatedName), `the rotated log ${rotatedName} is missing from the data directory`);
  ensure(!listing.includes(`${sessionId}.jsonl`), "the new log existed before the new session started");
}
