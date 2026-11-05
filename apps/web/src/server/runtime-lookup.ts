import type { Deps } from "./handlers";
import { LauncherError } from "./launcher-client";

/**
 * The runtime URL a player's socket for `sessionId` goes to. Launcher mode asks the control service: a `running` session with a port
 * is `ws://127.0.0.1:<port>`, anything else (stopped, ended, unknown) is null. Single mode returns RUNTIME_URL for any id, as before.
 * A launcher failure other than "unknown session" propagates: the caller answers "unavailable", never a refusal about the player.
 */
export async function resolveRuntimeUrl(
  deps: Deps,
  sessionId: string,
): Promise<string | null> {
  const launcher = deps.launcher;
  if (!launcher) return deps.config.runtimeUrl;
  try {
    const info = await launcher.session(sessionId);
    return info.sessionId === sessionId &&
      info.status === "running" &&
      info.port !== undefined
      ? `ws://127.0.0.1:${info.port}`
      : null;
  } catch (err) {
    if (err instanceof LauncherError && err.reason === "not_found") return null;
    throw err;
  }
}
