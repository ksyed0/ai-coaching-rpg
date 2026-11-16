import { isFileSafeId } from "@acr/events";
import { AUDIO_REFUSALS, type AudioRefusal } from "../lib/messages";
import { joinClips, type Clip } from "./console-audio-join";
import { accountSlug, priv, reportFailure, safely, throttleKey, timed } from "./console-report-handlers";
import { guard, sessionIdOf } from "./console-sessions";
import type { ConsoleCaller } from "./console-handlers";
import { fail, ok } from "./envelope";
import type { Deps } from "./handlers";
import { LauncherError, type AudioDeleteAnswer, type AudioDeleteScope } from "./launcher-client";
import type { JoinThrottle } from "./throttle";
import { readCapped } from "./report-handlers";

// A2b-2: the facilitator's audio routes (list, play, delete), plain Request -> Response, mirroring console-report-handlers.ts. Order in every
// handler: guard (console cookie, Origin and Fetch-Metadata for the delete, ownership with the neutral 404), then the legacy refusal (a
// shared-secret sign-in has no account to name in the audit trail: 403 before ANY control call), then the throttle, then the parse, then
// control. `by` is built here from the account and sent as X-Acr-By (and, on delete, as the body `by`): a `by` from the browser is ignored.
// Control's text and headers never reach the browser: a fixed sentence per closed code (AUDIO_REFUSALS). No log line carries an id, a name
// or text. Nothing the browser receives names a participant, an identity folder or a transcript position.

const READ_ROLE = "*console-audio-read";
const WRITE_ROLE = "*console-audio-write";
const MAX_DELETE_BODY_BYTES = 1024;

const say = (status: number, code: AudioRefusal, init?: ResponseInit, data?: unknown) => priv(fail(status, code, AUDIO_REFUSALS[code], init, data));
const notFound = () => priv(fail(404, "not_found", "That session was not found."));
const badRequest = () => say(400, "invalid");

/** The account's `by` for control (control's audio routes do not append `-console`): the account's slug and `-console`. */
const byOf = (who: ConsoleCaller & { accountId: string }): string => `${accountSlug(who.name, who.accountId)}-console`;

/** Charges one request to `t` for this caller; the refusal when the budget is spent (this request included). */
function charge(t: JoinThrottle, req: Request, who: ConsoleCaller, role: string): Response | null {
  const key = throttleKey(req, who);
  const retry = (ms: number) => say(429, "rate_limited", { headers: { "Retry-After": String(Math.max(1, Math.ceil(ms / 1000))) } });
  const blocked = t.blockedForMs(key, role);
  if (blocked > 0) return retry(blocked);
  t.fail(key, role);
  const justBlocked = t.blockedForMs(key, role);
  return justBlocked > 0 ? retry(justBlocked) : null;
}

/** A control failure as an answer: the audio sentences for the shared reasons, `reportFailure` for the rest (404, session_live, 410, ...). */
function audioFailure(err: unknown): Response {
  if (err instanceof LauncherError) {
    switch (err.reason) {
      case "busy": return say(503, "busy", { headers: { "Retry-After": "2" } });
      case "unavailable": return say(503, "unavailable");
      case "timeout": return say(504, "timeout");
      case "failed": return say(502, "generic");
      case "invalid": case "bad_request": return badRequest();
    }
  }
  return reportFailure(err);
}

type Ctx = { who: ConsoleCaller & { accountId: string }; id: string; by: string; launcher: NonNullable<Deps["launcher"]> };

/** The common front of all three routes; `run` is called only once every check has passed. */
function front(req: Request, deps: Deps, change: boolean, t: JoinThrottle, role: string, run: (c: Ctx) => Promise<Response>): Promise<Response> {
  return safely(async () => {
    const g = await guard(req, deps, change);
    if ("response" in g) return priv(g.response);
    if (g.who.accountId === null) return say(403, "account_required");
    const who = g.who as ConsoleCaller & { accountId: string };
    const id = sessionIdOf(req);
    if (id === null) return notFound();
    const refused = charge(t, req, who, role);
    if (refused !== null) return refused;
    if (!deps.launcher) return say(503, "unavailable");
    return run({ who, id, by: byOf(who), launcher: deps.launcher });
  });
}

/** GET .../audio: the clips of an ended session joined to their transcript lines. */
export const handleConsoleAudioList = (req: Request, deps: Deps): Promise<Response> =>
  front(req, deps, false, deps.consoleAudioReadThrottle, READ_ROLE, async (c) => {
    try {
      const listing = await timed(deps, c.launcher.audioList(c.id, c.by));
      if (listing === null) return priv(ok({ recordingStopped: false, clips: [] as Clip[] }));
      // R4: the log is read only when some clip can take a line from it.
      const needsText = listing.segments.some((s) => s.status === "transcribed" && s.seq !== undefined);
      let lines: { seq: number; roleId: string; text: string }[] = [];
      let textUnavailable = false;
      let tooLongForText = false;
      if (needsText) {
        try {
          const t = await timed(deps, c.launcher.transcript(c.id));
          if (t.kind === "ok") lines = t.lines;
          else tooLongForText = true;
        } catch (err) {
          // A live session is the whole route's answer; any other failure only costs the text.
          if (err instanceof LauncherError && err.reason === "session_live") throw err;
          textUnavailable = true;
        }
      }
      return priv(ok({
        recordingStopped: listing.recordingStopped,
        clips: joinClips(listing.segments, lines),
        ...(textUnavailable && { textUnavailable: true as const }),
        ...(tooLongForText && { tooLongForText: true as const }),
      }));
    } catch (err) {
      return audioFailure(err);
    }
  });

/** GET .../audio/play?role=&segment=: one clip's WAV, built here with exactly these headers. */
export const handleConsoleAudioPlay = (req: Request, deps: Deps): Promise<Response> =>
  front(req, deps, false, deps.consoleAudioReadThrottle, READ_ROLE, async (c) => {
    const q = new URL(req.url).searchParams;
    const role = q.getAll("role");
    const segment = q.getAll("segment");
    if (role.length !== 1 || segment.length !== 1 || !isFileSafeId(role[0]!) || !isFileSafeId(segment[0]!)) return notFound();
    try {
      const wav = await timed(deps, c.launcher.audioPlay(c.id, role[0]!, segment[0]!, c.by));
      return new Response(wav as BodyInit, {
        status: 200,
        headers: {
          "Content-Type": "audio/wav",
          "Cache-Control": "no-store",
          "Accept-Ranges": "none",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer",
        },
      });
    } catch (err) {
      return audioFailure(err);
    }
  });

type Parsed = { scope: AudioDeleteScope; reason: "facilitator" | "participant_request" };
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]) => Object.keys(o).every((k) => keys.includes(k));
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `{ scope: { kind: "session" } | { kind: "role", role }, reason }` and nothing else (a body `by` is allowed and ignored); null for anything else. */
function parseDelete(text: string, req: Request): Parsed | null {
  if ((req.headers.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase() !== "application/json") return null;
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (!isObj(v) || !exactKeys(v, ["scope", "reason", "by"])) return null;
  if (v.reason !== "facilitator" && v.reason !== "participant_request") return null;
  const s = v.scope;
  if (!isObj(s)) return null;
  if (s.kind === "session") return exactKeys(s, ["kind"]) ? { scope: { kind: "session" }, reason: v.reason } : null;
  if (s.kind === "role" && exactKeys(s, ["kind", "role"]) && typeof s.role === "string" && isFileSafeId(s.role)) return { scope: { kind: "role", role: s.role }, reason: v.reason };
  return null;
}

/** The worst of the pending reasons names the failure: a store problem, then an audit problem, then plain busy. */
const WORST = ["store_unsafe", "audit_unavailable", "busy"] as const;
const worst = (a: AudioDeleteAnswer): (typeof WORST)[number] => WORST.find((r) => a.pending.some((p) => p.reason === r)) ?? "busy";

/** POST .../audio/delete: the audited delete. Anything left undone is a 503 carrying the partial result: never a success. */
export const handleConsoleAudioDelete = (req: Request, deps: Deps): Promise<Response> =>
  front(req, deps, true, deps.consoleAudioWriteThrottle, WRITE_ROLE, async (c) => {
    const text = await readCapped(req, MAX_DELETE_BODY_BYTES);
    if (text === "too_big") return say(413, "invalid");
    if (text === null) return badRequest();
    const p = parseDelete(text, req);
    if (p === null) return badRequest();
    try {
      const a = await timed(deps, c.launcher.audioDelete(c.id, p.scope, p.reason, c.by));
      if (a.state === "done") return priv(ok(a));
      if (a.state === "live") return priv(fail(409, "session_live", AUDIO_REFUSALS.session_live, undefined, a));
      const code = worst(a);
      return say(503, code, { headers: { "Retry-After": "5" } }, a);
    } catch (err) {
      return audioFailure(err);
    }
  });
