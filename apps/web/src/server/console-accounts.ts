import { fail, ok } from "./envelope";
import type { ConsoleCaller } from "./console-handlers";
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
 * else is `invalid`. Control keeps the owner through stop, restart, resume and end. After a recorded change every open console stream of
 * the session is ended (they reconnect through the stream route's ownership check).
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
    // The heartbeat re-checks only the account, never ownership: end the session's open streams now, so a previous owner stops
    // receiving the live view; their reconnect meets the stream route's ownership check. The owner is already recorded, so a throw
    // here must not turn the answer into an error.
    try {
      deps.facilitatorHub.closeSession(id);
    } catch {
      console.error("web: console: the session's open streams could not be ended after an owner change");
    }
    return ok({ sessionId: info.sessionId, owner: info.owner ?? null });
  } catch (err) {
    if (err instanceof LauncherError && err.reason === "not_found") return notFound();
    return failure(err);
  }
}

// ---- admin account routes (US-0083 Task 7) ----

const MAX_FIELD_CHARS = 200;
const MAX_ADMIN_BODY_BYTES = 1024;

const forbiddenAnswer = () => fail(403, "forbidden", "This request was refused.");
const accountNotFound = () => fail(404, "not_found", "That account was not found.");

/** Admin ACCOUNTS only: a facilitator is refused by the guard, a legacy (shared secret) sign-in here. */
async function adminGuard(req: Request, deps: Deps, change: boolean): Promise<{ who: ConsoleCaller } | { response: Response }> {
  const g = await guard(req, deps, change, { adminOnly: true });
  if ("response" in g) return g;
  if (g.who.legacy || g.who.accountId === null) return { response: forbiddenAnswer() };
  return g;
}

/** The account's answer to a failed control call: our own text, never control's. */
function accountFailure(err: unknown, context: "create" | "revoke" | "other"): Response {
  if (err instanceof LauncherError) {
    switch (err.reason) {
      case "not_found":
        return accountNotFound();
      case "conflict":
        return fail(409, "conflict",
          context === "create" ? "An account with that login already exists."
            : context === "revoke" ? "That account cannot be revoked: it is the last active admin."
              : "That action is not possible for this account.");
      case "state":
        return fail(409, "conflict", "That action is not possible for the account in its current state.");
      case "invalid":
      case "bad_request":
        return fail(400, "invalid", "Check the login, name and role and try again.");
      default:
        return failure(err);
    }
  }
  return failure(err);
}

const field = (v: unknown): v is string => typeof v === "string" && v.trim().length >= 1 && v.length <= MAX_FIELD_CHARS;

/** GET /api/v1/console/admin/accounts: every account, never a password. */
export async function handleAdminAccountsList(req: Request, deps: Deps): Promise<Response> {
  const g = await adminGuard(req, deps, false);
  if ("response" in g) return g.response;
  if (!deps.launcher) return unreachable();
  try {
    return ok({ accounts: await deps.launcher.accountsList() });
  } catch (err) {
    return accountFailure(err, "other");
  }
}

/** POST /api/v1/console/admin/accounts { login, name, role }: `by` is the caller's account id; a `by` in the body is accepted and ignored. */
export async function handleAdminAccountCreate(req: Request, deps: Deps): Promise<Response> {
  const g = await adminGuard(req, deps, true);
  if ("response" in g) return g.response;
  const body = await readBody(req, ["login", "name", "role", "by"], MAX_ADMIN_BODY_BYTES);
  if (body === null || !field(body.login) || !field(body.name) || (body.role !== "admin" && body.role !== "facilitator")) return badRequest();
  if (!deps.launcher) return unreachable();
  try {
    return ok(await deps.launcher.accountCreate({ login: body.login, name: body.name, role: body.role, by: g.who.accountId! }));
  } catch (err) {
    return accountFailure(err, "create");
  }
}

/** The target id of /admin/accounts/:id/<action>, only when it is 1 to 64 characters without a control character. */
function targetIdOf(req: Request): string | null {
  const parts = new URL(req.url).pathname.split("/");
  const at = parts.lastIndexOf("accounts");
  const raw = at >= 0 ? parts[at + 1] : undefined;
  if (raw === undefined) return null;
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return id.length >= 1 && id.length <= MAX_ACCOUNT_ID_CHARS && [...id].every((c) => c.charCodeAt(0) > 0x1f && c.charCodeAt(0) !== 0x7f) ? id : null;
}

/**
 * POST /api/v1/console/admin/accounts/:id/{resend,reset,revoke,reinstate}. Reset, revoke and reinstate end the target's open console
 * streams afterwards (the change is already recorded, so a throw there does not turn the answer into an error); resend leaves them (the
 * epoch bump already fails an old cookie on its next request). The one-time temporary password is in the answer only, never logged.
 */
export function handleAdminAccountAction(action: "resend" | "reset" | "revoke" | "reinstate"): (req: Request, deps: Deps) => Promise<Response> {
  return async (req, deps) => {
    const g = await adminGuard(req, deps, true);
    if ("response" in g) return g.response;
    const id = targetIdOf(req);
    if (id === null) return accountNotFound();
    const body = await readBody(req, [], MAX_ADMIN_BODY_BYTES);
    if (body === null) return badRequest();
    if (!deps.launcher) return unreachable();
    try {
      const out = await deps.launcher.accountAction(id, action);
      if (action !== "resend") {
        try {
          deps.facilitatorHub.closeAccount(id);
        } catch {
          console.error("web: console: the account's open streams could not be ended");
        }
      }
      return ok(out);
    } catch (err) {
      return accountFailure(err, action === "revoke" ? "revoke" : "other");
    }
  };
}
