import {
  CLIENT_ID_MAX_CHARS,
  isScenarioId,
  isValidSessionId,
} from "@acr/events";
import { requireConsole } from "./console-handlers";
import type { ConsoleSession } from "./console-session";
import { fail, ok } from "./envelope";
import {
  FacilitatorSocketError,
  withFacilitatorSocket,
} from "./facilitator-socket";
import { checkFetchSite, checkOrigin } from "./guards";
import type { Deps } from "./handlers";
import { LauncherError, type SessionInfo } from "./launcher-client";
import { realTimer } from "./runtime-connection";
import type { FacilitatorRosterEntry, SessionStatus } from "./wire";

// The facilitator console's session API: plain Request -> Response, no Next imports (routes.ts wires them). Every handler calls
// requireConsole first; state changes then check Origin, the custom header and Fetch-Metadata exactly as the player POSTs do. The
// facilitator's name comes only from the sealed cookie. The launcher's text, ports, tokens and URLs never reach a browser, and join
// codes appear only in the responses that create them. Log lines are fixed text: no id, name, code, token or URL.

const MAX_BODY_BYTES = 1024;
const MAX_NAME_CODE_POINTS = 60;
const MAX_MISSING = 64;
const START_TIMEOUT_MS = 10_000;

const UNREACHABLE = "The session service is not reachable. Try again.";
const CONFLICT = "That action is not possible in the session's current state.";

const forbidden = () => fail(403, "forbidden", "This request was refused.");
const badRequest = () =>
  fail(400, "bad_request", "The request could not be read.");
const notFound = () => fail(404, "not_found", "That session was not found.");
const unreachable = () => fail(502, "launcher_unavailable", UNREACHABLE);
const log = (line: string) => console.error(`web: console: ${line}`);

// ---- guards ----

/** requireConsole first; for a state change, then Origin + custom header + Fetch-Metadata (the player POSTs' checks). */
function guard(
  req: Request,
  deps: Deps,
  change: boolean,
): { who: ConsoleSession } | { response: Response } {
  const who = requireConsole(req, deps);
  if (who instanceof Response) return { response: who };
  if (
    change &&
    (!checkOrigin(req, deps.config.publicOrigin) || !checkFetchSite(req))
  )
    return { response: forbidden() };
  return { who };
}

/** The segment after /sessions/, kept only when it is a valid session id (so nothing path-like reaches the launcher). */
function sessionIdOf(req: Request): string | null {
  const parts = new URL(req.url).pathname.split("/");
  const at = parts.indexOf("sessions");
  const id = at >= 0 ? parts[at + 1] : undefined;
  return id !== undefined && isValidSessionId(id) ? id : null;
}

const isId = (v: unknown): v is string =>
  typeof v === "string" && v.length <= CLIENT_ID_MAX_CHARS && isScenarioId(v);

/** A JSON object of at most 1 KiB whose keys are all in `allowed`; an empty body is `{}`. Null for anything else. */
async function readBody(
  req: Request,
  allowed: readonly string[],
): Promise<Record<string, unknown> | null> {
  let text = "";
  if (req.body) {
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
    } catch {
      return null;
    }
    text = Buffer.concat(chunks).toString("utf8");
  }
  if (text.trim() === "") return {};
  const type = (req.headers.get("Content-Type") ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  if (type !== "application/json") return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  return Object.keys(v).every((k) => allowed.includes(k))
    ? (v as Record<string, unknown>)
    : null;
}

// ---- failures ----

/** The one place a launcher or socket failure becomes an answer: our own text, never the launcher's. */
function failure(err: unknown): Response {
  if (err instanceof LauncherError) {
    switch (err.reason) {
      case "not_found":
        return notFound();
      case "conflict":
        return fail(409, "conflict", CONFLICT);
      case "capacity":
        return fail(
          429,
          "capacity",
          "The maximum number of sessions is running.",
        );
      case "bad_request":
        return badRequest();
      case "unauthorized":
        log("the session service refused our credentials");
        return unreachable();
      default:
        log("the session service is not reachable");
        return unreachable();
    }
  }
  if (err instanceof FacilitatorSocketError) {
    log(
      err.reason === "unauthorized"
        ? "the session runtime refused the facilitator login"
        : "the session runtime is not reachable",
    );
    return unreachable();
  }
  log("request failed");
  return unreachable();
}

// ---- shapes ----

const listed = (s: SessionInfo) => ({
  sessionId: s.sessionId,
  scenarioId: s.scenarioId,
  status: s.status,
  ...(s.modelLabel !== undefined && { modelLabel: s.modelLabel }),
});

const cap = (name: string) => [...name].slice(0, MAX_NAME_CODE_POINTS).join("");
const entryOf = (e: FacilitatorRosterEntry): FacilitatorRosterEntry => ({
  roleId: e.roleId,
  ...(typeof e.name === "string" && { name: cap(e.name) }),
  joined: e.joined === true,
  consented: e.consented === true,
  connected: e.connected === true,
});
const notReady = (roster: FacilitatorRosterEntry[]) =>
  roster.filter((e) => !(e.joined && e.consented)).map((e) => e.roleId);

// ---- reads ----

/** GET /api/v1/console/scenarios */
export async function handleConsoleScenarios(
  req: Request,
  deps: Deps,
): Promise<Response> {
  const g = guard(req, deps, false);
  if ("response" in g) return g.response;
  if (!deps.launcher) return unreachable();
  try {
    return ok(
      (await deps.launcher.scenarios()).map((s) => ({
        id: s.id,
        title: s.title,
      })),
    );
  } catch (err) {
    return failure(err);
  }
}

/** GET /api/v1/console/sessions */
export async function handleConsoleSessionsList(
  req: Request,
  deps: Deps,
): Promise<Response> {
  const g = guard(req, deps, false);
  if ("response" in g) return g.response;
  if (!deps.launcher) return unreachable();
  try {
    return ok((await deps.launcher.sessions()).map(listed));
  } catch (err) {
    return failure(err);
  }
}

/** GET /api/v1/console/sessions/:id (never any code) */
export async function handleConsoleSessionGet(
  req: Request,
  deps: Deps,
): Promise<Response> {
  const g = guard(req, deps, false);
  if ("response" in g) return g.response;
  const id = sessionIdOf(req);
  if (id === null) return notFound();
  if (!deps.launcher) return unreachable();
  try {
    return ok(listed(await deps.launcher.session(id)));
  } catch (err) {
    return failure(err);
  }
}

/**
 * GET /api/v1/console/sessions/:id/readiness. A running session is asked over one short-lived facilitator socket; a stopped or ended one
 * is not (no socket, empty roster). `status` is the runtime's own state, null when the runtime was not asked or could not be reached.
 * `canStart` only explains the button: the runtime stays the authority.
 */
export async function handleConsoleReadiness(
  req: Request,
  deps: Deps,
): Promise<Response> {
  const g = guard(req, deps, false);
  if ("response" in g) return g.response;
  const id = sessionIdOf(req);
  if (id === null) return notFound();
  if (!deps.launcher) return unreachable();
  let info: SessionInfo;
  try {
    info = await deps.launcher.session(id);
  } catch (err) {
    return failure(err);
  }
  const base = {
    launcherStatus: info.status,
    modelLabel: info.modelLabel ?? null,
  };
  const unknown = {
    ...base,
    status: null,
    roster: [] as FacilitatorRosterEntry[],
    canStart: false,
    missing: [] as string[],
  };
  if (info.status !== "running") return ok(unknown);
  let joined: { roster: FacilitatorRosterEntry[]; status: SessionStatus };
  try {
    joined = await withFacilitatorSocket(deps, id, async (_conn, j) => j);
  } catch (err) {
    if (err instanceof FacilitatorSocketError) {
      log("the session runtime is not reachable");
      return ok(unknown);
    }
    return failure(err);
  }
  const roster = joined.roster.map(entryOf);
  const missing = notReady(roster);
  return ok({
    ...base,
    status: joined.status,
    roster,
    canStart:
      joined.status === "idle" && roster.length > 0 && missing.length === 0,
    missing,
  });
}

// ---- state changes ----

/** POST /api/v1/console/sessions { scenarioId } */
export async function handleConsoleSessionsCreate(
  req: Request,
  deps: Deps,
): Promise<Response> {
  const g = guard(req, deps, true);
  if ("response" in g) return g.response;
  const body = await readBody(req, ["scenarioId"]);
  if (body === null || !isId(body.scenarioId)) return badRequest();
  if (!deps.launcher) return unreachable();
  try {
    const c = await deps.launcher.createSession(body.scenarioId);
    return ok({
      sessionId: c.sessionId,
      modelLabel: c.modelLabel,
      codes: c.codes.map((x) => ({ roleId: x.roleId, code: x.code })),
    });
  } catch (err) {
    return failure(err);
  }
}

/** POST /api/v1/console/sessions/:id/reissue { roleId }: the new code, once. `by` is the cookie's name. */
export async function handleConsoleReissue(
  req: Request,
  deps: Deps,
): Promise<Response> {
  const g = guard(req, deps, true);
  if ("response" in g) return g.response;
  const id = sessionIdOf(req);
  if (id === null) return notFound();
  const body = await readBody(req, ["roleId"]);
  if (body === null || !isId(body.roleId)) return badRequest();
  if (!deps.launcher) return unreachable();
  try {
    return ok({
      roleId: body.roleId,
      code: await deps.launcher.reissue(id, body.roleId, g.who.name),
    });
  } catch (err) {
    return failure(err);
  }
}

/** POST /api/v1/console/sessions/:id/reissue-all {}: every role's new code, once (the launcher refuses it after the start). */
export async function handleConsoleReissueAll(
  req: Request,
  deps: Deps,
): Promise<Response> {
  const g = guard(req, deps, true);
  if ("response" in g) return g.response;
  const id = sessionIdOf(req);
  if (id === null) return notFound();
  const body = await readBody(req, []);
  if (body === null) return badRequest();
  if (!deps.launcher) return unreachable();
  try {
    return ok({
      codes: (await deps.launcher.reissueAll(id, g.who.name)).map((x) => ({
        roleId: x.roleId,
        code: x.code,
      })),
    });
  } catch (err) {
    return failure(err);
  }
}

/** POST /api/v1/console/sessions/:id/restart {} */
export async function handleConsoleRestart(
  req: Request,
  deps: Deps,
): Promise<Response> {
  const g = guard(req, deps, true);
  if ("response" in g) return g.response;
  const id = sessionIdOf(req);
  if (id === null) return notFound();
  const body = await readBody(req, []);
  if (body === null) return badRequest();
  if (!deps.launcher) return unreachable();
  try {
    const r = await deps.launcher.restart(id);
    return ok({
      sessionId: r.sessionId,
      launcherStatus: r.status,
      modelLabel: r.modelLabel ?? null,
      ...(r.codes !== undefined && {
        codes: r.codes.map((x) => ({ roleId: x.roleId, code: x.code })),
      }),
    });
  } catch (err) {
    return failure(err);
  }
}

type StartOutcome =
  | { kind: "started" }
  | {
      kind: "refused";
      code: string;
      message: string;
      roster: FacilitatorRosterEntry[];
    }
  | { kind: "timeout" }
  | { kind: "closed" };

/** The role ids a `seats_not_ready: a,b` message names; only well-formed ids are kept, and only a few. */
function rolesIn(message: string): string[] {
  const m = /^seats_not_ready:\s*(.*)$/s.exec(message);
  if (!m) return [];
  return m[1]!
    .split(",")
    .map((s) => s.trim())
    .filter(isId)
    .slice(0, MAX_MISSING);
}

/** POST /api/v1/console/sessions/:id/start {}: sends `start` and waits (bounded) for session.started or the runtime's refusal. */
export async function handleConsoleStart(
  req: Request,
  deps: Deps,
): Promise<Response> {
  const g = guard(req, deps, true);
  if ("response" in g) return g.response;
  const id = sessionIdOf(req);
  if (id === null) return notFound();
  const body = await readBody(req, []);
  if (body === null) return badRequest();
  if (!deps.launcher) return unreachable();
  const setTimer = deps.setTimer ?? realTimer;
  let outcome: StartOutcome;
  try {
    outcome = await withFacilitatorSocket(
      deps,
      id,
      (conn, joined) =>
        new Promise<StartOutcome>((resolve) => {
          let cancel: () => void = () => {};
          let off: () => void = () => {};
          let offClose: () => void = () => {};
          let done = false;
          const finish = (o: StartOutcome) => {
            if (done) return;
            done = true;
            cancel();
            off();
            offClose();
            resolve(o);
          };
          // Listeners before the send, so no answer can be missed.
          off = conn.onFrame((m) => {
            if (m.type === "event" && m.event.type === "session.started")
              finish({ kind: "started" });
            else if (m.type === "error")
              finish({
                kind: "refused",
                code: m.code,
                message: m.message,
                roster: joined.roster,
              });
          });
          offClose = conn.onClose(() => finish({ kind: "closed" }));
          cancel = setTimer(
            () => finish({ kind: "timeout" }),
            START_TIMEOUT_MS,
          );
          if (done) {
            cancel();
            offClose();
            return;
          }
          try {
            conn.send({ type: "start" });
          } catch {
            finish({ kind: "closed" });
          }
        }),
    );
  } catch (err) {
    return failure(err);
  }

  switch (outcome.kind) {
    case "started":
      return ok({ started: true });
    case "timeout":
      return fail(
        504,
        "start_timeout",
        "The session did not confirm the start. Check the lobby, then try again.",
      );
    case "closed":
      log("the session runtime closed before answering");
      return unreachable();
    case "refused": {
      if (outcome.code === "seats_not_ready") {
        const parsed = rolesIn(outcome.message);
        const missing =
          parsed.length > 0
            ? parsed
            : notReady(outcome.roster.map(entryOf)).slice(0, MAX_MISSING);
        return fail(
          409,
          "conflict",
          "Not everyone has joined and consented yet.",
          undefined,
          { started: false, reason: "seats_not_ready", missing },
        );
      }
      if (outcome.code === "already_started")
        return fail(409, "conflict", "The session has already started.");
      log("the session runtime refused the start");
      return unreachable();
    }
  }
}
