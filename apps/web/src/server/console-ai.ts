import { fail, ok } from "./envelope";
import { failure, guard, isId, readBody, sessionIdOf } from "./console-sessions";
import type { Deps } from "./handlers";
import { UNCONFIRMED } from "./console-ai-copy";
import { LauncherError } from "./launcher-client";

// US-0060: the facilitator console's AI-role routes. Same pipeline as the other console state changes: cookie, Origin + custom header +
// Fetch-Metadata, a small body limit, strict validation, and only then the launcher. Every answer is built field by field here; the
// launcher's text is never shown, and a join code is never logged.

export const AI_BODY_MAX_BYTES = 4 * 1024;
const MAX_AI_ROLE_REQUEST = 12;

const badRequest = () => fail(400, "bad_request", "The request could not be read.");
const notFound = () => fail(404, "not_found", "That session was not found.");
const unreachable = () => fail(502, "launcher_unavailable", "The session service is not reachable. Try again.");

/** The roles of a request: at most 12 distinct ids, or null. */
function rolesOf(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > MAX_AI_ROLE_REQUEST) return null;
  if (!v.every(isId)) return null;
  return new Set(v).size === v.length ? (v as string[]) : null;
}

/** POST /api/v1/console/sessions/:id/ai-roles { roles }: the new AI set and the human roles' codes (which a switch may have changed). */
export async function handleConsoleAiRoles(req: Request, deps: Deps): Promise<Response> {
  const g = guard(req, deps, true);
  if ("response" in g) return g.response;
  const id = sessionIdOf(req);
  if (id === null) return notFound();
  const body = await readBody(req, ["roles"], AI_BODY_MAX_BYTES);
  const roles = body === null ? null : rolesOf(body.roles);
  if (roles === null) return badRequest();
  if (!deps.launcher) return unreachable();
  try {
    const r = await deps.launcher.setAiRoles(id, roles);
    const ai = new Set(r.roles);
    return ok({
      roles: r.roles.map((x) => x),
      // An AI role's code never leaves the control service; drop it here even if a launcher sent one.
      codes: r.codes.filter((x) => !ai.has(x.roleId)).map((x) => ({ roleId: x.roleId, code: x.code })),
    });
  } catch (err) {
    if (err instanceof LauncherError && err.reason === "timeout") return fail(504, "ai_roles_unconfirmed", UNCONFIRMED);
    return failure(err);
  }
}

/** POST /api/v1/console/sessions/:id/ai-roles/:roleId/intents {}: a POST, since the Origin check needs headers a plain GET does not carry. */
export async function handleConsoleAiIntents(req: Request, deps: Deps): Promise<Response> {
  const g = guard(req, deps, true);
  if ("response" in g) return g.response;
  const id = sessionIdOf(req);
  if (id === null) return notFound();
  const roleId = roleIdOf(req);
  if (roleId === null) return notFound();
  const body = await readBody(req, [], AI_BODY_MAX_BYTES);
  if (body === null) return badRequest();
  if (!deps.launcher) return unreachable();
  try {
    const entries = await deps.launcher.intents(id, roleId);
    return ok({
      entries: entries.map((e) => ({
        ts: e.ts,
        sceneId: e.sceneId,
        trigger: e.trigger,
        outcome: e.outcome,
        ...(e.reason !== undefined && { reason: e.reason }),
        ...(e.hint !== undefined && { hint: e.hint }),
      })),
    });
  } catch (err) {
    return failure(err);
  }
}

/** The segment after /ai-roles/, decoded, kept only when it is an id. */
function roleIdOf(req: Request): string | null {
  const parts = new URL(req.url).pathname.split("/");
  const at = parts.indexOf("ai-roles");
  const raw = at >= 0 ? parts[at + 1] : undefined;
  if (raw === undefined) return null;
  let v: string;
  try {
    v = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return isId(v) ? v : null;
}
