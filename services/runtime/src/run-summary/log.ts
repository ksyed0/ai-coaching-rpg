import { loadRubrics, loadScenario } from "@acr/script";
import { readSessionLog } from "../evaluator/log-reader.js";
import { evaluationCallBound } from "./bound.js";
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

/**
 * The evaluation call bound of a recorded session (`evaluationCallBound` with the scenario's loaded rubrics), read the way the evaluator
 * reads its input. `null` when the log, the scenario or its rubrics cannot be read or are invalid (the evaluator would refuse them too).
 */
export async function evaluationCallBoundFromLog(logPath: string, scenarioDir: string): Promise<number | null> {
  try {
    const [events, scenario] = await Promise.all([readSessionLog(logPath), loadScenario(scenarioDir)]);
    const loaded = await loadRubrics(scenarioDir, scenario);
    if (loaded.errors.length > 0) return null;
    return evaluationCallBound(events, scenario, loaded.rubrics);
  } catch { return null; }
}
