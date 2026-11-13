import { fail, ok } from "./envelope";
import { failure, guard, readBody, sessionIdOf } from "./console-sessions";
import type { Deps } from "./handlers";
import { LauncherError } from "./launcher-client";

// US-0083: the console's account administration. Plain Request -> Response (routes.ts wires them). Admins only: an admin account or,
// while control's legacy latch is open, a legacy (shared secret) sign-in; requireConsole (inside `guard`) already refuses an account that
// must change its password. Nothing here logs an id, a name or a body.

const MAX_ACCOUNT_ID_CHARS = 64;

const badRequest = () => fail(400, "bad_request", "The request could not be read.");
const notFound = () => fail(404, "not_found", "That session was not found.");
const invalid = () => fail(400, "invalid", "That account cannot own sessions. Choose an active or invited account.");
const unreachable = () => fail(502, "launcher_unavailable", "The session service is not reachable. Try again.");

const isOwner = (v: unknown): v is string | null =>
  v === null || (typeof v === "string" && v.length >= 1 && v.length <= MAX_ACCOUNT_ID_CHARS);

/**
 * POST /api/v1/console/sessions/:id/owner { owner: string | null }: assigns the session to an account, or with null leaves it to admins.
 * A facilitator is refused 403 for every session (before its id is looked at, so the answer says nothing about the session). The owner
 * must be a known account that is not revoked (checked against control's account list: control records any id it is given); anything
 * else is `invalid`. Control keeps the owner through stop, restart, resume and end.
 */
export async function handleConsoleSetOwner(req: Request, deps: Deps): Promise<Response> {
  const g = await guard(req, deps, true, { adminOnly: true });
  if ("response" in g) return g.response;
  const id = sessionIdOf(req);
  if (id === null) return notFound();
  const body = await readBody(req, ["owner"]);
  if (body === null || !Object.hasOwn(body, "owner") || !isOwner(body.owner)) return badRequest();
  const owner = body.owner;
  if (!deps.launcher) return unreachable();
  try {
    if (owner !== null) {
      const known = (await deps.launcher.accountsList()).some((a) => a.id === owner && a.status !== "revoked");
      if (!known) return invalid();
    }
    const info = await deps.launcher.setOwner(id, owner);
    return ok({ sessionId: info.sessionId, owner: info.owner ?? null });
  } catch (err) {
    if (err instanceof LauncherError && err.reason === "not_found") return notFound();
    return failure(err);
  }
}
