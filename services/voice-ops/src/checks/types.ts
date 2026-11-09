/** US-0072 (EPIC-0003 voice A1c, Task 8): one result of `voice:check`. `line` is fixed text plus non-secret facts only. */
export type CheckLevel = "ok" | "warn" | "fail" | "skip";
export type CheckResult = { name: string; level: CheckLevel; line: string };
