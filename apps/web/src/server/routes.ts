import { loadConfig, missingConsoleVars } from "./config";
import { handleConsoleLogin, handleConsoleLogout } from "./console-handlers";
import { consoleSessionFromToken } from "./console-session";
import { fail } from "./envelope";
import { handleConsent, handleJoin, handleLeave, handleSay, handleStream, seatedIn, type Deps } from "./handlers";
import { LauncherClient } from "./launcher-client";
import { RuntimeConnection, realTimer } from "./runtime-connection";
import { StreamHub } from "./stream-hub";
import { JoinThrottle } from "./throttle";

// Wires the handlers to one shared set of dependencies for the Next route files. The stream route and the say route must see the SAME
// hub (say goes over the stream's connection), so the set lives on globalThis: route bundles and dev reloads can load this module twice.

/** The failed-join throttle, matching the runtime's: more than 5 failures in 60 s block that (address, role) for 60 s. */
const JOIN_THROTTLE = { max: 5, windowMs: 60_000, blockMs: 60_000 };

export function createDeps(env: Record<string, string | undefined>): Deps {
  const config = loadConfig(env);
  const now = () => Date.now();
  const missing = missingConsoleVars(config);
  // Names only, never values. A player-only deployment sets none of them, which is fine, but it is said once, loudly.
  if (missing.length > 0) console.warn(`web: the facilitator console is DISABLED; unset: ${missing.join(", ")}`);
  return {
    config, now, connect: RuntimeConnection.connect,
    joinThrottle: new JoinThrottle({ ...JOIN_THROTTLE, now }),
    // The console login throttle: the same 5 failures per 60 s and 60 s block, keyed by address.
    consoleThrottle: new JoinThrottle({ ...JOIN_THROTTLE, now }),
    hub: new StreamHub({ maxStreams: config.maxStreams, maxStreamsPerSession: config.maxStreamsPerSession, maxStreamsPerAddress: config.maxStreamsPerAddress, setTimer: realTimer, now }),
    // loadConfig guarantees the token whenever the URL is set.
    ...(config.launcherUrl !== undefined && config.launcherToken !== undefined && { launcher: new LauncherClient({ baseUrl: config.launcherUrl, token: config.launcherToken }) }),
  };
}

const SHARED = Symbol.for("scenecoach.web.deps");
function sharedDeps(): Deps {
  const g = globalThis as { [SHARED]?: Deps };
  // A configuration error throws every time (nothing cached), so fixing the environment and restarting is enough.
  return (g[SHARED] ??= createDeps(process.env));
}

/** For the /join page (server side only): whether this cookie value holds a seat in `sessionId`. False on a configuration error. */
export function hasSeat(token: string | undefined, sessionId: string, getDeps: () => Deps = sharedDeps): boolean {
  try {
    const d = getDeps();
    return seatedIn(token, sessionId, d.config.cookieKeys, d.now());
  } catch {
    return false;
  }
}

/** For the /console page (server side only): the console's state for this cookie value. A configuration error reads as disabled. */
export type ConsoleView = { kind: "disabled" } | { kind: "signed_out" } | { kind: "signed_in"; name: string };
export function consoleView(token: string | undefined, getDeps: () => Deps = sharedDeps): ConsoleView {
  try {
    const d = getDeps();
    if (missingConsoleVars(d.config).length > 0) return { kind: "disabled" };
    const s = consoleSessionFromToken(token, d.config, d.now());
    return s ? { kind: "signed_in", name: s.name } : { kind: "signed_out" };
  } catch {
    return { kind: "disabled" };
  }
}

type Handler = (req: Request, deps: Deps) => Promise<Response>;

/** A route function: a configuration error or an unexpected throw becomes a 500 envelope; only the error's rule or name is logged. */
export function route(handler: Handler, getDeps: () => Deps = sharedDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    let deps: Deps;
    try { deps = getDeps(); }
    catch (err) {
      // loadConfig's message names variables and rules, never a value.
      console.error(`web: ${err instanceof Error ? err.message : "configuration error"}`);
      return fail(500, "internal", "The server is not configured correctly.");
    }
    try { return await handler(req, deps); }
    catch (err) {
      console.error(`web: request failed: ${err instanceof Error ? err.name : "error"}`);
      return fail(500, "internal", "Something went wrong. Try again.");
    }
  };
}

export const joinPOST = route(handleJoin);
export const streamGET = route(handleStream);
export const sayPOST = route(handleSay);
export const consentPOST = route(handleConsent);
export const leavePOST = route(handleLeave);
export const consoleLoginPOST = route(handleConsoleLogin);
export const consoleLogoutPOST = route(handleConsoleLogout);
