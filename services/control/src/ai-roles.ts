import path from "node:path";
import { isValidSessionId } from "@acr/events";
import { aiRolesFromLog } from "@acr/runtime/run-summary";
import type { ControlConfig } from "./config.js";
import { scenarioDir } from "./scenarios.js";
import type { SessionList } from "./session-list.js";

/**
 * US-0060: the AI player roles of a session, read from its own log (`<sessionsDir>/<id>.jsonl`) against the scenario folder named by its
 * session-list entry. `null` for anything that cannot be read or is inconsistent: a bad session id, a corrupt or unreadable session list,
 * a session not in the list, a refused scenario folder, or a missing, empty or inconsistent log. Never throws; callers fail closed on `null`.
 */
export async function aiRolesFor(
  config: Pick<ControlConfig, "sessionsDir" | "scenariosDir">,
  list: Pick<SessionList, "read">,
  sessionId: string,
): Promise<string[] | null> {
  try {
    if (typeof sessionId !== "string" || !isValidSessionId(sessionId)) return null;
    const entry = list.read().find((e) => e.sessionId === sessionId);
    if (!entry) return null;
    return await aiRolesFromLog(path.join(config.sessionsDir, `${sessionId}.jsonl`), scenarioDir(config.scenariosDir, entry.scenarioId));
  } catch {
    return null;
  }
}
