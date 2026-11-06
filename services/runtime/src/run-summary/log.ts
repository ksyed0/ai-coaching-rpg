import { loadScenario } from "@acr/script";
import { readSessionLog } from "../evaluator/log-reader.js";
import { collectRunSummary, type RunSummary } from "./evidence.js";

/**
 * The run summary of a recorded session, read the way the evaluator reads a log (bounded, the reducer checks it). `null` when the log or
 * the scenario cannot be read: the caller shows no summary rather than an error text.
 */
export async function runSummaryFromLog(logPath: string, scenarioDir: string, secrets: string[]): Promise<RunSummary | null> {
  try {
    const [events, scenario] = await Promise.all([readSessionLog(logPath), loadScenario(scenarioDir)]);
    return collectRunSummary(events, scenario, { secrets });
  } catch { return null; }
}
