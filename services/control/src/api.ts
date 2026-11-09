import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";
import { isFileSafeId, isSafeId, isValidSessionId, REPORT_SENTENCES } from "@acr/events";
import { z } from "zod";
import { ParticipantIdSchema, RoleIdSchema } from "./protocol.js";
import { BAD_REQUEST, fail, HttpError, jsonBody, MAX_BODY_BYTES, ok, parse } from "./http-util.js";
import type { ControlConfig } from "./config.js";
import type { ParticipantWriteService, WriteOutcome } from "./participant-writes.js";
import { handleReportRoute } from "./moderation-routes.js";
import type { ModerationService } from "./moderation.js";
import type { ReportJobService } from "./report-job.js";
import { isCredentialId } from "./report-access.js";
import type { ReportService } from "./reports.js";
import { ControlError, type ControlErrorCode, type Supervisor } from "./supervisor.js";

/** Participant write caps. The self-rating cap assumes at most about 10 criteria of 1,500 CJK characters (today's rubrics have 7). */
export const MAX_RESPONSE_BODY_BYTES = 16 * 1024;
export const MAX_SELF_RATINGS_BODY_BYTES = 64 * 1024;

const STATUS: Record<ControlErrorCode, number> = {
  bad_request: 400, unknown_scenario: 400, not_found: 404, conflict: 409, capacity: 429, timeout: 504, start_failed: 502, unavailable: 503,
  ai_role: 409, ai_notice: 409, ai_started: 409, ai_no_human: 409, ai_too_many: 409, ai_invalid: 400,
  ai_busy: 409, ai_budget: 409, ai_absent: 409, ai_expired: 409,
  voice_refused: 409, voice_off: 409, voice_unavailable: 503,
};
export { MAX_BODY_BYTES };
const UNAUTHORIZED = "Unauthorized.";
const INTERNAL = "Something went wrong.";
const MAX_FIELD = 200;

const CreateBody = z.strictObject({ scenarioId: z.string().min(1).max(MAX_FIELD) });
// One role, or the whole session: never "neither". A body that forgets roleId must not silently reissue every code.
const ReissueBody = z.strictObject({ roleId: z.string().min(1).max(MAX_FIELD).optional(), all: z.literal(true).optional(), by: z.string().max(MAX_FIELD).optional(), reason: z.literal("removed").optional() })
  .refine((b) => (b.roleId === undefined) !== (b.all === undefined))
  .refine((b) => b.reason === undefined || b.roleId !== undefined); // a remove names its role
const AiRolesBody = z.strictObject({ roles: z.array(z.string().min(1).max(MAX_FIELD)).max(12), includeInGroup: z.boolean().optional() });
const ReservationId = z.string().regex(/^[0-9a-f]{32}$/);
const RunBody = z.strictObject({ reservation: ReservationId, hint: z.string().max(1200).optional() });
const ReleaseBody = z.strictObject({ reservation: ReservationId });
const NoBody = z.strictObject({});
const LinkBody = z.strictObject({ role: z.string().min(1).max(MAX_FIELD) });
const ExchangeBody = z.strictObject({ token: z.string().max(64) });
// Text bounds are UTF-16 units (twice the 1,500 code-point limit): the runtime counts code points, so 1,500 emoji must pass here.
const TEXT_UNITS = 1500 * 2;
const CriterionId = z.string().refine(isFileSafeId);
const SelfRatingsBody = z.strictObject({
  ratings: z.array(z.strictObject({
    criterion: CriterionId,
    level: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.null()]),
    note: z.string().max(TEXT_UNITS).optional(),
  })).max(50),
});
const ResponseBody = z.strictObject({ criterion: CriterionId.optional(), text: z.string().max(TEXT_UNITS), dispute: z.boolean().optional() });
const REPORT_UNAVAILABLE = REPORT_SENTENCES.reportUnavailable;
/** True when `v` has a C0 or C1 control character (checked character by character). */
const hasControlChar = (v: string): boolean => { for (let i = 0; i < v.length; i++) { const c = v.charCodeAt(i); if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return true; } return false; };
/** US-0071 (A1b Task 5): the BFF names the cookie's own seat; the participant id follows the parent channel's rule. */
const VoiceTokenBody = z.strictObject({ roleId: RoleIdSchema, participantId: ParticipantIdSchema.refine((v) => !hasControlChar(v), { message: "invalid participant id" }) });

const digest = (s: string): Buffer => createHash("sha256").update(s).digest();

/** Constant time: both sides are hashed to the same length first, so neither the length nor the content leaks through timing. */
function tokenOk(given: string | string[] | undefined, expected: string): boolean {
  if (typeof given !== "string") return false;
  return timingSafeEqual(digest(given), digest(expected));
}

/** The error's name when it is a plain identifier (the shared rule), else a fixed word: never a message, never free text. */
const errorName = (err: unknown): string => {
  if (!(err instanceof Error)) return "unknown";
  return isSafeId(err.name) ? err.name : "Error";
};

/**
 * The control service's HTTP surface (loopback only, called by the BFF). The service token is checked BEFORE anything else, so an
 * unauthenticated caller learns nothing, not even which paths exist. Codes and the facilitator token appear only in response bodies:
 * nothing here logs a body, a path with an id, a message or a port.
 */
export function createApi(deps: {
  config: ControlConfig; supervisor: Supervisor; scenarios: () => Promise<{ id: string; title: string }[]>; log?: (m: string) => void;
  /** Report links (EPIC-0002). Optional: the routes answer 404 when it is absent. */
  reports?: ReportService;
  /** Participant ratings and responses (EPIC-0002). Optional: the routes answer 404 when it is absent. */
  participantWrites?: ParticipantWriteService;
  /** The evaluate job and the facilitator's review operations (EPIC-0002). Optional: the routes answer 404 when absent. */
  jobs?: ReportJobService;
  moderation?: ModerationService;
}): RequestListener {
  const { config, supervisor, scenarios, reports, participantWrites, jobs, moderation } = deps;
  const log = deps.log ?? (() => {});

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "";
    let pathname: string;
    try { pathname = new URL(req.url ?? "/", "http://localhost").pathname; } catch { throw new HttpError(404, "not_found", "Not found."); }
    const seg = pathname.split("/").slice(1);
    if (seg[seg.length - 1] === "" && seg.length > 1) seg.pop();
    const notFound = (): never => { throw new HttpError(404, "not_found", "Not found."); };
    const sessionId = (raw: string): string => {
      let id: string;
      try { id = decodeURIComponent(raw); } catch { return notFound(); }
      if (!isValidSessionId(id)) return notFound();
      return id;
    };

    if (seg[0] === "scenarios" && seg.length === 1 && method === "GET") return ok(res, await scenarios());
    // One neutral refusal for every unknown, expired, revoked, wrong-session or malformed token or credential id: the same
    // constant status, body and headers on every path, so nothing tells the cases apart.
    const neutral = (): never => notFound();
    if (seg[0] === "report-access" && seg.length === 2 && seg[1] === "exchange" && method === "POST") {
      if (!reports) return notFound();
      const parsed = ExchangeBody.safeParse(await jsonBody(req));
      if (!parsed.success) return neutral();
      const found = await reports.exchange(parsed.data.token);
      return found === null ? neutral() : ok(res, found);
    }
    if (seg[0] !== "sessions") return notFound();
    if (seg.length === 1) {
      if (method === "GET") return ok(res, supervisor.list());
      if (method === "POST") return ok(res, await supervisor.create(parse(CreateBody, await jsonBody(req)).scenarioId));
      return notFound();
    }
    const id = sessionId(seg[1]!);
    if (seg.length === 2 && method === "GET") {
      const info = supervisor.get(id);
      if (!info) throw new HttpError(404, "not_found", "That session does not exist.");
      return ok(res, info);
    }
    if (seg.length === 3 && seg[2] === "facilitator" && method === "GET") {
      const f = supervisor.facilitator(id);
      if (!f) throw new HttpError(404, "not_found", "That session does not exist.");
      return ok(res, { port: f.port, token: f.token });
    }
    if (seg.length === 3 && seg[2] === "voice-token" && method === "POST") {
      // US-0071 (A1b Task 5): the body is checked before anything is called; only the token and its expiry leave (never a room or an identity).
      const body = parse(VoiceTokenBody, await jsonBody(req));
      const t = await supervisor.voiceToken(id, body.roleId, body.participantId);
      return ok(res, { token: t.token, expiresAt: t.expiresAt });
    }
    if (seg.length === 3 && seg[2] === "restart" && method === "POST") {
      parse(NoBody, (await jsonBody(req)) ?? {});
      return ok(res, await supervisor.restart(id));
    }
    if (seg.length === 3 && seg[2] === "ai-roles" && method === "PUT") {
      const body = parse(AiRolesBody, await jsonBody(req));
      return ok(res, await supervisor.setAiRoles(id, body.roles, body.includeInGroup)); // codes: human roles only (the supervisor keeps AI codes to the bots)
    }
    if (seg.length === 5 && seg[2] === "ai-roles" && seg[4] === "intents" && method === "GET") {
      let roleId: string;
      try { roleId = decodeURIComponent(seg[3]!); } catch { return notFound(); }
      if (!RoleIdSchema.safeParse(roleId).success) return notFound(); // before anything reads a file
      return ok(res, { entries: supervisor.intents(id, roleId) });
    }
    if (seg.length === 5 && seg[2] === "ai-roles" && method === "POST" && (seg[4] === "reserve" || seg[4] === "run" || seg[4] === "release")) {
      let roleId: string;
      try { roleId = decodeURIComponent(seg[3]!); } catch { return notFound(); }
      if (!RoleIdSchema.safeParse(roleId).success) return notFound(); // before the body is read or anything is called
      if (seg[4] === "reserve") { parse(NoBody, (await jsonBody(req)) ?? {}); return ok(res, { reservation: supervisor.reserveTurn(id, roleId) }); }
      if (seg[4] === "run") {
        const b = parse(RunBody, await jsonBody(req));
        supervisor.runTurn(id, roleId, b.reservation, b.hint);
        return ok(res, { started: true });
      }
      supervisor.releaseTurn(id, roleId, parse(ReleaseBody, await jsonBody(req)).reservation);
      return ok(res, {});
    }
    if (seg.length === 4 && seg[2] === "reports" && method === "GET") {
      if (!reports) return notFound();
      let credentialId: string;
      try { credentialId = decodeURIComponent(seg[3]!); } catch { return neutral(); }
      if (!isCredentialId(credentialId)) return neutral(); // before any lookup
      const r = await reports.read(id, credentialId);
      if (r.status === 200) return ok(res, r.body);
      if (r.status === 503) return fail(res, 503, "unavailable", REPORT_UNAVAILABLE);
      return neutral();
    }
    if (seg.length === 5 && seg[2] === "reports" && ((seg[4] === "self-ratings" && method === "PUT") || (seg[4] === "responses" && method === "POST"))) {
      if (!participantWrites) return notFound();
      let credentialId: string;
      try { credentialId = decodeURIComponent(seg[3]!); } catch { return neutral(); }
      if (!isCredentialId(credentialId)) return neutral(); // before the body is read or any lookup
      let outcome: WriteOutcome;
      if (seg[4] === "self-ratings") {
        const body = parse(SelfRatingsBody, await jsonBody(req, MAX_SELF_RATINGS_BODY_BYTES));
        outcome = await participantWrites.rate(id, credentialId, body.ratings.map((r) => ({ criterion: r.criterion, level: r.level, ...(r.note !== undefined ? { note: r.note } : {}) })));
      } else {
        const body = parse(ResponseBody, await jsonBody(req, MAX_RESPONSE_BODY_BYTES));
        outcome = await participantWrites.respond(id, credentialId, {
          text: body.text, ...(body.criterion !== undefined ? { criterion: body.criterion } : {}), ...(body.dispute !== undefined ? { dispute: body.dispute } : {}),
        });
      }
      if (outcome.status === 200) return ok(res, { wrote: outcome.wrote });
      if (outcome.status === 404) return neutral();
      return fail(res, outcome.status, outcome.code, outcome.message, false, outcome.retryAfterMs !== undefined ? Math.max(1, Math.ceil(outcome.retryAfterMs / 1000)) : undefined);
    }
    if (seg[2] === "report-links" && seg.length <= 5) {
      if (!reports) return notFound();
      let role: string | undefined;
      if (seg.length >= 4) {
        try { role = decodeURIComponent(seg[3]!); } catch { return notFound(); }
        if (!RoleIdSchema.safeParse(role).success) return notFound(); // before the body is read or anything is called
      }
      const exists = (): void => { if (!supervisor.get(id)) throw new HttpError(404, "not_found", "That session does not exist."); };
      if (seg.length === 3 && method === "GET") { exists(); return ok(res, await reports.links(id)); }
      if (seg.length === 3 && method === "POST") {
        const body = parse(LinkBody, await jsonBody(req));
        if (!RoleIdSchema.safeParse(body.role).success) throw new HttpError(400, "bad_request", BAD_REQUEST);
        exists();
        return ok(res, await reports.issue(id, body.role));
      }
      if (seg.length === 5 && seg[4] === "reissue" && method === "POST") {
        parse(NoBody, (await jsonBody(req)) ?? {});
        exists();
        return ok(res, await reports.reissue(id, role!));
      }
      if (seg.length === 4 && method === "DELETE") {
        parse(NoBody, (await jsonBody(req)) ?? {});
        // No session check: a link must stay revocable after its session is gone from the list (the store validates both ids).
        return ok(res, { revoked: await reports.revoke(id, role!) });
      }
      return notFound();
    }
    if (seg.length === 4 && seg[2] === "codes" && seg[3] === "reissue" && method === "POST") {
      const body = parse(ReissueBody, (await jsonBody(req)) ?? {});
      if (body.roleId !== undefined) return ok(res, { code: await supervisor.reissue(id, body.roleId, body.by, body.reason) });
      return ok(res, { codes: await supervisor.reissueAll(id, body.by) });
    }
    if (await handleReportRoute(seg, method, req, res, { sessionId: id, knows: (sid) => supervisor.get(sid) !== undefined, jobs, moderation })) return;
    return notFound();
  }

  return (req, res) => {
    void (async () => {
      try {
        if (!tokenOk(req.headers["x-service-token"], config.serviceToken)) {
          fail(res, 401, "unauthorized", UNAUTHORIZED, true);
          req.resume();
          return;
        }
        await route(req, res);
      } catch (err) {
        if (err instanceof HttpError) { fail(res, err.status, err.code, err.message, err.closeConnection); return; }
        if (err instanceof ControlError && err.code in STATUS) { fail(res, STATUS[err.code], err.code, err.message); return; }
        log(`request failed (${errorName(err)})`);
        fail(res, 500, "internal", INTERNAL);
      }
    })();
  };
}
