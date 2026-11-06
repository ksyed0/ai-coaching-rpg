/** `@acr/runtime/run-summary`: what a run says about the AI characters, alerts and Game Master scene ends. Shared by the demo and the control service. */
export { ALERT_CHARS, alertsForReply, collectRunSummary, sanitizeAlert } from "./evidence.js";
export type { AlertEvidence, CharacterEvidence, RunSummary } from "./evidence.js";
export { evaluationCallBound } from "./bound.js";
export { evaluationCallBoundFromLog, runSummaryFromLog } from "./log.js";
