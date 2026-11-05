# Evaluator Calibration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the post-session evaluator's scores measurable with per-scenario calibration probes and a standalone `pnpm calibrate`, improve it only if the baseline says it needs improving, and stamp every report with the calibration behind it.

**Architecture:** Probes are YAML data in each scenario's `calibration/` directory. A new `services/runtime/src/calibration/` module loads and validates them, turns each probe into a synthetic session log, runs the existing `evaluateSession` unchanged against one or two configurable judges, and computes pure metrics (agreement, bias, discrimination, usability, stability, cross-judge differences) written as a Markdown and JSON report. Prompt variants and the report stamp are added behind the evaluator's existing `EvalConfig` and `EvaluatorInfo`.

**Tech Stack:** TypeScript (ESM, NodeNext, `.js` import suffixes), zod, `yaml`, vitest, `node:util` `parseArgs`, `@acr/events`, `@acr/script`, `@acr/adapters`.

**Spec:** `docs/superpowers/specs/2026-10-07-evaluator-calibration-design.md` (read it first; this plan implements it).

## Global Constraints

- ESM with `.js` suffixes on relative imports; workspace imports `@acr/events`, `@acr/script`, `@acr/adapters`; Node 22; pnpm; vitest with explicit imports (no globals).
- Only `packages/adapters` may import a provider SDK (`pnpm lint:sdk`); calibration reaches models only through `ModelProvider`.
- The id-rules guard (`services/runtime/src/__tests__/id-rules.files.test.ts`) scans every non-test `.ts` file: never spell a character class containing `a-z` and `0-9` and `_` (or `\w` and `-`), never write a quoted `"__proto__"`, `"constructor"` or `"prototype"` literal. Use `isFileSafeId`, `isSafeId`, `isScenarioId`, `isPrototypeKey` from `@acr/events`. Test files under `__tests__` are exempt.
- The test-hygiene test forbids asserting a measured elapsed time and listing `os.tmpdir()` directly: `mkdtemp(path.join(os.tmpdir(), "acr-cal-"))` and remove it in `afterEach`.
- No async function where a synchronous check or callback is expected (L-0012). An abort or timeout waits for the work it cancelled (L-0014).
- Every message written to stdout or stderr goes through `scrubText(msg, secretValues(env))`; reports are written with the existing exclusive-create convention (`wx`, file mode `0o600`, directory mode `0o700`).
- Calibration output lives under `data/calibration/` and is git-ignored. Probes may contain only demo or synthetic transcripts (public repository).
- Commit format `[type] US-00NN: imperative description`; attribution trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Never use `pkill`/`killall`; stop only processes you started.
- Gates per story before review: `pnpm typecheck`, `npx eslint .`, `pnpm lint:sdk`, `pnpm test:coverage` (80% on changed code, run twice, once under `yes > /dev/null` x8 that you start and stop by exact PID), `npm run plan:test`, `pnpm demo --fast` (29), `pnpm demo --fast --security --resume` (42), `pnpm demo --showcase --fast` (14), and the new tests in `node:22` as root and `--user node` (AGENTS.md section 8). No live model calls in CI.

## Review Focus

Failure modes the spec implies but no task would otherwise exercise, most likely first. Each has its test in the owning task.

1. **Calibrating against the mock provider.** `MODEL_PROVIDER` defaults to `mock`; a run against it yields only "[mock reply]" and meaningless numbers. Expected: `pnpm calibrate` refuses with a clear message unless real judges are configured (Task 4, Task 8).
2. **A judge that is down or returns garbage mid-run.** Expected: those probes are recorded as unusable (not as disagreement), the other judge still runs, and a partial result file is still written (Task 5, Task 8).
3. **Hostile or malformed probe YAML** (alias bombs, oversized files, `__proto__` keys, ids that are not file-safe, a probe whose subject never speaks twice). Expected: one list of every problem, nothing loaded silently (Task 1).
4. **Judge labels and model ids that become file names** (summary files, report directories). Expected: only safe names are ever used on disk (Task 4, Task 8, Task 13).
5. **A corrupt, stale or missing calibration file when stamping a report.** Expected: the report still renders and says "not calibrated" or "stale", never a crash and never a stale number presented as current (Task 13).
6. **Runaway cost:** `--repeat 50`, a huge probe set, or a variant that doubles calls. Expected: `--repeat` is capped, the run prints the planned call count first, and a long run can be aborted with partial results kept (Task 8).

## File Structure

New, all under `services/runtime/src/calibration/` (tests in `__tests__/`):

| File | Responsibility |
|---|---|
| `probe-schema.ts` | zod schemas and types for probes (`Probe`, `SingleProbe`, `ContrastProbe`, `Level`, `Expected`) |
| `probe-load.ts` | `loadProbes`, `lintProbeSet`, `assignSplit`, the set and criterion minimums |
| `probe-events.ts` | `buildProbeEvents`: probe to synthetic `SessionEvent[]` |
| `types.ts` | `Observed`, `SingleOutcome`, `ContrastOutcome`, `Outcome` |
| `judge.ts` | `Judge`, `parseJudgeSpec`, `modelFamily`, `buildJudge`, `buildPrimaryJudge` |
| `runner.ts` | `runJudge`, `observedOf`: run probes through `evaluateSession` |
| `metrics.ts` | pure metric functions, `Targets`, `labelFor` |
| `compare.ts` | `compareJudges` (blind cross-judge differences) |
| `targets.ts` | `loadTargets` (`calibration/targets.yaml` over the defaults) |
| `rubric-hash.ts` | `rubricHash` |
| `report.ts` | `buildRun`, `renderMarkdown`, `writeRun`, `writeSummary`, `CalibrationSummary` |
| `draft.ts` | `draftProbes`, `approveDraft`, `excerptDraft`, `assignSplits` |
| `stamp.ts` | `lookupCalibration`, `stampLine`, `StampState` |
| `cli.ts`, `main.ts` | `runCalibrate`, `CALIBRATE_USAGE`, the `pnpm calibrate` entry |

Modified: `services/runtime/package.json` and root `package.json` (scripts), `.gitignore`, `services/runtime/src/evaluator/config.ts` and `prompt.ts` (variant, Task 12), `services/runtime/src/evaluator/provider.ts`, `cli.ts`, `report-md.ts`, `report-model.ts` (stamp, Task 13), `docs/EVALUATOR.md`, `docs/RELEASE_PLAN.md`, `docs/TEST_CASES.md`, `docs/ID_REGISTRY.md`, `README.md`, `CHANGELOG.md`. Data: `scenarios/friday-escalation/calibration/*.yaml`.

---

## Task 0: File the stories and reserve ids

**Files:** Modify `docs/RELEASE_PLAN.md`, `docs/ID_REGISTRY.md`; Test: `npm run plan:test`.

Stories (all EPIC-0005, status Planned, branches `feature/EPIC-0005-US-00NN-...`):

| Story | Title | Tasks | ACs | TCs reserved |
|---|---|---|---|---|
| US-0035 | Calibration probe format, validator, log adapter and Friday starter set | TASK-0055 (Tasks 1-3) | AC-0180..AC-0183 | TC-0025..TC-0027 |
| US-0036 | `pnpm calibrate`: judges, runner, metrics, report, second-judge comparison | TASK-0056 (Tasks 4-8) | AC-0184..AC-0188 | TC-0028..TC-0032 |
| US-0037 | Probe drafting, excerpts, approval, and the scaled Friday set | TASK-0057 (Tasks 9-10) | AC-0189..AC-0191 | TC-0033..TC-0035 |
| US-0038 | Evaluator prompt variants and the acceptance report (conditional on the baseline) | TASK-0058 (Task 12) | AC-0192..AC-0194 | TC-0036..TC-0037 |
| US-0039 | Calibration stamp on evaluation reports | TASK-0059 (Task 13) | AC-0195..AC-0197 | TC-0038..TC-0039 |

- [ ] **Step 1: Add the acceptance criteria to the plan** (copy the layout of the US-0034 block: Priority, Estimate, Status, Branch, Dependencies, ACs, plus the TASK block). Use exactly:

  - US-0035: AC-0180 a probe is a validated YAML file (`single` or `contrast`, `source`, `drafter`, `approved_by`, `split`, `acceptable`) in `scenarios/<id>/calibration/`; AC-0181 loading reports every problem in one list (unknown criterion, non-player subject, a scored player with fewer than 2 lines, bad ids, hostile YAML, drafted without approval); AC-0182 a probe becomes a synthetic session log the real evaluator accepts, quote verification included; AC-0183 the Friday scenario ships 8 starter probes (4 discovery levels, 2 negotiation levels, 2 contrast groups) that validate against its rubric, and the linter reports the set as thin.
  - US-0036: AC-0184 judges are configuration (`--judge label,model[,baseUrl]`, primary defaults to the evaluator settings) and a mock provider is refused; AC-0185 the runner feeds each probe to `evaluateSession` unchanged, supports `--repeat` (max 5), `--only`, and records unreachable or garbage judges as unusable; AC-0186 metrics: agreement (exact and within-one as counts), signed bias overall and per expected level, contrast ordering and gap, spread, not-observed precision and recall, usability, stability, split by source, drafter and tune/holdout, with same-family drafter warnings; AC-0187 a blind second-judge comparison lists every disagreement with both judges' levels, rationale and quotes; AC-0188 the report is Markdown plus JSON with a one-screen summary, PASS/WARN/FAIL labels per criterion from `targets.yaml` over documented defaults, `--strict` exits non-zero on FAIL, output is exclusive-create under git-ignored `data/calibration/`, and `pnpm calibrate` never blocks `pnpm evaluate`.
  - US-0037: AC-0189 `--draft-probes` writes candidate probes to `calibration/drafts/` using a drafter of a different model family from the primary judge unless `--allow-same-family`, and a run never reads drafts; AC-0190 `approve` validates a draft, records approver and time, assigns a split, and moves it into `calibration/`; `excerpt` drafts a probe from a real session log range for a human to rate; AC-0191 the Friday set reaches at least 20 approved probes, balanced across levels, with at least 5 real excerpts rated by a human and at least 10 holdout probes.
  - US-0038 (conditional): AC-0192 the evaluator takes a named prompt variant, `v1` is byte-identical to today's prompt, and reports record the variant; AC-0193 `v2` (evidence-first, lower-level tie-break) and `v3` (next-level challenge) exist behind the variant name with the output schema, parser and quote verification unchanged; AC-0194 a variant becomes the default only through a PR carrying the holdout before/after table that meets the spec's acceptance rule.
  - US-0039: AC-0195 every evaluation's JSON and Markdown records the judge, model, prompt variant and rubric hash; AC-0196 a one-line calibration stamp (footer, `index.md`, each personal report) states measured numbers and never claims accuracy, with states not calibrated, stale (rubric hash or variant changed) and thin; AC-0197 a corrupt or missing calibration file never breaks a report.

- [ ] **Step 2: Update the registry.** Edit `docs/ID_REGISTRY.md`: `US` next `US-0040` last `US-0039`; `TASK` next `TASK-0060` last `TASK-0059`; `AC` next `AC-0198` last `AC-0197`; `TC` next `TC-0040` last `TC-0039`; add the line `Reserved blocks (2026-10-07, calibration): AC-0180..AC-0197, TASK-0055..TASK-0059 and TC-0025..TC-0039 US-0035..US-0039. Ids in a block that its story does not use stay unused.`

- [ ] **Step 3: Run `npm run plan:test`** (the registry test must pass) then `npm run plan:generate`.

- [ ] **Step 4: Commit**

```bash
git add docs/RELEASE_PLAN.md docs/ID_REGISTRY.md docs/plan-status.html docs/plan-status.json
git commit -m "[docs] EPIC-0005: file the evaluator calibration stories US-0035..US-0039"
```

---

# Story US-0035: probe format, validator, adapter, starter set

## Task 1: Probe schema, loader, validator, linter, split

**Files:**
- Create: `services/runtime/src/calibration/probe-schema.ts`, `services/runtime/src/calibration/probe-load.ts`
- Test: `services/runtime/src/calibration/__tests__/probe-schema.test.ts`, `services/runtime/src/calibration/__tests__/probe-load.test.ts`

**Interfaces:**
- Produces: `type Level = 1|2|3|4`; `type Expected = Level | "not_observed"`; `ProbeSchema`, `type Probe = SingleProbe | ContrastProbe`; `loadProbes(dir: string, scenario: Scenario, rubrics: Rubric[]): Promise<{ probes: Probe[]; errors: string[]; warnings: string[] }>`; `lintProbeSet(probes: Probe[]): string[]`; `assignSplit(id: string, total: number): "tune" | "holdout"`; constants `MIN_SET_PROBES = 20`, `MIN_CRITERION_PROBES = 4`, `MIN_HOLDOUT_PROBES = 10`, `MAX_PROBE_BYTES = 128 * 1024`; `scoredRoles(p: Probe): string[]`.
- Consumes: `isFileSafeId`, `isScenarioId` (`@acr/events`); `Scenario`, `Rubric`, `readTextCapped` (`@acr/script`); `MIN_UTTERANCES` (`../evaluator/evaluate.js`).

- [ ] **Step 1: Write the failing schema tests** (`probe-schema.test.ts`)

```ts
import { describe, expect, it } from "vitest";
import { ProbeSchema } from "../probe-schema.js";

const line = (role: string, text: string) => ({ scene: "s2_client_call", role, text });
const base = {
  id: "disc-l1", criterion: "discovery", source: "handwritten", split: "tune",
  transcript: [line("client_sponsor", "Can you confirm by Friday?"), line("delivery_lead", "Yes, done.")],
};

describe("ProbeSchema", () => {
  it("accepts a single probe and defaults acceptable/drafter/approval", () => {
    const p = ProbeSchema.parse({ ...base, kind: "single", subject: "delivery_lead", expected: 1 });
    expect(p.kind).toBe("single");
    expect(p.drafter).toBeNull();
    expect(p.approved_by).toBeNull();
  });
  it("accepts a contrast probe with two distinct expected levels", () => {
    const p = ProbeSchema.parse({ ...base, kind: "contrast", players: { delivery_lead: 4, account_manager: 1 }, min_gap: 2 });
    expect(p.kind).toBe("contrast");
  });
  it("rejects a contrast probe whose players share one level", () => {
    expect(() => ProbeSchema.parse({ ...base, kind: "contrast", players: { delivery_lead: 3, account_manager: 3 }, min_gap: 1 })).toThrow();
  });
  it("requires drafter, approver and time on a drafted probe", () => {
    const draft = { ...base, source: "drafted", kind: "single", subject: "delivery_lead", expected: 2 };
    expect(() => ProbeSchema.parse(draft)).toThrow();
    expect(() => ProbeSchema.parse({ ...draft, drafter: "m", approved_by: "kamal", approved_at: "2026-10-08T00:00:00Z" })).not.toThrow();
  });
  it("requires acceptable to include expected", () => {
    expect(() => ProbeSchema.parse({ ...base, kind: "single", subject: "delivery_lead", expected: 4, acceptable: [2, 3] })).toThrow();
  });
  it("rejects unknown keys, a bad id, and a one-line transcript", () => {
    expect(() => ProbeSchema.parse({ ...base, kind: "single", subject: "delivery_lead", expected: 1, extra: 1 })).toThrow();
    expect(() => ProbeSchema.parse({ ...base, id: "../x", kind: "single", subject: "delivery_lead", expected: 1 })).toThrow();
    expect(() => ProbeSchema.parse({ ...base, transcript: [line("delivery_lead", "x")], kind: "single", subject: "delivery_lead", expected: 1 })).toThrow();
  });
  it("accepts not_observed as an expected value", () => {
    expect(ProbeSchema.parse({ ...base, kind: "single", subject: "delivery_lead", expected: "not_observed" }).kind).toBe("single");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @acr/runtime exec vitest run src/calibration/__tests__/probe-schema.test.ts`
Expected: FAIL (module `../probe-schema.js` not found).

- [ ] **Step 3: Implement `probe-schema.ts`**

```ts
import { z } from "zod";
import { isFileSafeId, isScenarioId } from "@acr/events";

export type Level = 1 | 2 | 3 | 4;
export type Expected = Level | "not_observed";

export const LevelSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export const ExpectedSchema = z.union([LevelSchema, z.literal("not_observed")]);

const FileId = z.string().refine(isFileSafeId, "must be 1 to 64 characters of lower-case letters, digits, '_' or '-'");
const RoleId = z.string().max(64).refine(isScenarioId, "must be a scenario id");

export const LineSchema = z.object({ scene: RoleId, role: RoleId, text: z.string().min(1).max(2000) }).strict();

const common = {
  id: FileId,
  criterion: FileId,
  source: z.enum(["handwritten", "drafted", "excerpt"]),
  drafter: z.string().min(1).max(200).nullable().default(null),
  approved_by: z.string().min(1).max(120).nullable().default(null),
  approved_at: z.string().min(1).max(40).nullable().default(null),
  split: z.enum(["tune", "holdout"]),
  transcript: z.array(LineSchema).min(2).max(80),
};

export const SingleProbeSchema = z
  .object({
    kind: z.literal("single"), ...common,
    subject: RoleId, expected: ExpectedSchema,
    acceptable: z.array(ExpectedSchema).min(1).max(5).optional(),
  })
  .strict();

export const ContrastProbeSchema = z
  .object({
    kind: z.literal("contrast"), ...common,
    players: z.record(RoleId, LevelSchema),
    min_gap: z.number().int().min(1).max(3),
  })
  .strict();

export const ProbeSchema = z.discriminatedUnion("kind", [SingleProbeSchema, ContrastProbeSchema]).superRefine((p, ctx) => {
  if (p.source === "drafted" && (p.drafter === null || p.approved_by === null || p.approved_at === null)) {
    ctx.addIssue({ code: "custom", message: "a drafted probe needs drafter, approved_by and approved_at" });
  }
  if (p.kind === "single" && p.acceptable !== undefined && !p.acceptable.includes(p.expected)) {
    ctx.addIssue({ code: "custom", message: "acceptable must include expected" });
  }
  if (p.kind === "contrast") {
    const levels = Object.values(p.players);
    if (levels.length < 2 || new Set(levels).size < 2) {
      ctx.addIssue({ code: "custom", message: "a contrast probe needs at least two players with at least two distinct expected levels" });
    }
  }
});

export type SingleProbe = z.infer<typeof SingleProbeSchema>;
export type ContrastProbe = z.infer<typeof ContrastProbeSchema>;
export type Probe = SingleProbe | ContrastProbe;

/** Roles whose scores the probe checks. */
export function scoredRoles(p: Probe): string[] {
  return p.kind === "single" ? [p.subject] : Object.keys(p.players);
}
```

- [ ] **Step 4: Run to verify it passes** (same command). Expected: PASS, 7 tests.

- [ ] **Step 5: Write the failing loader/linter tests** (`probe-load.test.ts`)

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRubrics, loadScenario } from "@acr/script";
import { assignSplit, lintProbeSet, loadProbes, MIN_SET_PROBES } from "../probe-load.js";
import type { Probe } from "../probe-schema.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const SCEN = path.join(REPO, "scenarios/friday-escalation");
let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "acr-cal-")); await mkdir(path.join(dir, "calibration"), { recursive: true }); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function ctx() {
  const scenario = await loadScenario(SCEN);
  const { rubrics } = await loadRubrics(SCEN, scenario);
  return { scenario, rubrics };
}
const yaml = (o: string) => o.replace(/^\n/, "");
const good = yaml(`
kind: single
id: p1
criterion: discovery
source: handwritten
split: tune
subject: delivery_lead
expected: 1
transcript:
  - { scene: s2_client_call, role: client_sponsor, text: "Can you confirm by Friday?" }
  - { scene: s2_client_call, role: delivery_lead, text: "Yes, we can do that." }
  - { scene: s2_client_call, role: delivery_lead, text: "Consider it done." }
`);

describe("loadProbes", () => {
  it("returns no probes and a warning when there is no calibration directory", async () => {
    const { scenario, rubrics } = await ctx();
    const r = await loadProbes(path.join(dir, "nope"), scenario, rubrics);
    expect(r.probes).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/no calibration directory/);
  });
  it("loads a valid probe", async () => {
    const { scenario, rubrics } = await ctx();
    await writeFile(path.join(dir, "calibration", "p1.yaml"), good);
    const r = await loadProbes(dir, scenario, rubrics);
    expect(r.errors).toEqual([]);
    expect(r.probes.map((p) => p.id)).toEqual(["p1"]);
  });
  it("reports every problem in one list", async () => {
    const { scenario, rubrics } = await ctx();
    await writeFile(path.join(dir, "calibration", "p1.yaml"), good.replace("criterion: discovery", "criterion: nonexistent"));
    await writeFile(path.join(dir, "calibration", "p2.yaml"), good.replace("id: p1", "id: p2").replace("subject: delivery_lead", "subject: client_sponsor"));
    await writeFile(path.join(dir, "calibration", "p3.yaml"), good.replace("id: p1", "id: other"));
    await writeFile(path.join(dir, "calibration", "p4.yaml"), good.replace("id: p1", "id: p4").replace(/ {2}- \{ scene: s2_client_call, role: delivery_lead, text: "Consider it done." \}\n/, ""));
    const r = await loadProbes(dir, scenario, rubrics);
    expect(r.probes).toEqual([]);
    expect(r.errors.join("\n")).toMatch(/p1.yaml.*criterion/s);
    expect(r.errors.join("\n")).toMatch(/p2.yaml.*player/s);
    expect(r.errors.join("\n")).toMatch(/p3.yaml.*id.*file name/s);
    expect(r.errors.join("\n")).toMatch(/p4.yaml.*at least 2/s);
  });
  it("refuses an oversized file, an alias bomb and a prototype key without throwing", async () => {
    const { scenario, rubrics } = await ctx();
    await writeFile(path.join(dir, "calibration", "big.yaml"), "x: " + "a".repeat(200 * 1024));
    await writeFile(path.join(dir, "calibration", "bomb.yaml"), "a: &a [1,1,1,1,1,1,1,1,1,1,1]\n" + Array.from({ length: 30 }, (_, i) => `b${i}: *a`).join("\n"));
    await writeFile(path.join(dir, "calibration", "proto.yaml"), good.replace("id: p1", "id: proto") + "__proto__: { polluted: 1 }\n");
    const r = await loadProbes(dir, scenario, rubrics);
    expect(r.probes).toEqual([]);
    expect(r.errors.length).toBe(3);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it("ignores drafts and targets.yaml", async () => {
    const { scenario, rubrics } = await ctx();
    await mkdir(path.join(dir, "calibration", "drafts"), { recursive: true });
    await writeFile(path.join(dir, "calibration", "drafts", "d.yaml"), "not a probe");
    await writeFile(path.join(dir, "calibration", "targets.yaml"), "contrastOrdering: 0.9\n");
    const r = await loadProbes(dir, scenario, rubrics);
    expect(r.errors).toEqual([]);
    expect(r.probes).toEqual([]);
  });
});

const mk = (id: string, criterion: string, expected: 1 | 2 | 3 | 4, split: "tune" | "holdout" = "tune"): Probe => ({
  kind: "single", id, criterion, source: "handwritten", drafter: null, approved_by: null, approved_at: null, split,
  subject: "delivery_lead", expected, transcript: [{ scene: "s1", role: "a", text: "x" }, { scene: "s1", role: "a", text: "y" }],
});

describe("lintProbeSet and assignSplit", () => {
  it("warns about a thin set, thin criteria, thin holdout and mid-heavy levels", () => {
    const w = lintProbeSet([mk("a", "discovery", 2), mk("b", "discovery", 3), mk("c", "listening", 3)]).join("\n");
    expect(w).toMatch(new RegExp(`fewer than ${MIN_SET_PROBES}`));
    expect(w).toMatch(/discovery.*fewer than 4/s);
    expect(w).toMatch(/holdout/);
    expect(w).toMatch(/level 1.*level 4|levels 1 and 4/s);
  });
  it("is deterministic, never changes with order, and splits roughly by the percentage", () => {
    expect(assignSplit("probe-1", 10)).toBe(assignSplit("probe-1", 10));
    const ids = Array.from({ length: 400 }, (_, i) => `probe-${i}`);
    const tune50 = ids.filter((id) => assignSplit(id, 10) === "tune").length;
    const tune70 = ids.filter((id) => assignSplit(id, 100) === "tune").length;
    expect(tune50).toBeGreaterThan(160); expect(tune50).toBeLessThan(240);
    expect(tune70).toBeGreaterThan(240); expect(tune70).toBeLessThan(320);
  });
});
```

- [ ] **Step 6: Run to verify it fails.** Run: `pnpm --filter @acr/runtime exec vitest run src/calibration/__tests__/probe-load.test.ts` Expected: FAIL (module not found).

- [ ] **Step 7: Implement `probe-load.ts`**

```ts
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { isPrototypeKey } from "@acr/events";
import { readTextCapped, type Criterion, type Rubric, type Scenario } from "@acr/script";
import { MIN_UTTERANCES } from "../evaluator/evaluate.js";
import { ProbeSchema, scoredRoles, type Probe } from "./probe-schema.js";

export const MIN_SET_PROBES = 20;
export const MIN_CRITERION_PROBES = 4;
export const MIN_HOLDOUT_PROBES = 10;
export const MAX_PROBE_BYTES = 128 * 1024;
const MAX_ALIASES = 10;

export type LoadedProbes = { probes: Probe[]; errors: string[]; warnings: string[] };

function hasPrototypeKey(v: unknown, depth = 0): boolean {
  if (v === null || typeof v !== "object" || depth > 8) return false;
  for (const k of Object.keys(v as object)) {
    if (isPrototypeKey(k) || hasPrototypeKey((v as Record<string, unknown>)[k], depth + 1)) return true;
  }
  return false;
}

export async function loadProbes(dir: string, scenario: Scenario, rubrics: Rubric[]): Promise<LoadedProbes> {
  const out: LoadedProbes = { probes: [], errors: [], warnings: [] };
  const calDir = path.join(dir, "calibration");
  let entries;
  try {
    entries = await readdir(calDir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      out.warnings.push(`no calibration directory at ${calDir}`);
      return out;
    }
    throw e;
  }
  const individual = new Map<string, Criterion>();
  for (const r of rubrics) if (r.scope === "individual") for (const c of r.criteria) individual.set(c.id, c);
  const files = entries.filter((e) => e.isFile() && e.name.endsWith(".yaml") && e.name !== "targets.yaml").map((e) => e.name).sort();
  const seen = new Set<string>();
  for (const name of files) {
    const probe = await parseOne(path.join(calDir, name), name, out.errors);
    if (!probe) continue;
    const problems = checkProbe(name, probe, scenario, individual);
    if (seen.has(probe.id)) problems.push(`${name}: duplicate probe id ${probe.id}`);
    if (problems.length) { out.errors.push(...problems); continue; }
    seen.add(probe.id);
    out.probes.push(probe);
  }
  out.warnings.push(...lintProbeSet(out.probes));
  return out;
}

async function parseOne(file: string, name: string, errors: string[]): Promise<Probe | null> {
  let raw: unknown;
  try {
    raw = parse(await readTextCapped(file, MAX_PROBE_BYTES), { maxAliasCount: MAX_ALIASES });
  } catch (e) {
    errors.push(`${name}: ${(e as Error).message.split("\n")[0]}`);
    return null;
  }
  if (hasPrototypeKey(raw)) { errors.push(`${name}: a prototype key is not allowed`); return null; }
  const r = ProbeSchema.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0]!;
    errors.push(`${name}: ${i.path.join(".") || "(root)"} ${i.message}`);
    return null;
  }
  return r.data;
}

function checkProbe(name: string, p: Probe, scenario: Scenario, individual: Map<string, Criterion>): string[] {
  const problems: string[] = [];
  if (`${p.id}.yaml` !== name) problems.push(`${name}: the id ${p.id} must match the file name`);
  if (!individual.has(p.criterion)) problems.push(`${name}: criterion ${p.criterion} is not an individual criterion of this scenario's rubrics`);
  const sceneIds = new Set(scenario.script.scenes.map((s) => s.id));
  const counts = new Map<string, number>();
  for (const l of p.transcript) {
    if (!sceneIds.has(l.scene)) problems.push(`${name}: unknown scene ${l.scene}`);
    if (!Object.hasOwn(scenario.roles, l.role)) problems.push(`${name}: unknown role ${l.role}`);
    counts.set(l.role, (counts.get(l.role) ?? 0) + 1);
  }
  for (const role of scoredRoles(p)) {
    const def = Object.hasOwn(scenario.roles, role) ? scenario.roles[role] : undefined;
    if (def?.type !== "player") problems.push(`${name}: ${role} is not a player role`);
    else if ((counts.get(role) ?? 0) < MIN_UTTERANCES) problems.push(`${name}: ${role} needs at least ${MIN_UTTERANCES} lines to be scored`);
  }
  return problems;
}

export function lintProbeSet(probes: Probe[]): string[] {
  if (probes.length === 0) return [];
  const w: string[] = [];
  if (probes.length < MIN_SET_PROBES) w.push(`the probe set has fewer than ${MIN_SET_PROBES} probes (${probes.length}): results are thin`);
  const holdout = probes.filter((p) => p.split === "holdout").length;
  if (holdout < MIN_HOLDOUT_PROBES) w.push(`only ${holdout} holdout probes (at least ${MIN_HOLDOUT_PROBES} are needed before a default change)`);
  const byCriterion = new Map<string, number>();
  for (const p of probes) byCriterion.set(p.criterion, (byCriterion.get(p.criterion) ?? 0) + 1);
  for (const [c, n] of byCriterion) if (n < MIN_CRITERION_PROBES) w.push(`criterion ${c} has fewer than ${MIN_CRITERION_PROBES} probes (${n}): thin`);
  const expected: number[] = probes.flatMap((p) => (p.kind === "single" ? (typeof p.expected === "number" ? [p.expected] : []) : Object.values(p.players)));
  const ends = expected.filter((l) => l === 1 || l === 4).length;
  if (expected.length > 0 && (!expected.includes(1) || !expected.includes(4) || ends / expected.length < 0.3)) {
    w.push("expected levels are mid-heavy: add probes at levels 1 and 4 (a judge that always answers 3 would otherwise go unnoticed)");
  }
  return w;
}

/** Deterministic tune/holdout assignment; the result is stored in the probe file and never recomputed for an existing probe. */
export function assignSplit(id: string, total: number): "tune" | "holdout" {
  const pct = total < 40 ? 50 : 70;
  const n = Number.parseInt(createHash("sha256").update(id).digest("hex").slice(0, 8), 16);
  return n % 100 < pct ? "tune" : "holdout";
}
```

- [ ] **Step 8: Run both test files.** Run: `pnpm --filter @acr/runtime exec vitest run src/calibration/__tests__` Expected: PASS. Fix any message-regex mismatch by adjusting the implementation message, not by weakening the assertions.

- [ ] **Step 9: Typecheck, eslint, id-rules guard.** Run: `pnpm typecheck && npx eslint services/runtime/src/calibration && pnpm --filter @acr/runtime exec vitest run src/__tests__/id-rules.files.test.ts` Expected: all pass.

- [ ] **Step 10: Commit**

```bash
git add services/runtime/src/calibration
git commit -m "[feat] US-0035: calibration probe schema, loader, validator and linter"
```

## Task 2: Probe to synthetic session log

**Files:** Create `services/runtime/src/calibration/probe-events.ts`; Test `services/runtime/src/calibration/__tests__/probe-events.test.ts`.

**Interfaces:** Produces `PROBE_T0 = 1_800_000_000_000`, `buildProbeEvents(probe: Probe, scenario: Scenario): SessionEvent[]`. Consumes `Probe` (Task 1), `EventBody`, `SessionEvent` (`@acr/events`), `parseSessionLog`-compatible shape (seq 1..n, `session.started` first).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenario } from "@acr/script";
import { parseSessionLog } from "../../evaluator/log-reader.js";
import { buildTranscript, renderTranscript } from "../../evaluator/transcript.js";
import { buildProbeEvents } from "../probe-events.js";
import type { Probe } from "../probe-schema.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const probe: Probe = {
  kind: "single", id: "p1", criterion: "discovery", source: "handwritten", drafter: null, approved_by: null, approved_at: null, split: "tune",
  subject: "delivery_lead", expected: 1,
  transcript: [
    { scene: "s2_client_call", role: "client_sponsor", text: "Can you confirm by Friday?" },
    { scene: "s2_client_call", role: "delivery_lead", text: "Yes, we can do that." },
    { scene: "s2_client_call", role: "delivery_lead", text: "Consider it done." },
    { scene: "s3_internal_wrap", role: "tech_lead", text: "Okay, wrapping up." },
  ],
};

describe("buildProbeEvents", () => {
  it("builds a log the real evaluator reader and transcript accept, with scenes and an end", async () => {
    const scenario = await loadScenario(path.join(REPO, "scenarios/friday-escalation"));
    const events = buildProbeEvents(probe, scenario);
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events[0]!.type).toBe("session.started");
    expect(events.at(-1)!.type).toBe("session.ended");
    expect(events.filter((e) => e.type === "scene.entered")).toHaveLength(2);
    // round-trips through the production reader
    const text = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    expect(parseSessionLog(text)).toHaveLength(events.length);
    const t = buildTranscript(events, scenario);
    expect(t.counts["delivery_lead"]).toBe(2);
    expect(renderTranscript(t, 60_000).text).toContain("Consider it done.");
    expect(t.complete).toBe(true);
  });
  it("uses only the roles that speak in each scene as participants", async () => {
    const scenario = await loadScenario(path.join(REPO, "scenarios/friday-escalation"));
    const entered = buildProbeEvents(probe, scenario).filter((e) => e.type === "scene.entered");
    expect((entered[0] as { participants: string[] }).participants.sort()).toEqual(["client_sponsor", "delivery_lead"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `pnpm --filter @acr/runtime exec vitest run src/calibration/__tests__/probe-events.test.ts` Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
import type { EventBody, SessionEvent } from "@acr/events";
import type { Scenario } from "@acr/script";
import type { Probe } from "./probe-schema.js";

export const PROBE_T0 = 1_800_000_000_000;
const STEP_MS = 10_000;

export function buildProbeEvents(probe: Probe, scenario: Scenario): SessionEvent[] {
  const sessionId = `probe-${probe.id}`;
  const out: SessionEvent[] = [];
  const push = (body: EventBody): void => {
    out.push({ ...body, seq: out.length + 1, ts: PROBE_T0 + out.length * STEP_MS, sessionId } as SessionEvent);
  };
  push({ type: "session.started", scenarioId: scenario.meta.id, version: scenario.meta.version, roles: {} });
  let current: string | null = null;
  probe.transcript.forEach((line, i) => {
    if (line.scene !== current) {
      if (current !== null) push({ type: "scene.exited", sceneId: current, reason: "facilitator_advance" });
      const participants: string[] = [];
      for (let j = i; j < probe.transcript.length && probe.transcript[j]!.scene === line.scene; j++) {
        const r = probe.transcript[j]!.role;
        if (!participants.includes(r)) participants.push(r);
      }
      push({ type: "scene.entered", sceneId: line.scene, participants });
      current = line.scene;
    }
    push({ type: "utterance", roleId: line.role, text: line.text, channel: "text" });
  });
  if (current !== null) push({ type: "scene.exited", sceneId: current, reason: "facilitator_advance" });
  push({ type: "session.ended", reason: "script_complete" });
  return out;
}
```

- [ ] **Step 4: Run to verify it passes.** Same command. Expected: PASS, 2 tests.
- [ ] **Step 5: Commit.** `git add services/runtime/src/calibration && git commit -m "[feat] US-0035: build synthetic session logs from probes"`

## Task 3: Friday starter probe set and validation

**Files:** Create `scenarios/friday-escalation/calibration/{disc-l1,disc-l2,disc-l3,disc-l4,neg-l1,neg-l4,listening-contrast-01,negotiation-contrast-01}.yaml`; Test `services/runtime/src/calibration/__tests__/starter-set.test.ts`.

**Interfaces:** Consumes `loadProbes`, `lintProbeSet` (Task 1). The probes are authored data; splits are set by hand (4 tune, 4 holdout) and never recomputed.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRubrics, loadScenario } from "@acr/script";
import { loadProbes } from "../probe-load.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

describe("Friday starter probe set", () => {
  it("validates against the scenario's rubrics and covers every level of discovery", async () => {
    const dir = path.join(REPO, "scenarios/friday-escalation");
    const scenario = await loadScenario(dir);
    const { rubrics } = await loadRubrics(dir, scenario);
    const r = await loadProbes(dir, scenario, rubrics);
    expect(r.errors).toEqual([]);
    expect(r.probes).toHaveLength(8);
    const disc = r.probes.filter((p) => p.kind === "single" && p.criterion === "discovery").map((p) => (p.kind === "single" ? p.expected : 0));
    expect(disc.sort()).toEqual([1, 2, 3, 4]);
    expect(r.probes.filter((p) => p.kind === "contrast")).toHaveLength(2);
    expect(r.probes.every((p) => p.source === "handwritten")).toBe(true);
    expect(r.warnings.join("\n")).toMatch(/fewer than 20/);
  });
});
```

- [ ] **Step 2: Run to verify it fails** (no probes yet: `toHaveLength(8)` fails). Run `pnpm --filter @acr/runtime exec vitest run src/calibration/__tests__/starter-set.test.ts`.

- [ ] **Step 3: Author the eight probes.** Create each file exactly as below. Roles: client-facing criteria use scene `s2_client_call` (players `delivery_lead`, `account_manager`; NPC `client_sponsor`); the team listening probe uses `s3_internal_wrap` (players `delivery_lead`, `tech_lead`, `account_manager`).

`calibration/disc-l1.yaml`
```yaml
kind: single
id: disc-l1
criterion: discovery
source: handwritten
split: tune
subject: delivery_lead
expected: 1
transcript:
  - { scene: s2_client_call, role: client_sponsor, text: "We need the reconciliation module before go-live. Can you confirm that today?" }
  - { scene: s2_client_call, role: delivery_lead, text: "Yes, we can do that for you. I will tell the team to start on it today." }
  - { scene: s2_client_call, role: client_sponsor, text: "Great, that is a relief. Finance will be happy." }
  - { scene: s2_client_call, role: delivery_lead, text: "No problem at all, consider it done and we will keep the launch date." }
```

`calibration/disc-l2.yaml`
```yaml
kind: single
id: disc-l2
criterion: discovery
source: handwritten
split: holdout
subject: delivery_lead
expected: 2
transcript:
  - { scene: s2_client_call, role: client_sponsor, text: "We need the reconciliation module before go-live. It is a must-have." }
  - { scene: s2_client_call, role: delivery_lead, text: "Is Friday a hard deadline for you?" }
  - { scene: s2_client_call, role: client_sponsor, text: "Yes, I have to tell my CFO by the end of the day." }
  - { scene: s2_client_call, role: delivery_lead, text: "How big do you think the module needs to be? And who would need to sign it off?" }
  - { scene: s2_client_call, role: client_sponsor, text: "Small, I hope. Whoever Finance nominates." }
  - { scene: s2_client_call, role: delivery_lead, text: "Okay, let me check with the team and come back to you." }
```

`calibration/disc-l3.yaml`
```yaml
kind: single
id: disc-l3
criterion: discovery
source: handwritten
split: tune
subject: delivery_lead
expected: 3
transcript:
  - { scene: s2_client_call, role: client_sponsor, text: "We need the reconciliation module before go-live. It is a must-have." }
  - { scene: s2_client_call, role: delivery_lead, text: "Help me understand what Finance does today when the daily loads arrive, and what breaks for them on day one if the module is not there?" }
  - { scene: s2_client_call, role: client_sponsor, text: "They cannot tie out the daily totals, so the first month-end close is at risk." }
  - { scene: s2_client_call, role: delivery_lead, text: "So the real problem is tying out the daily loads before month-end, not the module itself. Let me see what we can offer that fits that." }
```

`calibration/disc-l4.yaml`
```yaml
kind: single
id: disc-l4
criterion: discovery
source: handwritten
split: holdout
subject: delivery_lead
expected: 4
acceptable: [3, 4]
transcript:
  - { scene: s2_client_call, role: client_sponsor, text: "We need the reconciliation module before go-live. It is a must-have." }
  - { scene: s2_client_call, role: delivery_lead, text: "Before I answer, help me understand what happens in Finance on day one if the module is not there?" }
  - { scene: s2_client_call, role: client_sponsor, text: "They cannot tie out the daily loads, and my CFO is watching the first close very closely." }
  - { scene: s2_client_call, role: delivery_lead, text: "So what you really need is for Finance to tie out the daily loads at month-end, and your CFO to trust the numbers. Have I got that right?" }
  - { scene: s2_client_call, role: client_sponsor, text: "Yes, exactly that." }
  - { scene: s2_client_call, role: delivery_lead, text: "In that case I would offer something different from the full module: a daily summary report in two weeks that gives Finance the tie-out without touching the launch date. Would that work for you?" }
```

`calibration/neg-l1.yaml`
```yaml
kind: single
id: neg-l1
criterion: negotiation
source: handwritten
split: holdout
subject: delivery_lead
expected: 1
transcript:
  - { scene: s2_client_call, role: client_sponsor, text: "We need the module before go-live. Can you do it for the same fee?" }
  - { scene: s2_client_call, role: delivery_lead, text: "Of course, we will absorb it. Anything you need." }
  - { scene: s2_client_call, role: client_sponsor, text: "And the launch date stays the same?" }
  - { scene: s2_client_call, role: delivery_lead, text: "Absolutely, the date stays and the fee stays. No problem." }
```

`calibration/neg-l4.yaml`
```yaml
kind: single
id: neg-l4
criterion: negotiation
source: handwritten
split: tune
subject: delivery_lead
expected: 4
acceptable: [3, 4]
transcript:
  - { scene: s2_client_call, role: client_sponsor, text: "We need the module before go-live. Can you do it for the same fee?" }
  - { scene: s2_client_call, role: delivery_lead, text: "I can give you two options. Option one: we deliver a daily summary report before launch at no extra cost, and the full module follows in a second phase after go-live. Option two: we build the full module now, which moves the launch date by three weeks and carries an extra fee." }
  - { scene: s2_client_call, role: client_sponsor, text: "The first option sounds closer to what I need. What do you need from me?" }
  - { scene: s2_client_call, role: delivery_lead, text: "A written change request for the second phase, signed by you by Friday, and Finance agreeing the report layout. Shall I send the change request this afternoon so we are both clear on the next steps?" }
```

`calibration/listening-contrast-01.yaml`
```yaml
kind: contrast
id: listening-contrast-01
criterion: listening
source: handwritten
split: tune
players: { delivery_lead: 4, account_manager: 1 }
min_gap: 2
transcript:
  - { scene: s3_internal_wrap, role: tech_lead, text: "My worry is that the new module touches the same ingestion pipeline we are still hardening, so any change this late could break the nightly loads." }
  - { scene: s3_internal_wrap, role: delivery_lead, text: "So the risk is the ingestion pipeline, and a late change could break the nightly loads. Have I got your concern right?" }
  - { scene: s3_internal_wrap, role: account_manager, text: "Anyway, I think we should just say yes to Priya and keep the relationship happy." }
  - { scene: s3_internal_wrap, role: delivery_lead, text: "That is exactly what we should tell Priya, in your words, tech lead: that the pipeline risk is real. It also gives us a reason to phase the module." }
  - { scene: s3_internal_wrap, role: account_manager, text: "I still think we should say yes. Let us just say yes today." }
```

`calibration/negotiation-contrast-01.yaml`
```yaml
kind: contrast
id: negotiation-contrast-01
criterion: negotiation
source: handwritten
split: holdout
players: { delivery_lead: 4, account_manager: 1 }
min_gap: 2
transcript:
  - { scene: s2_client_call, role: client_sponsor, text: "We need the module before go-live, and I need an answer today." }
  - { scene: s2_client_call, role: account_manager, text: "Yes, no problem, we will do the whole module before go-live." }
  - { scene: s2_client_call, role: delivery_lead, text: "There are two ways to do this. We can phase it: a summary report before launch and the full module after, at the same fee. Or we build all of it now, which moves the date and adds a fee." }
  - { scene: s2_client_call, role: client_sponsor, text: "I would rather not move the date." }
  - { scene: s2_client_call, role: account_manager, text: "Fine, we will keep the date and the fee as they are." }
  - { scene: s2_client_call, role: delivery_lead, text: "Then the phased option works, provided we have a signed change request for phase two by Friday. I will send it today and we will confirm the next steps together." }
```

- [ ] **Step 4: Run to verify it passes.** `pnpm --filter @acr/runtime exec vitest run src/calibration/__tests__/starter-set.test.ts` Expected: PASS. If the loader rejects a probe, fix the probe (not the loader) and re-run.

- [ ] **Step 5: Gates for the story** (Global Constraints), then commit and request review.

```bash
git add scenarios/friday-escalation/calibration services/runtime/src/calibration
git commit -m "[feat] US-0035: Friday starter probe set (8 probes) with validation test"
```

---

# Story US-0036: `pnpm calibrate`

## Task 4: Judges

**Files:** Create `services/runtime/src/calibration/judge.ts`; Test `services/runtime/src/calibration/__tests__/judge.test.ts`.

**Interfaces:** Produces `type JudgeSpec = { label: string; model: string; baseUrl?: string }`; `parseJudgeSpec(raw: string): JudgeSpec`; `modelFamily(model: string): string`; `type Judge = { label: string; model: string; family: string; provider: ModelProvider }`; `buildJudge(spec: JudgeSpec, env: NodeJS.ProcessEnv): Judge`; `buildPrimaryJudge(env: NodeJS.ProcessEnv, cfg: EvalConfig): Judge`; `class CalibrationInputError extends Error`. Consumes `isFileSafeId`, `selectModelProvider`, `parseModelRetry`, `withModelRetry`, `startEvaluatorProvider`, `isMockProvider`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { buildJudge, buildPrimaryJudge, CalibrationInputError, modelFamily, parseJudgeSpec } from "../judge.js";
import { parseEvalConfig } from "../../evaluator/config.js";

describe("parseJudgeSpec", () => {
  it("parses label,model and an optional base URL", () => {
    expect(parseJudgeSpec("second,holo3-35b-a3b")).toEqual({ label: "second", model: "holo3-35b-a3b" });
    expect(parseJudgeSpec("second,holo3-35b-a3b,http://127.0.0.1:1337/v1")).toEqual({ label: "second", model: "holo3-35b-a3b", baseUrl: "http://127.0.0.1:1337/v1" });
  });
  it.each(["", "onlylabel", "../x,m", "a,", "a,m,ftp://x", "a,m,not a url", "a,has space", "a,m://x", "a,m,http://x,extra"])("rejects %j", (raw) => {
    expect(() => parseJudgeSpec(raw)).toThrow(CalibrationInputError);
  });
});

describe("modelFamily", () => {
  it.each([
    ["gemma-4-31b-it-qat-mxfp4", "gemma"], ["Qwen3.8-27b", "qwen"], ["nemotron-3-nano", "nemotron"], ["anthropic/claude-sonnet-5.5", "claude"],
    ["ministral-3-14b", "mistral"], ["mistral-large", "mistral"], ["holo3-35b-a3b", "holo"], ["weird-model-1", "weird"],
  ])("%s -> %s", (m, f) => expect(modelFamily(m)).toBe(f));
});

describe("judges", () => {
  it("refuses the mock provider for the primary judge", () => {
    const cfg = parseEvalConfig({}); if (!cfg.ok) throw new Error("cfg");
    expect(() => buildPrimaryJudge({}, cfg)).toThrow(/mock/);
  });
  it("builds a judge on a local OpenAI-compatible endpoint from a spec", () => {
    const j = buildJudge({ label: "second", model: "holo3-35b-a3b", baseUrl: "http://127.0.0.1:1337/v1" }, {});
    expect(j.label).toBe("second"); expect(j.family).toBe("holo"); expect(typeof j.provider.stream).toBe("function");
  });
  it("needs a base URL from the spec or LOCAL_BASE_URL", () => {
    expect(() => buildJudge({ label: "second", model: "m" }, {})).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `pnpm --filter @acr/runtime exec vitest run src/calibration/__tests__/judge.test.ts` Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import { selectModelProvider, type ModelProvider } from "@acr/adapters";
import { isFileSafeId } from "@acr/events";
import { parseModelRetry, withModelRetry } from "../agents/retry-config.js";
import type { EvalConfig } from "../evaluator/config.js";
import { isMockProvider, startEvaluatorProvider } from "../evaluator/provider.js";

export class CalibrationInputError extends Error {}

export type JudgeSpec = { label: string; model: string; baseUrl?: string };
export type Judge = { label: string; model: string; family: string; provider: ModelProvider };

const FAMILIES = ["gemma", "qwen", "nemotron", "claude", "gpt", "llama", "mistral", "ministral", "holo", "raptor", "foundation", "gemini", "deepseek", "phi"];

export function modelFamily(model: string): string {
  const tail = (model.toLowerCase().split("/").pop() ?? "").trim();
  const hit = FAMILIES.find((f) => tail.startsWith(f));
  if (hit === "ministral") return "mistral";
  return hit ?? (tail.split(/[-_.:]/)[0] || tail);
}

function validModel(m: string): boolean {
  return m.length > 0 && m.length <= 200 && !m.includes("://") && !/\s/.test(m);
}

export function parseJudgeSpec(raw: string): JudgeSpec {
  const parts = raw.split(",");
  if (parts.length < 2 || parts.length > 3) throw new CalibrationInputError(`--judge must be label,model[,baseUrl]: got "${raw.slice(0, 60)}"`);
  const [label, model, baseUrl] = parts as [string, string, string | undefined];
  if (!isFileSafeId(label)) throw new CalibrationInputError("a judge label must be 1 to 64 characters of lower-case letters, digits, '_' or '-'");
  if (!validModel(model)) throw new CalibrationInputError("a judge model id must be 1 to 200 characters with no spaces and no ://");
  if (baseUrl === undefined) return { label, model };
  let u: URL;
  try { u = new URL(baseUrl); } catch { throw new CalibrationInputError("a judge base URL must be a valid http or https URL"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new CalibrationInputError("a judge base URL must be http or https");
  return { label, model, baseUrl };
}

export function buildJudge(spec: JudgeSpec, env: NodeJS.ProcessEnv): Judge {
  const baseUrl = spec.baseUrl ?? env.LOCAL_BASE_URL;
  if (!baseUrl) throw new CalibrationInputError(`judge ${spec.label}: no base URL (give one in --judge or set LOCAL_BASE_URL)`);
  const retry = parseModelRetry(env);
  if (!retry.ok) throw new CalibrationInputError(retry.errors.join("; "));
  const scoped = { ...env, MODEL_PROVIDER: "local", LOCAL_BASE_URL: baseUrl, NPC_MODEL: spec.model };
  const provider = withModelRetry(selectModelProvider(scoped, "npc", { sdkRetries: false }), retry, "EVAL");
  return { label: spec.label, model: spec.model, family: modelFamily(spec.model), provider };
}

export function buildPrimaryJudge(env: NodeJS.ProcessEnv, cfg: EvalConfig): Judge {
  if (isMockProvider(env)) {
    throw new CalibrationInputError("MODEL_PROVIDER is mock: calibration needs a real judge (set MODEL_PROVIDER and the model variables, or pass --judge)");
  }
  const model = cfg.model ?? env.NPC_MODEL ?? "default";
  return { label: "primary", model, family: modelFamily(model), provider: startEvaluatorProvider(env, cfg) };
}
```

- [ ] **Step 4: Run to verify it passes.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.** `git add services/runtime/src/calibration && git commit -m "[feat] US-0036: calibration judges as configuration (never the mock provider)"`

## Task 5: Outcome types and the runner

**Files:** Create `services/runtime/src/calibration/types.ts`, `services/runtime/src/calibration/runner.ts`, `services/runtime/src/calibration/__tests__/fake-judge.ts` (test helper); Test `services/runtime/src/calibration/__tests__/runner.test.ts`.

**Interfaces:**
- Produces (`types.ts`):
  ```ts
  export type Observed = 1 | 2 | 3 | 4 | "not_observed" | "invalid" | "failed";
  export type Evidence = { role: string; rationale: string; quotes: string[] };
  type OutcomeBase = { probeId: string; criterion: string; split: "tune" | "holdout"; source: "handwritten" | "drafted" | "excerpt"; drafter: string | null; capped: number; dropped: number; evidence: Evidence[] };
  export type SingleOutcome = OutcomeBase & { kind: "single"; subject: string; expected: Expected; acceptable: Expected[]; runs: Observed[] };
  export type ContrastOutcome = OutcomeBase & { kind: "contrast"; expected: Record<string, Level>; minGap: number; runs: Record<string, Observed>[] };
  export type Outcome = SingleOutcome | ContrastOutcome;
  ```
- Produces (`runner.ts`): `observedOf(p: ParticipantEval | undefined, criterion: string): { observed: Observed; capped: boolean; dropped: number; evidence?: Evidence }`; `type RunOptions = { repeat: number; only?: string[]; allCriteria: boolean; signal?: AbortSignal; onProgress?: (m: string) => void }`; `runJudge(judge: Judge, probes: Probe[], scenario: Scenario, rubrics: Rubric[], cfg: EvalConfig, opts: RunOptions): Promise<Outcome[]>`; `MAX_REPEAT = 5`.
- Consumes: `evaluateSession`, `ParticipantEval`, `CriterionResult` (`../evaluator/*`), `buildProbeEvents`, `Judge`.

- [ ] **Step 1: Write the test helper `fake-judge.ts`** (a scripted provider that answers the evaluator's real prompt with quotes that verify)

```ts
import type { ChatRequest, ModelProvider } from "@acr/adapters";

export type Decide = (ctx: { role: string; transcript: string }) => Record<string, number | null>;

/** Answers participant calls with a score per criterion chosen by `decide`, quoting a real line of that participant. */
export function fakeJudge(criteriaIds: string[], decide: Decide, failFor?: (role: string) => boolean): ModelProvider & { calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  return {
    name: "fake-judge", calls,
    async *stream(req: ChatRequest): AsyncIterable<string> {
      calls.push(req);
      const role = /score only the participant with role id "([a-z0-9_-]+)"/i.exec(req.system)?.[1];
      if (!role) { yield JSON.stringify({ criteria: [], talking_points: [], notable_moments: [] }); return; }
      if (failFor?.(role)) throw new Error("judge unreachable");
      const transcript = req.messages.map((m) => m.content).join("\n");
      const own = [...transcript.matchAll(new RegExp(`#(\\d+) [0-9:]{8} ${role} \\(player\\): (.*)`, "g"))];
      const first = own[0];
      const levels = decide({ role, transcript });
      const criteria = criteriaIds.map((id) => ({
        id, score: levels[id] ?? null, rationale: `Because ${id}.`, confidence: "high",
        evidence: first ? [{ seq: Number(first[1]), quote: first[2]!.slice(0, 60) }] : [],
      }));
      yield JSON.stringify({ criteria, strengths: [], development_points: [], next_actions: [] });
    },
  };
}
```

- [ ] **Step 2: Write the failing runner test**

```ts
import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRubrics, loadScenario } from "@acr/script";
import { parseEvalConfig } from "../../evaluator/config.js";
import { loadProbes } from "../probe-load.js";
import { runJudge, MAX_REPEAT } from "../runner.js";
import { fakeJudge } from "./fake-judge.js";
import type { Judge } from "../judge.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const cfgParsed = parseEvalConfig({}); if (!cfgParsed.ok) throw new Error("cfg");
const dir = path.join(REPO, "scenarios/friday-escalation");

async function setup() {
  const scenario = await loadScenario(dir);
  const { rubrics } = await loadRubrics(dir, scenario);
  const { probes } = await loadProbes(dir, scenario, rubrics);
  const ids = rubrics.filter((r) => r.scope === "individual").flatMap((r) => r.criteria.map((c) => c.id));
  return { scenario, rubrics, probes, ids };
}
const judgeOf = (provider: Judge["provider"]): Judge => ({ label: "primary", model: "fake", family: "fake", provider });

describe("runJudge", () => {
  it("scores each probe through the real evaluator and records observed levels", async () => {
    const { scenario, rubrics, probes, ids } = await setup();
    const provider = fakeJudge(ids, ({ transcript }) => (transcript.includes("consider it done") ? { discovery: 1 } : { discovery: 3 }));
    const out = await runJudge(judgeOf(provider), probes.filter((p) => p.id === "disc-l1"), scenario, rubrics, cfgParsed, { repeat: 1, allCriteria: true });
    expect(out).toHaveLength(1);
    const o = out[0]!;
    expect(o.kind).toBe("single");
    if (o.kind === "single") expect(o.runs).toEqual([1]);
    expect(o.evidence[0]!.quotes.length).toBeGreaterThan(0);
  });
  it("scores every player of a contrast probe and maps them by role", async () => {
    const { scenario, rubrics, probes, ids } = await setup();
    const provider = fakeJudge(ids, ({ role }) => ({ listening: role === "delivery_lead" ? 4 : 1 }));
    const out = await runJudge(judgeOf(provider), probes.filter((p) => p.id === "listening-contrast-01"), scenario, rubrics, cfgParsed, { repeat: 1, allCriteria: true });
    const o = out[0]!;
    expect(o.kind === "contrast" && o.runs[0]).toEqual({ delivery_lead: 4, account_manager: 1 });
  });
  it("records an unreachable judge as unusable, not as a score", async () => {
    const { scenario, rubrics, probes, ids } = await setup();
    const provider = fakeJudge(ids, () => ({}), () => true);
    const out = await runJudge(judgeOf(provider), probes.filter((p) => p.id === "disc-l1"), scenario, rubrics, cfgParsed, { repeat: 1, allCriteria: true });
    const o = out[0]!;
    expect(o.kind === "single" && o.runs[0]).toBe("failed");
  });
  it("repeats, filters with --only and caps repeat", async () => {
    const { scenario, rubrics, probes, ids } = await setup();
    const provider = fakeJudge(ids, () => ({ discovery: 2 }));
    const out = await runJudge(judgeOf(provider), probes, scenario, rubrics, cfgParsed, { repeat: 2, only: ["disc-l2"], allCriteria: true });
    expect(out).toHaveLength(1);
    expect(out[0]!.kind === "single" && out[0]!.runs).toEqual([2, 2]);
    await expect(runJudge(judgeOf(provider), probes, scenario, rubrics, cfgParsed, { repeat: MAX_REPEAT + 1, allCriteria: true })).rejects.toThrow(/repeat/);
    await expect(runJudge(judgeOf(provider), probes, scenario, rubrics, cfgParsed, { repeat: 1, only: ["missing"], allCriteria: true })).rejects.toThrow(/missing/);
  });
  it("narrows the rubric to the probe's criterion when allCriteria is false", async () => {
    const { scenario, rubrics, probes, ids } = await setup();
    const provider = fakeJudge(ids, () => ({ discovery: 2 }));
    await runJudge(judgeOf(provider), probes.filter((p) => p.id === "disc-l2"), scenario, rubrics, cfgParsed, { repeat: 1, allCriteria: false });
    expect(provider.calls[0]!.system).not.toContain("negotiation");
  });
});
```

- [ ] **Step 3: Run to verify it fails.** `pnpm --filter @acr/runtime exec vitest run src/calibration/__tests__/runner.test.ts` Expected: FAIL (modules not found).

- [ ] **Step 4: Implement `types.ts`** (the types listed under Interfaces, importing `Expected`, `Level` from `./probe-schema.js`).

- [ ] **Step 5: Implement `runner.ts`**

```ts
import type { Rubric, Scenario } from "@acr/script";
import type { EvalConfig } from "../evaluator/config.js";
import { evaluateSession, type ParticipantEval } from "../evaluator/evaluate.js";
import type { Judge } from "./judge.js";
import { CalibrationInputError } from "./judge.js";
import { buildProbeEvents } from "./probe-events.js";
import { scoredRoles, type Probe } from "./probe-schema.js";
import type { Evidence, Observed, Outcome } from "./types.js";

export const MAX_REPEAT = 5;

export type RunOptions = { repeat: number; only?: string[]; allCriteria: boolean; signal?: AbortSignal; onProgress?: (m: string) => void };

export function observedOf(p: ParticipantEval | undefined, criterion: string): { observed: Observed; capped: boolean; dropped: number; evidence?: Evidence } {
  if (!p || p.status !== "ok") return { observed: "failed", capped: false, dropped: 0 };
  const c = p.criteria.find((x) => x.id === criterion);
  if (!c) return { observed: "failed", capped: false, dropped: 0 };
  const capped = c.flags.some((f) => f.startsWith("capped from"));
  const evidence: Evidence = { role: p.roleId, rationale: c.rationale, quotes: c.evidence.map((e) => e.quote) };
  if (c.invalid) return { observed: "invalid", capped, dropped: c.droppedQuotes, evidence };
  if (c.score === null) return { observed: "not_observed", capped, dropped: c.droppedQuotes, evidence };
  return { observed: c.score, capped, dropped: c.droppedQuotes, evidence };
}

function rubricsFor(all: Rubric[], probe: Probe, allCriteria: boolean): Rubric[] {
  const individual = all.filter((r) => r.scope === "individual");
  if (allCriteria) return individual;
  return individual
    .map((r) => ({ ...r, criteria: r.criteria.filter((c) => c.id === probe.criterion) }))
    .filter((r) => r.criteria.length > 0);
}

export async function runJudge(judge: Judge, probes: Probe[], scenario: Scenario, rubrics: Rubric[], cfg: EvalConfig, opts: RunOptions): Promise<Outcome[]> {
  if (!Number.isInteger(opts.repeat) || opts.repeat < 1 || opts.repeat > MAX_REPEAT) {
    throw new CalibrationInputError(`--repeat must be a whole number from 1 to ${MAX_REPEAT}`);
  }
  let chosen = probes;
  if (opts.only) {
    const known = new Set(probes.map((p) => p.id));
    const unknown = opts.only.filter((id) => !known.has(id));
    if (unknown.length) throw new CalibrationInputError(`--only names unknown probes: ${unknown.join(", ")}`);
    chosen = probes.filter((p) => opts.only!.includes(p.id));
  }
  const out: Outcome[] = [];
  for (const probe of chosen) {
    opts.onProgress?.(`${judge.label}: ${probe.id}`);
    const base = { probeId: probe.id, criterion: probe.criterion, split: probe.split, source: probe.source, drafter: probe.drafter };
    const events = buildProbeEvents(probe, scenario);
    const used = rubricsFor(rubrics, probe, opts.allCriteria);
    const roles = scoredRoles(probe);
    const perRun: Record<string, Observed>[] = [];
    let capped = 0, dropped = 0;
    let evidence: Evidence[] = [];
    for (let i = 0; i < opts.repeat; i++) {
      if (opts.signal?.aborted) return out;
      const result = await evaluateSession({ events, scenario, rubrics: used, provider: judge.provider, config: cfg, signal: opts.signal });
      const run: Record<string, Observed> = {};
      for (const role of roles) {
        const o = observedOf(result.participants.find((p) => p.roleId === role), probe.criterion);
        run[role] = o.observed;
        if (o.capped) capped++;
        dropped += o.dropped;
        if (i === 0 && o.evidence) evidence.push(o.evidence);
      }
      perRun.push(run);
    }
    if (probe.kind === "single") {
      const acceptable = probe.acceptable ?? [probe.expected];
      out.push({ ...base, kind: "single", subject: probe.subject, expected: probe.expected, acceptable, runs: perRun.map((r) => r[probe.subject]!), capped, dropped, evidence });
    } else {
      out.push({ ...base, kind: "contrast", expected: probe.players, minGap: probe.min_gap, runs: perRun, capped, dropped, evidence });
    }
  }
  return out;
}
```

- [ ] **Step 6: Run to verify it passes.** `pnpm --filter @acr/runtime exec vitest run src/calibration/__tests__/runner.test.ts` Expected: PASS, 5 tests. (The evaluator's `evaluateSession` never throws for model problems; an unreachable judge yields `status: "failed"` which `observedOf` maps to `"failed"`.)
- [ ] **Step 7: Commit.** `git add services/runtime/src/calibration && git commit -m "[feat] US-0036: calibration runner over the real evaluator"`

## Task 6: Metrics, targets and labels

**Files:** Create `services/runtime/src/calibration/metrics.ts`, `services/runtime/src/calibration/targets.ts`; Test `services/runtime/src/calibration/__tests__/metrics.test.ts`, `services/runtime/src/calibration/__tests__/targets.test.ts`.

**Interfaces:** Produces `isUsable`, `agreement`, `bias`, `biasByExpected`, `spread`, `notObserved`, `contrast`, `usability`, `stability`, `computeMetrics(outcomes: Outcome[]): JudgeMetrics`, `splitMetrics(outcomes, key: "split"|"source"|"drafter")`, `Targets`, `DEFAULT_TARGETS`, `labelFor(m: JudgeMetrics, t: Targets): { label: "PASS"|"WARN"|"FAIL"; reasons: string[] }`, `loadTargets(dir: string): Promise<Targets>`. Consumes Task 5 types.

- [ ] **Step 1: Write the failing metrics test** (exact numbers by hand)

```ts
import { describe, expect, it } from "vitest";
import { agreement, bias, biasByExpected, computeMetrics, contrast, labelFor, notObserved, spread, stability, usability } from "../metrics.js";
import { DEFAULT_TARGETS } from "../targets.js";
import type { ContrastOutcome, Observed, SingleOutcome } from "../types.js";

const base = { criterion: "discovery", split: "tune" as const, source: "handwritten" as const, drafter: null, capped: 0, dropped: 0, evidence: [] };
const single = (id: string, expected: SingleOutcome["expected"], runs: Observed[], acceptable = [expected]): SingleOutcome =>
  ({ ...base, probeId: id, kind: "single", subject: "p", expected, acceptable, runs });
const cont = (id: string, expected: Record<string, 1 | 2 | 3 | 4>, run: Record<string, Observed>, minGap = 1): ContrastOutcome =>
  ({ ...base, probeId: id, kind: "contrast", expected, minGap, runs: [run] });

describe("agreement", () => {
  it("counts exact (acceptable) and within-one over usable runs, and excludes unusable ones", () => {
    const s = [single("a", 1, [1]), single("b", 2, [3]), single("c", 4, [2]), single("d", 3, ["failed"]), single("e", 4, [3], [3, 4])];
    expect(agreement(s)).toEqual({ n: 4, unusable: 1, exact: 2, withinOne: 3 });
  });
});
describe("bias", () => {
  it("is the signed mean of observed minus expected, overall and per expected level", () => {
    const s = [single("a", 1, [3]), single("b", 1, [2]), single("c", 4, [3]), single("d", 2, ["invalid"])];
    expect(bias(s)).toEqual({ n: 3, mean: (2 + 1 - 1) / 3 });
    expect(biasByExpected(s)[1]).toEqual({ n: 2, mean: 1.5 });
    expect(biasByExpected(s)[4]).toEqual({ n: 1, mean: -1 });
  });
  it("is null with no usable pairs", () => expect(bias([single("a", 2, ["failed"])]).mean).toBeNull());
});
describe("spread", () => {
  it("counts distinct numeric levels used", () => {
    expect(spread([single("a", 1, [3]), single("b", 4, [3]), single("c", 2, [3])])).toBe(1);
    expect(spread([single("a", 1, [1]), single("b", 4, [4]), single("c", 2, ["not_observed"])])).toBe(2);
  });
});
describe("notObserved", () => {
  it("computes precision and recall, null when undefined", () => {
    const s = [single("a", "not_observed", ["not_observed"]), single("b", 3, ["not_observed"]), single("c", "not_observed", [2])];
    expect(notObserved(s)).toEqual({ precision: 1 / 2, recall: 1 / 2 });
    expect(notObserved([single("a", 2, [2])])).toEqual({ precision: null, recall: null });
  });
});
describe("contrast", () => {
  it("scores ordering, pairwise ordering and the gap", () => {
    const c = [
      cont("good", { x: 4, y: 1 }, { x: 4, y: 1 }, 2),
      cont("flat", { x: 4, y: 1 }, { x: 3, y: 3 }, 2),
      cont("gap", { x: 4, y: 2 }, { x: 3, y: 2 }, 2),
      cont("bad", { x: 4, y: 1 }, { x: "failed", y: 1 }, 1),
    ];
    expect(contrast(c)).toMatchObject({ n: 4, usable: 3, ordered: 2, pairs: 3, pairsOrdered: 2, gapMet: 1 });
  });
});
describe("usability and stability", () => {
  it("counts unusable slots, capped scores and dropped quotes", () => {
    const s = [{ ...single("a", 2, [2, "invalid"]), capped: 1, dropped: 2 }];
    expect(usability(s)).toEqual({ slots: 2, unusable: 1, capped: 1, dropped: 2 });
  });
  it("reports mean population variance over repeated numeric runs", () => {
    expect(stability([single("a", 2, [2, 4]), single("b", 2, [3, 3])])).toBe(0.5);
    expect(stability([single("a", 2, [2])])).toBeNull();
  });
});
describe("labelFor", () => {
  const m = (over: Partial<ReturnType<typeof computeMetrics>> = {}) => ({ ...computeMetrics([single("a", 1, [1]), single("b", 4, [4]), cont("c", { x: 4, y: 1 }, { x: 4, y: 1 }, 2)]), ...over });
  it("passes a discriminating, unbiased judge", () => expect(labelFor(m(), DEFAULT_TARGETS).label).toBe("PASS"));
  it("fails on poor contrast ordering or large bias", () => {
    const bad = computeMetrics([cont("c", { x: 4, y: 1 }, { x: 3, y: 3 }, 2), single("a", 1, [3]), single("b", 2, [4])]);
    const r = labelFor(bad, DEFAULT_TARGETS);
    expect(r.label).toBe("FAIL");
    expect(r.reasons.join(" ")).toMatch(/contrast ordering/);
  });
  it("warns when usability is below target", () => {
    const w = computeMetrics([single("a", 1, ["failed"]), single("b", 4, [4]), single("c", 2, [2]), single("d", 3, [3])]);
    expect(labelFor(w, DEFAULT_TARGETS).label).toBe("WARN");
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `pnpm --filter @acr/runtime exec vitest run src/calibration/__tests__/metrics.test.ts` Expected: FAIL.

- [ ] **Step 3: Implement `targets.ts`**

```ts
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";

export type Targets = { contrastOrdering: number; maxAbsBias: number; exactAgreement: number | null; minUsable: number };
export const DEFAULT_TARGETS: Targets = { contrastOrdering: 0.8, maxAbsBias: 0.3, exactAgreement: null, minUsable: 0.9 };

const TargetsSchema = z.object({
  contrastOrdering: z.number().min(0).max(1).optional(),
  maxAbsBias: z.number().min(0).max(3).optional(),
  exactAgreement: z.number().min(0).max(1).nullable().optional(),
  minUsable: z.number().min(0).max(1).optional(),
}).strict();

export async function loadTargets(dir: string): Promise<Targets> {
  let text: string;
  try { text = await readFile(path.join(dir, "calibration", "targets.yaml"), "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_TARGETS; throw e; }
  const parsed = TargetsSchema.safeParse(parse(text, { maxAliasCount: 10 }) ?? {});
  if (!parsed.success) throw new Error(`calibration/targets.yaml: ${parsed.error.issues[0]!.path.join(".") || "(root)"} ${parsed.error.issues[0]!.message}`);
  return { ...DEFAULT_TARGETS, ...parsed.data } as Targets;
}
```

`targets.test.ts`: default when absent; overrides merge; unknown key and out-of-range value throw (write three short tests using `mkdtemp`).

- [ ] **Step 4: Implement `metrics.ts`**

```ts
import type { Expected, Level } from "./probe-schema.js";
import type { Targets } from "./targets.js";
import type { ContrastOutcome, Observed, Outcome, SingleOutcome } from "./types.js";

export const isUsable = (o: Observed): o is Expected => o !== "invalid" && o !== "failed";
const isLevel = (o: Observed | Expected): o is Level => typeof o === "number";
const singles = (o: Outcome[]): SingleOutcome[] => o.filter((x): x is SingleOutcome => x.kind === "single");
const contrasts = (o: Outcome[]): ContrastOutcome[] => o.filter((x): x is ContrastOutcome => x.kind === "contrast");
const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function agreement(ss: SingleOutcome[]): { n: number; unusable: number; exact: number; withinOne: number } {
  let n = 0, unusable = 0, exact = 0, withinOne = 0;
  for (const s of ss) {
    const o = s.runs[0];
    if (o === undefined || !isUsable(o)) { unusable++; continue; }
    n++;
    if (s.acceptable.includes(o)) exact++;
    if (o === s.expected || (isLevel(o) && isLevel(s.expected) && Math.abs(o - s.expected) <= 1)) withinOne++;
  }
  return { n, unusable, exact, withinOne };
}

function diffs(ss: SingleOutcome[]): { expected: Level; diff: number }[] {
  const out: { expected: Level; diff: number }[] = [];
  for (const s of ss) {
    const o = s.runs[0];
    if (o !== undefined && isLevel(o) && isLevel(s.expected)) out.push({ expected: s.expected, diff: o - s.expected });
  }
  return out;
}
export const bias = (ss: SingleOutcome[]): { n: number; mean: number | null } => { const d = diffs(ss); return { n: d.length, mean: mean(d.map((x) => x.diff)) }; };
export function biasByExpected(ss: SingleOutcome[]): Record<Level, { n: number; mean: number | null }> {
  const d = diffs(ss);
  const at = (l: Level) => { const xs = d.filter((x) => x.expected === l).map((x) => x.diff); return { n: xs.length, mean: mean(xs) }; };
  return { 1: at(1), 2: at(2), 3: at(3), 4: at(4) };
}

export function spread(ss: SingleOutcome[], cs: ContrastOutcome[] = []): number {
  const seen = new Set<number>();
  for (const s of ss) { const o = s.runs[0]; if (o !== undefined && isLevel(o)) seen.add(o); }
  for (const c of cs) for (const o of Object.values(c.runs[0] ?? {})) if (isLevel(o)) seen.add(o);
  return seen.size;
}

export function notObserved(ss: SingleOutcome[]): { precision: number | null; recall: number | null } {
  let tp = 0, fp = 0, fn = 0;
  for (const s of ss) {
    const o = s.runs[0];
    if (o === undefined || !isUsable(o)) continue;
    if (o === "not_observed" && s.expected === "not_observed") tp++;
    else if (o === "not_observed") fp++;
    else if (s.expected === "not_observed") fn++;
  }
  return { precision: tp + fp ? tp / (tp + fp) : null, recall: tp + fn ? tp / (tp + fn) : null };
}

export function contrast(cs: ContrastOutcome[]): { n: number; usable: number; ordered: number; pairs: number; pairsOrdered: number; gapMet: number; meanGap: number | null; meanRequired: number | null } {
  let usable = 0, ordered = 0, pairs = 0, pairsOrdered = 0, gapMet = 0;
  const gaps: number[] = [], required: number[] = [];
  for (const c of cs) {
    const run = c.runs[0] ?? {};
    const roles = Object.keys(c.expected);
    if (!roles.every((r) => isLevel(run[r] ?? "failed"))) continue;
    usable++;
    let all = true;
    for (const a of roles) for (const b of roles) {
      if (c.expected[a]! <= c.expected[b]!) continue;
      pairs++;
      const gap = (run[a] as number) - (run[b] as number);
      gaps.push(gap); required.push(c.minGap);
      if (gap > 0) pairsOrdered++; else all = false;
      if (gap >= c.minGap) gapMet++;
    }
    if (all) ordered++;
  }
  return { n: cs.length, usable, ordered, pairs, pairsOrdered, gapMet, meanGap: mean(gaps), meanRequired: mean(required) };
}

export function usability(os: Outcome[]): { slots: number; unusable: number; capped: number; dropped: number } {
  let slots = 0, unusable = 0, capped = 0, dropped = 0;
  for (const o of os) {
    capped += o.capped; dropped += o.dropped;
    if (o.kind === "single") for (const r of o.runs) { slots++; if (!isUsable(r)) unusable++; }
    else for (const run of o.runs) for (const r of Object.values(run)) { slots++; if (!isUsable(r)) unusable++; }
  }
  return { slots, unusable, capped, dropped };
}

export function stability(ss: SingleOutcome[]): number | null {
  const vars: number[] = [];
  for (const s of ss) {
    const xs = s.runs.filter(isLevel);
    if (s.runs.length < 2 || xs.length < 2) continue;
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    vars.push(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
  }
  return mean(vars);
}

export function computeMetrics(os: Outcome[]) {
  const ss = singles(os), cs = contrasts(os);
  return { probes: os.length, agreement: agreement(ss), bias: bias(ss), biasByExpected: biasByExpected(ss), spread: spread(ss, cs), notObserved: notObserved(ss), contrast: contrast(cs), usability: usability(os), stability: stability(ss) };
}
export type JudgeMetrics = ReturnType<typeof computeMetrics>;

export function splitMetrics(os: Outcome[], key: "split" | "source" | "drafter"): Record<string, JudgeMetrics> {
  const groups = new Map<string, Outcome[]>();
  for (const o of os) { const k = String(o[key] ?? "none"); groups.set(k, [...(groups.get(k) ?? []), o]); }
  return Object.fromEntries([...groups].map(([k, v]) => [k, computeMetrics(v)]));
}

export function labelFor(m: JudgeMetrics, t: Targets): { label: "PASS" | "WARN" | "FAIL"; reasons: string[] } {
  const fail: string[] = [], warn: string[] = [];
  if (m.contrast.usable > 0 && m.contrast.ordered / m.contrast.usable < t.contrastOrdering) {
    fail.push(`contrast ordering ${m.contrast.ordered} of ${m.contrast.usable} is below ${Math.round(t.contrastOrdering * 100)}%`);
  }
  if (m.bias.mean !== null && Math.abs(m.bias.mean) > t.maxAbsBias) fail.push(`bias ${m.bias.mean.toFixed(2)} levels exceeds ${t.maxAbsBias}`);
  if (m.usability.slots > 0 && 1 - m.usability.unusable / m.usability.slots < t.minUsable) warn.push(`only ${m.usability.slots - m.usability.unusable} of ${m.usability.slots} answers were usable`);
  if (t.exactAgreement !== null && m.agreement.n > 0 && m.agreement.exact / m.agreement.n < t.exactAgreement) warn.push(`exact agreement ${m.agreement.exact} of ${m.agreement.n} is below ${Math.round(t.exactAgreement * 100)}%`);
  return fail.length ? { label: "FAIL", reasons: [...fail, ...warn] } : warn.length ? { label: "WARN", reasons: warn } : { label: "PASS", reasons: [] };
}
```

- [ ] **Step 5: Run to verify it passes.** `pnpm --filter @acr/runtime exec vitest run src/calibration/__tests__/metrics.test.ts src/calibration/__tests__/targets.test.ts` Expected: PASS. If a hand-computed number in a test is wrong, recompute it from the definitions in `docs/superpowers/specs/2026-10-07-evaluator-calibration-design.md` section 5 before touching the implementation.
- [ ] **Step 6: Commit.** `git add services/runtime/src/calibration && git commit -m "[feat] US-0036: calibration metrics, targets and labels"`

## Task 7: Blind cross-judge comparison

**Files:** Create `services/runtime/src/calibration/compare.ts`; Test `services/runtime/src/calibration/__tests__/compare.test.ts`.

**Interfaces:** Produces `type Disagreement = { probeId: string; role: string; a: Observed; b: Observed; aEvidence?: Evidence; bEvidence?: Evidence }`; `compareJudges(a: Outcome[], b: Outcome[]): { pairs: number; meanAbsDiff: number | null; withinOne: number; disagreements: Disagreement[] }`. Consumes Task 5 types.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { compareJudges } from "../compare.js";
import type { ContrastOutcome, SingleOutcome } from "../types.js";

const base = { criterion: "discovery", split: "tune" as const, source: "handwritten" as const, drafter: null, capped: 0, dropped: 0 };
const ev = (role: string, r: string) => [{ role, rationale: r, quotes: ["q"] }];
const single = (id: string, run: SingleOutcome["runs"][number], r = "r"): SingleOutcome =>
  ({ ...base, probeId: id, kind: "single", subject: "p", expected: 3, acceptable: [3], runs: [run], evidence: ev("p", r) });

describe("compareJudges", () => {
  it("pairs by probe and role, reports mean absolute difference, within-one and the disagreements with both rationales", () => {
    const a = [single("x", 3, "A says"), single("y", 1), single("z", "failed")];
    const b = [single("x", 4, "B says"), single("y", 1), single("z", 2)];
    const r = compareJudges(a, b);
    expect(r.pairs).toBe(2);
    expect(r.meanAbsDiff).toBe(0.5);
    expect(r.withinOne).toBe(2);
    expect(r.disagreements.map((d) => d.probeId).sort()).toEqual(["x", "z"]);
    const x = r.disagreements.find((d) => d.probeId === "x")!;
    expect(x.aEvidence?.rationale).toBe("A says"); expect(x.bEvidence?.rationale).toBe("B says");
  });
  it("includes every player of a contrast probe and ignores probes only one judge ran", () => {
    const c = (run: Record<string, 1 | 2 | 3 | 4>): ContrastOutcome => ({ ...base, probeId: "c", kind: "contrast", expected: { x: 4, y: 1 }, minGap: 1, runs: [run], evidence: [...ev("x", "rx"), ...ev("y", "ry")] });
    const r = compareJudges([c({ x: 4, y: 1 }), single("only-a", 2)], [c({ x: 3, y: 1 })]);
    expect(r.pairs).toBe(2);
    expect(r.disagreements).toHaveLength(1);
    expect(r.disagreements[0]!.role).toBe("x");
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `pnpm --filter @acr/runtime exec vitest run src/calibration/__tests__/compare.test.ts` Expected: FAIL.
- [ ] **Step 3: Implement**

```ts
import type { Evidence, Observed, Outcome } from "./types.js";

export type Disagreement = { probeId: string; role: string; a: Observed; b: Observed; aEvidence?: Evidence; bEvidence?: Evidence };
type Entry = { observed: Observed; evidence?: Evidence };

function entries(os: Outcome[]): Map<string, Entry & { probeId: string; role: string }> {
  const m = new Map<string, Entry & { probeId: string; role: string }>();
  for (const o of os) {
    if (o.kind === "single") {
      m.set(`${o.probeId}/${o.subject}`, { probeId: o.probeId, role: o.subject, observed: o.runs[0] ?? "failed", evidence: o.evidence.find((e) => e.role === o.subject) });
    } else {
      for (const role of Object.keys(o.expected)) {
        m.set(`${o.probeId}/${role}`, { probeId: o.probeId, role, observed: o.runs[0]?.[role] ?? "failed", evidence: o.evidence.find((e) => e.role === role) });
      }
    }
  }
  return m;
}

export function compareJudges(a: Outcome[], b: Outcome[]): { pairs: number; meanAbsDiff: number | null; withinOne: number; disagreements: Disagreement[] } {
  const ea = entries(a), eb = entries(b);
  const diffs: number[] = [];
  const disagreements: Disagreement[] = [];
  for (const [key, x] of ea) {
    const y = eb.get(key);
    if (!y) continue;
    if (typeof x.observed === "number" && typeof y.observed === "number") diffs.push(Math.abs(x.observed - y.observed));
    if (x.observed !== y.observed) disagreements.push({ probeId: x.probeId, role: x.role, a: x.observed, b: y.observed, aEvidence: x.evidence, bEvidence: y.evidence });
  }
  return { pairs: diffs.length, meanAbsDiff: diffs.length ? diffs.reduce((p, c) => p + c, 0) / diffs.length : null, withinOne: diffs.filter((d) => d <= 1).length, disagreements };
}
```

- [ ] **Step 4: Run to verify it passes.** Expected: PASS, 2 tests.
- [ ] **Step 5: Commit.** `git add services/runtime/src/calibration && git commit -m "[feat] US-0036: blind cross-judge comparison"`

## Task 8: Report, results files and the `pnpm calibrate` command

**Files:** Create `services/runtime/src/calibration/rubric-hash.ts`, `report.ts`, `cli.ts`, `main.ts`; Modify `services/runtime/package.json` (script `"calibrate": "tsx src/calibration/main.ts"`), root `package.json` (`"calibrate": "pnpm -s --filter @acr/runtime calibrate"`), `.gitignore` (add `data/calibration/`), `README.md`, `CHANGELOG.md`, `docs/EVALUATOR.md`; Test `services/runtime/src/calibration/__tests__/report.test.ts`, `services/runtime/src/calibration/__tests__/cli.test.ts`.

**Interfaces:**
- Produces: `rubricHash(rubrics: Rubric[]): string`; `type CalibrationSummary = { schema: "acr.calibration.summary/1"; scenarioId: string; rubricHash: string; variant: string; judge: { label: string; model: string }; ranAt: string; probes: { total: number; tune: number; holdout: number }; exact: { n: number; of: number }; bias: number | null; contrast: { ordered: number; of: number }; label: "PASS" | "WARN" | "FAIL" }`; `type JudgeReport = { judge: { label: string; model: string; family: string }; outcomes: Outcome[]; metrics: JudgeMetrics; byCriterion: Record<string, JudgeMetrics>; bySplit: Record<string, JudgeMetrics>; bySource: Record<string, JudgeMetrics>; byDrafter: Record<string, JudgeMetrics>; label: { label: "PASS"|"WARN"|"FAIL"; reasons: string[] }; warnings: string[] }`; `type CalibrationRun = { schema: "acr.calibration/1"; scenario: { id: string; version: string }; rubricHash: string; variant: string; startedAt: string; probeCount: number; lint: string[]; judges: JudgeReport[]; comparison: ReturnType<typeof compareJudges> | null }`; `buildJudgeReport(judge: Judge, outcomes: Outcome[], targets: Targets, probes: Probe[]): JudgeReport`; `buildRun(...)`; `renderMarkdown(run: CalibrationRun): string`; `summaryFile(dataDir: string, scenarioId: string, model: string, variant: string): string`; `writeRun(run: CalibrationRun, dataDir: string): Promise<{ dir: string; markdown: string; json: string }>`; `writeSummaries(run: CalibrationRun, dataDir: string): Promise<string[]>`; `type CalibrateDeps = { argv: string[]; stdout: Out; stderr: Out; env: NodeJS.ProcessEnv; repoRoot: string; cwd?: string; signal?: AbortSignal; judges?: Judge[] }`; `runCalibrate(deps: CalibrateDeps): Promise<{ exitCode: number; run?: CalibrationRun }>`; `CALIBRATE_USAGE`.
- Consumes: Tasks 1-7; `findScenarioDir`, `loadEvaluationInput` (`../evaluator/cli.js`); `parseEvalConfig`; `scrubText`, `secretValues`; `isSafeId`.

- [ ] **Step 1: Write the failing report test**

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildJudgeReport, renderMarkdown, summaryFile, writeRun, writeSummaries, type CalibrationRun } from "../report.js";
import { DEFAULT_TARGETS } from "../targets.js";
import type { Probe } from "../probe-schema.js";
import type { SingleOutcome } from "../types.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "acr-cal-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const out = (id: string, expected: 1 | 2 | 3 | 4, run: SingleOutcome["runs"][number]): SingleOutcome =>
  ({ probeId: id, criterion: "discovery", split: "tune", source: "handwritten", drafter: null, capped: 0, dropped: 0, evidence: [], kind: "single", subject: "p", expected, acceptable: [expected], runs: [run] });
const probes = [] as Probe[];
function run(): CalibrationRun {
  const judge = { label: "primary", model: "gemma-4-31b", family: "gemma", provider: { name: "x", async *stream() { yield ""; } } };
  const jr = buildJudgeReport(judge, [out("a", 1, 1), out("b", 4, 3)], DEFAULT_TARGETS, probes);
  return { schema: "acr.calibration/1", scenario: { id: "esc-scope-creep-01", version: "1.2" }, rubricHash: "abc123", variant: "v1", startedAt: "2026-10-08T00:00:00.000Z", probeCount: 2, lint: ["thin set"], judges: [jr], comparison: null };
}

describe("report", () => {
  it("opens with a one-screen summary and names the judge, variant and thinness", () => {
    const md = renderMarkdown(run());
    const head = md.split("\n").slice(0, 25).join("\n");
    expect(head).toMatch(/primary/); expect(head).toMatch(/v1/); expect(head).toMatch(/thin set/);
    expect(head).toMatch(/exact 1 of 2/); expect(head).toMatch(/(PASS|WARN|FAIL)/);
  });
  it("warns when the drafter shares the judge's model family", () => {
    const judge = { label: "primary", model: "gemma-4-31b", family: "gemma", provider: { name: "x", async *stream() { yield ""; } } };
    const drafted = { ...out("a", 1, 1), source: "drafted" as const, drafter: "gemma-4-31b-it" };
    const jr = buildJudgeReport(judge, [drafted], DEFAULT_TARGETS, probes);
    expect(jr.warnings.join(" ")).toMatch(/same model family/);
  });
  it("writes the run exclusively under the data dir with private modes and never overwrites", async () => {
    const r = run();
    const w = await writeRun(r, dir);
    expect((await stat(w.markdown)).mode & 0o777).toBe(0o600);
    expect((await stat(w.dir)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(await readFile(w.json, "utf8")).schema).toBe("acr.calibration/1");
    await expect(writeRun(r, dir)).resolves.toBeDefined(); // a second run gets its own directory
    expect((await readdir(path.join(dir, "esc-scope-creep-01"))).filter((n) => !n.endsWith(".json")).length).toBe(2);
  });
  it("writes one summary file per judge, named from the model, replacing the previous one atomically", async () => {
    const r = run();
    const [file] = await writeSummaries(r, dir);
    expect(file).toBe(summaryFile(dir, "esc-scope-creep-01", "gemma-4-31b", "v1"));
    const s = JSON.parse(await readFile(file!, "utf8"));
    expect(s).toMatchObject({ schema: "acr.calibration.summary/1", rubricHash: "abc123", variant: "v1", exact: { n: 2, of: 2 } });
    await writeSummaries(r, dir);
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `pnpm --filter @acr/runtime exec vitest run src/calibration/__tests__/report.test.ts` Expected: FAIL.

- [ ] **Step 3: Implement `rubric-hash.ts` and `report.ts`.** `rubricHash` = `createHash("sha256").update(JSON.stringify(rubrics)).digest("hex").slice(0, 16)`. `summaryFile(dataDir, scenarioId, model, variant)` = `path.join(dataDir, scenarioId, \`${slug(model)}-${slug(variant)}.json\`)` where `slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "x"`; assert `isSafeId(scenarioId)` first (throw otherwise). `buildJudgeReport` computes `metrics = computeMetrics(outcomes)`, `byCriterion`, `bySplit/bySource/byDrafter = splitMetrics(...)`, `label = labelFor(metrics, targets)`, and warnings: one `same model family` warning per distinct drafter whose `modelFamily(drafter) === judge.family` ("agreement on probes drafted by <drafter> is self-agreement: same model family as the judge"), and `"too few probes"` when `outcomes.length < MIN_SET_PROBES`. `renderMarkdown`: a title, then a summary table per judge (label, model, variant, headline contrast `ordered of usable`, bias with sign, `exact N of M`, `within-one N of M`, usability `N of M usable`, PASS/WARN/FAIL with reasons), the lint warnings, then detail sections (per criterion, by split/source/drafter, bias by expected level, not-observed precision/recall, stability, disagreement table with both rationales and quotes when `comparison` exists). `writeRun`: directory `path.join(dataDir, scenario.id, startedAt-with-colons-replaced)` created with mode `0o700` (`mkdir recursive`; if it exists append `-2`, `-3`), files `calibration-report.md` and `calibration.json` written with `writeFile(..., { flag: "wx", mode: 0o600 })`. `writeSummaries`: for each judge build the `CalibrationSummary` (tune/holdout counts from outcomes, `exact` from `metrics.agreement`, `bias` from `metrics.bias.mean`, `contrast` from `metrics.contrast`), write to `<file>.<pid>.tmp` with mode `0o600` then `rename` over the final name.

- [ ] **Step 4: Run to verify it passes.** Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing CLI test** (`cli.test.ts`)

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCalibrate } from "../cli.js";
import { fakeJudge } from "./fake-judge.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "acr-cal-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const io = () => { const out: string[] = [], err: string[] = []; return { out, err, stdout: { write: (s: string) => out.push(s) }, stderr: { write: (s: string) => err.push(s) } }; };
const criteria = ["discovery", "listening", "negotiation", "commercial_judgement", "stakeholder_management", "team_alignment", "role_clarity"];
const good = (): ReturnType<typeof fakeJudge> => fakeJudge(criteria, ({ transcript, role }) => ({
  discovery: transcript.includes("consider it done") ? 1 : transcript.includes("daily summary report") ? 4 : 3,
  listening: role === "delivery_lead" ? 4 : 1,
  negotiation: transcript.includes("Of course, we will absorb it") || role === "account_manager" ? 1 : 4,
}));
const judge = (p: ReturnType<typeof good>, label = "primary") => ({ label, model: "fake-model", family: "fake", provider: p });
const run = (argv: string[], extra = {}, env: NodeJS.ProcessEnv = {}) => { const o = io(); return runCalibrate({ argv, stdout: o.stdout, stderr: o.stderr, env, repoRoot: REPO, cwd: dir, ...extra }).then((r) => ({ ...r, ...o })); };

describe("pnpm calibrate", () => {
  it("refuses the mock provider when no judge is configured", async () => {
    const r = await run(["--scenario", "scenarios/friday-escalation"]);
    expect(r.exitCode).toBe(2);
    expect(r.err.join("")).toMatch(/mock/);
  });
  it("runs the starter set against injected judges and writes a report and summary", async () => {
    const r = await run(["--scenario", "scenarios/friday-escalation", "--out", dir], { judges: [judge(good())] });
    expect(r.exitCode).toBe(0);
    expect(r.out.join("")).toMatch(/primary/);
    const files = await readdir(path.join(dir, "esc-scope-creep-01"));
    expect(files.some((f) => f.endsWith("-v1.json"))).toBe(true);
  });
  it("runs a second judge blind and compares them", async () => {
    const r = await run(["--scenario", "scenarios/friday-escalation", "--out", dir, "--only", "disc-l1,disc-l3"], { judges: [judge(good()), judge(good(), "second")] });
    expect(r.exitCode).toBe(0);
    expect(r.run?.comparison?.pairs).toBeGreaterThan(0);
  });
  it("--strict exits 1 when a judge FAILs; without it the exit code stays 0", async () => {
    const flat = fakeJudge(criteria, () => Object.fromEntries(criteria.map((c) => [c, 3])));
    expect((await run(["--scenario", "scenarios/friday-escalation", "--out", dir], { judges: [judge(flat)] })).exitCode).toBe(0);
    expect((await run(["--scenario", "scenarios/friday-escalation", "--out", dir, "--strict"], { judges: [judge(flat)] })).exitCode).toBe(1);
  });
  it("keeps partial results when a judge goes down mid-run", async () => {
    const flaky = fakeJudge(criteria, () => ({ discovery: 3 }), (role) => role === "account_manager");
    const r = await run(["--scenario", "scenarios/friday-escalation", "--out", dir], { judges: [judge(flaky)] });
    expect(r.exitCode).toBe(0);
    expect(r.out.join("")).toMatch(/unusable|usable/);
  });
  it("rejects bad options with exit 2", async () => {
    expect((await run(["--scenario", "scenarios/friday-escalation", "--repeat", "99"], { judges: [judge(good())] })).exitCode).toBe(2);
    expect((await run(["--scenario", "scenarios/friday-escalation", "--only", "nope"], { judges: [judge(good())] })).exitCode).toBe(2);
    expect((await run(["--bogus"])).exitCode).toBe(2);
    expect((await run([])).exitCode).toBe(2);
  });
});
```

- [ ] **Step 6: Run to verify it fails.** `pnpm --filter @acr/runtime exec vitest run src/calibration/__tests__/cli.test.ts` Expected: FAIL.

- [ ] **Step 7: Implement `cli.ts` and `main.ts`.** Follow `evaluator/cli.ts` exactly: `parseArgs({ args: deps.argv, allowPositionals: false, strict: true, options: { scenario: {type:"string"}, judge: {type:"string", multiple:true}, variant: {type:"string"}, repeat: {type:"string"}, only: {type:"string"}, criteria: {type:"string"}, out: {type:"string"}, strict: {type:"boolean"}, json: {type:"string"}, help: {type:"boolean"} } })`; errors as `error: <first line>` plus `CALIBRATE_USAGE` on stderr with exit 2; all output through `scrubText(msg, secretValues(deps.env))`; paths resolve against `deps.cwd ?? deps.env.INIT_CWD ?? process.cwd()`; control characters in path flags rejected as in the evaluator. Flow: resolve the scenario directory (`--scenario` is a path relative to cwd, falling back to `repoRoot`); `loadEvaluationInput(dir)` for scenario and rubrics (errors exit 2); `loadProbes` (any `errors` exit 2 listing all of them; no probes exit 2); `loadTargets`; build judges: `deps.judges` if injected (tests), else `[buildPrimaryJudge(env, cfg), ...specs.map(s => buildJudge(parseJudgeSpec(s), env))]` where `--judge` specs give the second judge (at most one `--judge`; a second raises exit 2) and when `--judge` is given without a primary the primary is still built from the environment (a mock environment exits 2 via `CalibrationInputError`). `--repeat` must be a whole number 1..`MAX_REPEAT`; `--only` is comma-separated probe ids; `--criteria all|probe` (default `all`) maps to `allCriteria`; `--variant` default `v1` (validated with `isSafeId`; anything but `v1` is refused until Task 12 lands). Print the planned call count (`probes x players x repeat x judges`) before running. Run each judge with `runJudge` sequentially (judges never see each other's output); wrap each judge's run in try/catch so an unexpected error is reported and the judge's partial outcomes are kept (`runJudge` returns the outcomes gathered so far on abort). Then `buildJudgeReport` per judge, `compareJudges` when two judges, `buildRun`, `writeRun` + `writeSummaries` under `path.resolve(base, values.out ?? "data/calibration")`, print the one-screen summary (first 25 lines of the Markdown) and the report path; `--json -` prints `JSON.stringify(run)` to stdout and moves the narration to stderr. Exit code: 2 for usage/input errors, 1 when `--strict` and any judge label is FAIL, else 0. `main.ts` mirrors `evaluator/main.ts` (load env with `loadLiveEnv`, wire SIGINT/SIGTERM to an `AbortController`, set `process.exitCode`, force-exit after 3 s with an unref'd timer).

- [ ] **Step 8: Run to verify it passes.** `pnpm --filter @acr/runtime exec vitest run src/calibration` Expected: PASS for all calibration tests.

- [ ] **Step 9: Wire the scripts and ignore the output.** Add the two `package.json` scripts, add `data/calibration/` to `.gitignore`, and add a short "Calibration" section to `docs/EVALUATOR.md` (what a probe is, the file format from the spec, how to run `pnpm calibrate`, how to read the summary, the limits from spec section 8), `README.md` (one paragraph and the command) and `CHANGELOG.md` under `[Unreleased]`.

- [ ] **Step 10: Gates for the story** (Global Constraints), then commit and request review.

```bash
git add services/runtime/src/calibration services/runtime/package.json package.json .gitignore README.md CHANGELOG.md docs/EVALUATOR.md
git commit -m "[feat] US-0036: pnpm calibrate with judges, metrics, report and second-judge comparison"
```

---

# Story US-0037: drafting, excerpts, approval, the scaled set

## Task 9: Draft helper, excerpt, approve, assign-splits

**Files:** Create `services/runtime/src/calibration/draft.ts`; Modify `services/runtime/src/calibration/cli.ts` (subcommands `draft`, `excerpt`, `approve`, `assign-splits` as the first positional); Test `services/runtime/src/calibration/__tests__/draft.test.ts`.

**Interfaces:** Produces `draftProbes(i: { scenario: Scenario; rubrics: Rubric[]; drafter: Judge; primary: Judge; allowSameFamily: boolean; criterion?: string; perLevel: number; dir: string; signal?: AbortSignal }): Promise<string[]>` (returns the written draft file paths); `excerptDraft(i: { log: SessionEvent[]; scenario: Scenario; from: number; to: number; subject: string; criterion: string; id: string; dir: string }): Promise<string>`; `approveDraft(i: { dir: string; draftId: string; by: string; expected?: Expected; scenario: Scenario; rubrics: Rubric[]; existing: Probe[]; now: () => Date }): Promise<string>`; `assignSplits(dir: string, probes: Probe[]): Promise<string[]>` (fills only a missing `split`, never changes one). Consumes `extractJson` (`../evaluator/parse.js`), `collectModelReply` (`../agents/model-reply.js`), `modelFamily`, `assignSplit`, `loadProbes`, `ProbeSchema`, `stringify` (`yaml`).

- [ ] **Step 1: Write the failing tests** covering: (a) `draftProbes` refuses a drafter whose family equals the primary judge's family unless `allowSameFamily`, and with the scripted provider returns one draft file per (criterion, level, perLevel) with `source: drafted`, the drafter model recorded, `approved_by: null`, written under `calibration/drafts/` only; a run of `loadProbes` afterwards ignores drafts; a malformed model reply writes nothing for that anchor and reports it; (b) `excerptDraft` builds a draft from `events` seq range with real lines and `source: excerpt`, refusing a subject with fewer than 2 lines and a range that crosses unknown seqs; (c) `approveDraft` refuses a draft with no `expected`, refuses an unknown draft id or a draft id that is not file-safe (`../x`), validates through `ProbeSchema` and the loader's semantic checks, records `approved_by`, `approved_at` (`now().toISOString()`), assigns `split` with `assignSplit(id, existing.length + 1)` when the draft has none, writes `calibration/<id>.yaml` with `wx` (never overwrites an existing probe), and removes the draft; (d) `assignSplits` fills only missing splits and leaves existing ones byte-identical. Use `fakeJudge`-style providers that return `{"transcript":[{"scene":"s2_client_call","role":"delivery_lead","text":"..."}, ...]}` and `mkdtemp` directories.

- [ ] **Step 2: Run to verify they fail.** `pnpm --filter @acr/runtime exec vitest run src/calibration/__tests__/draft.test.ts` Expected: FAIL (module not found).

- [ ] **Step 3: Implement `draft.ts`.** Prompt for a draft (system): the scenario context, the participant role, the criterion with its description and the anchor for the target level verbatim, an instruction to write 4 to 8 lines of dialogue in which the subject's own lines clearly demonstrate exactly that level and no higher, with context lines from the right other roles, scene ids restricted to the scenario's scenes, and JSON-only output `{"transcript":[{"scene","role","text"}]}`; user message names the criterion and level. Reuse `extractJson`; validate each returned line against `LineSchema`; build the draft object with `kind: "single"`, a generated id `draft-<criterion>-l<level>-<n>`, `expected` set from the target level, `source: "drafted"`, `drafter: drafter.model`, `approved_by: null`, `approved_at: null`, no `split`. Write with `stringify` to `calibration/drafts/<id>.yaml` using flag `wx`. Same-family guard: throw `CalibrationInputError` naming both models. `approveDraft` reads the draft through `readTextCapped`/`parse`, requires `expected`, sets approval and split, validates with `ProbeSchema.parse` and the same semantic checks as `loadProbes` (export `checkProbe` from `probe-load.ts` for this), writes the final file with `wx`, then deletes the draft. Add to `cli.ts`: `pnpm calibrate draft --scenario <dir> [--criterion id] [--per-level n] [--drafter label,model,baseUrl] [--allow-same-family]`, `pnpm calibrate excerpt --scenario <dir> --log <session.jsonl> --from <seq> --to <seq> --subject <role> --criterion <id> --id <id>`, `pnpm calibrate approve --scenario <dir> --draft <id> --by <name> [--expected 1|2|3|4|not_observed]`, `pnpm calibrate assign-splits --scenario <dir>`. Subcommands share the option parsing, exit codes and scrubbing of Task 8.

- [ ] **Step 4: Run to verify they pass.** `pnpm --filter @acr/runtime exec vitest run src/calibration` Expected: PASS.
- [ ] **Step 5: Commit.** `git add services/runtime/src/calibration && git commit -m "[feat] US-0037: draft, excerpt, approve and assign-splits for calibration probes"`

## Task 10: Scale the Friday set to 20+ probes (authored data, human approved)

**Files:** Create/Modify `scenarios/friday-escalation/calibration/*.yaml`; Test `services/runtime/src/calibration/__tests__/starter-set.test.ts` (update).

This task needs the owner's judgement for levels and approvals; the agent prepares everything and stops at each approval.

- [ ] **Step 1: Draft candidates with a different-family drafter.** With the local server running and the primary judge Gemma, draft with Nemotron (or Qwen, or the second judge): `pnpm calibrate draft --scenario scenarios/friday-escalation --drafter drafter,nemotron-3-nano-omni-30b-a3b-jangtq4,http://127.0.0.1:1337/v1 --per-level 1`. Expected: draft files under `calibration/drafts/` for every criterion and level, none used by `pnpm calibrate`.
- [ ] **Step 2: Extract at least 5 real excerpts** from saved live showcase logs of demo sessions (`data/sessions/*.jsonl`, demo sessions only): `pnpm calibrate excerpt --scenario scenarios/friday-escalation --log <log> --from <seq> --to <seq> --subject <role> --criterion <id> --id exc-<criterion>-01`. These are drafts with no `expected` yet.
- [ ] **Step 3: Owner review.** Present the drafts and excerpts to the owner with a table (id, criterion, intended level, first lines). The owner edits or discards and assigns the level for every excerpt. Do not approve on the owner's behalf.
- [ ] **Step 4: Approve** each accepted draft: `pnpm calibrate approve --scenario scenarios/friday-escalation --draft <id> --by <owner name>` (add `--expected` for excerpts).
- [ ] **Step 5: Update the starter-set test** into `friday-set.test.ts` asserting at least 20 probes, at least 5 with `source: "excerpt"`, at least 10 holdout, every level 1 to 4 represented at least 3 times across expected levels, and `lintProbeSet` returning no warning about thin sets or mid-heavy levels.
- [ ] **Step 6: Run** `pnpm --filter @acr/runtime exec vitest run src/calibration/__tests__/friday-set.test.ts` Expected: PASS. Gates for the story, then commit and request review.

```bash
git add scenarios/friday-escalation/calibration services/runtime/src/calibration
git commit -m "[feat] US-0037: scale the Friday calibration set to 20+ probes with real excerpts"
```

---

## Task 11: Baseline run and the stage-gate decision (not a code story)

**Files:** Modify `docs/EVALUATOR.md`, `docs/RELEASE_PLAN.md`, `progress.md`.

- [ ] **Step 1: Run the baseline live** (Gemma as primary; add the second judge once `OsaurusAI/Holo3-35B-A3B-JANGTQ4` is served, using its id from `/v1/models`): `NPC_MODEL=gemma-4-31b-it-qat-mxfp4 EVAL_MODEL=gemma-4-31b-it-qat-mxfp4 pnpm calibrate --scenario scenarios/friday-escalation --repeat 3 [--judge second,<holo id>]`. Expected: a report under `data/calibration/esc-scope-creep-01/` and a summary file for each judge.
- [ ] **Step 2: Apply the gate.** The baseline fails if `v1` has a FAIL on contrast ordering or an absolute bias above 0.3 levels (the report's label and reasons say which). Record in `docs/EVALUATOR.md` a "Baseline" table: date, judge, probes (total, tune, holdout, excerpts), exact N of M, within-one N of M, bias, contrast ordered N of M, usability, stability, label, and the decision.
- [ ] **Step 3a (baseline passes):** record "variants not needed: the leniency was in the demo players" in `docs/EVALUATOR.md`, set US-0038 to `Cancelled` in `docs/RELEASE_PLAN.md` with the reason (its ids stay reserved), skip Task 12, continue with Task 13.
- [ ] **Step 3b (baseline fails):** proceed to Task 12.
- [ ] **Step 4: Commit** the docs: `git add docs progress.md && git commit -m "[docs] US-0036: record the evaluator calibration baseline and the stage-gate decision"`.

---

# Story US-0038 (conditional on Step 3b): prompt variants

## Task 12: Variants `v2` and `v3`, and the acceptance report

**Files:** Modify `services/runtime/src/evaluator/config.ts` (new `EVAL_VARIANT`, default `v1`, validated against the known names), `services/runtime/src/evaluator/prompt.ts` (`variantInstructions`), `services/runtime/src/evaluator/evaluate.ts` (pass `config.variant` through), `services/runtime/src/calibration/cli.ts` (allow `--variant v1,v2,v3`, run side by side), `services/runtime/src/calibration/report.ts` (per-variant deltas and the acceptance checklist), `docs/EVALUATOR.md`, `.env.example`; Test `services/runtime/src/evaluator/__tests__/variants.test.ts`, `services/runtime/src/calibration/__tests__/acceptance.test.ts`.

**Interfaces:** Produces `export const VARIANTS = ["v1", "v2", "v3"] as const; type Variant = (typeof VARIANTS)[number]`; `variantInstructions(v: Variant): string` (empty string for `v1`); `EvalConfig.variant: Variant`; `acceptance(baseline: JudgeReport, candidate: JudgeReport, opts: { noise: number; costRatio: number; secondJudge?: { baseline: JudgeReport; candidate: JudgeReport } | null }): { accept: boolean; checks: { name: string; ok: boolean; detail: string }[] }` over the holdout metrics.

- [ ] **Step 1: Write the failing variant tests.**

```ts
import { describe, expect, it } from "vitest";
import { buildParticipantRequest } from "../prompt.js";
import { variantInstructions, VARIANTS } from "../prompt.js";
import { parseEvalConfig } from "../config.js";
import { sampleRubrics, sampleScenario } from "./fixtures.js";

const input = { scenario: sampleScenario(), rubrics: sampleRubrics(), transcript: "t", nonce: "n", maxTokens: 1000, temperature: 0.2, roleId: "alice" };

describe("prompt variants", () => {
  it("v1 is byte-identical to the request built without a variant", () => {
    expect(buildParticipantRequest({ ...input, variant: "v1" })).toEqual(buildParticipantRequest(input));
    expect(variantInstructions("v1")).toBe("");
  });
  it("v2 adds the evidence-first and lower-level tie-break instructions without touching the output schema text", () => {
    const base = buildParticipantRequest(input).system;
    const v2 = buildParticipantRequest({ ...input, variant: "v2" }).system;
    expect(v2.startsWith(base)).toBe(true);
    expect(v2).toMatch(/best quote for each level/i);
    expect(v2).toMatch(/choose the lower/i);
  });
  it("v3 adds the next-level challenge", () => {
    expect(buildParticipantRequest({ ...input, variant: "v3" }).system).toMatch(/what is missing for the next level/i);
  });
  it("EVAL_VARIANT is validated and defaults to v1", () => {
    const ok = parseEvalConfig({}); expect(ok.ok && ok.variant).toBe("v1");
    expect(parseEvalConfig({ EVAL_VARIANT: "v9" }).ok).toBe(false);
    expect([...VARIANTS]).toEqual(["v1", "v2", "v3"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `pnpm --filter @acr/runtime exec vitest run src/evaluator/__tests__/variants.test.ts` Expected: FAIL.
- [ ] **Step 3: Implement.** In `prompt.ts` add

```ts
export const VARIANTS = ["v1", "v2", "v3"] as const;
export type Variant = (typeof VARIANTS)[number];

const V2 = [
  "SCORING METHOD (variant v2). For each criterion, first note the best quote you can find for each level the participant might have reached. Then choose the highest level whose anchor is fully evidenced by a quote.",
  "If you are torn between two levels, choose the lower. A level you cannot support with a quote is not earned.",
].join("\n");
const V3 = [
  V2,
  "NEXT-LEVEL CHALLENGE (variant v3). After choosing a tentative level L, state in your rationale what is missing for the next level, and confirm the quotes show every part of the anchor for L. If they do not, lower the score.",
].join("\n");

export function variantInstructions(v: Variant): string {
  return v === "v2" ? V2 : v === "v3" ? V3 : "";
}
```

`PromptInput` gains `variant?: Variant`; `buildParticipantRequest` returns `{ ...req, system: variantInstructions(v) ? req.system + "\n\n" + variantInstructions(v) : req.system }` (the group request is left unchanged). `EvalConfig` gains `variant: Variant` parsed from `EVAL_VARIANT` (default `v1`, error text names the variable); `evaluateSession` passes `config.variant` into `buildParticipantRequest`. The calibration CLI replaces its `v1`-only guard with the `VARIANTS` check and runs each requested variant by overriding `cfg.variant`, producing one `JudgeReport` per (judge, variant); `renderMarkdown` adds a per-variant delta table on the holdout split. The summary file names already include the variant.
- [ ] **Step 4: Write and pass `acceptance.test.ts`.** Tests: a candidate with higher contrast ordering, lower absolute bias, equal usability, `costRatio` 1.5 and noise 0.2 returns `accept: true` with every check ok; a candidate with a worse ordering, or bias reduced but exact agreement worse by more than `noise`, or `costRatio` above 2, returns `accept: false` naming the failing check; fewer than 10 holdout probes returns `accept: false` with the check "holdout has at least 10 probes"; a second judge whose baseline usability is under `minUsable` is recorded as "second judge not usable" and does not block. Implement `acceptance()` in `report.ts` exactly to the spec's section 7 rule. The result is printed in the report as a checklist for the human decision; nothing switches the default automatically.
- [ ] **Step 5: Run** `pnpm --filter @acr/runtime exec vitest run src/evaluator src/calibration` Expected: PASS. Mock evaluator demos (`pnpm demo --showcase --fast --evaluate`) must stay byte-identical (`v1` default).
- [ ] **Step 6: Live comparison and the default change (human gate).** Run `pnpm calibrate --scenario scenarios/friday-escalation --variant v1,v2 --repeat 3`; read the holdout checklist; if `v2` is not enough, add `v3`. A default change is a separate PR that edits the `v1` default in `config.ts`, carries the before/after holdout table in its description and in `docs/EVALUATOR.md`, and is merged only on the owner's say-so.
- [ ] **Step 7: Gates for the story, commit.**

```bash
git add services/runtime/src/evaluator services/runtime/src/calibration docs/EVALUATOR.md .env.example
git commit -m "[feat] US-0038: evaluator prompt variants v2 and v3 with the acceptance checklist"
```

---

# Story US-0039: the stamp

## Task 13: Calibration stamp on evaluation reports

**Files:** Create `services/runtime/src/calibration/stamp.ts`; Modify `services/runtime/src/evaluator/report-model.ts` (`EvaluatorInfo`), `services/runtime/src/evaluator/provider.ts` (`evaluatorInfo`), `services/runtime/src/evaluator/cli.ts` (look up and attach the stamp), `services/runtime/src/evaluator/report-md.ts` (print the line); Test `services/runtime/src/calibration/__tests__/stamp.test.ts`, `services/runtime/src/evaluator/__tests__/reports.test.ts` (add cases).

**Interfaces:** Produces `type StampState = { state: "not_calibrated" } | { state: "stale"; reason: string } | { state: "ok" | "thin"; summary: CalibrationSummary }`; `lookupCalibration(dataDir: string, scenarioId: string, model: string, variant: string, rubricHash: string): Promise<StampState>` (never throws); `stampLine(s: StampState | undefined): string`; `EvaluatorInfo` gains `variant?: string; rubricHash?: string; calibration?: StampState`.

- [ ] **Step 1: Write the failing stamp tests**

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { lookupCalibration, stampLine } from "../stamp.js";
import { summaryFile, type CalibrationSummary } from "../report.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), "acr-cal-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const summary = (over: Partial<CalibrationSummary> = {}): CalibrationSummary => ({
  schema: "acr.calibration.summary/1", scenarioId: "esc-scope-creep-01", rubricHash: "h1", variant: "v1", judge: { label: "primary", model: "gemma-4-31b" },
  ranAt: "2026-10-08T00:00:00.000Z", probes: { total: 24, tune: 12, holdout: 12 }, exact: { n: 24, of: 24 }, bias: 0.4, contrast: { ordered: 6, of: 8 }, label: "WARN", ...over,
});
async function put(s: CalibrationSummary, raw?: string) {
  const f = summaryFile(dir, s.scenarioId, s.judge.model, s.variant);
  await mkdir(path.dirname(f), { recursive: true });
  await writeFile(f, raw ?? JSON.stringify(s));
}

describe("lookupCalibration", () => {
  it("is not_calibrated when there is no file or the file is corrupt", async () => {
    expect(await lookupCalibration(dir, "esc-scope-creep-01", "gemma-4-31b", "v1", "h1")).toEqual({ state: "not_calibrated" });
    await put(summary(), "{not json");
    expect((await lookupCalibration(dir, "esc-scope-creep-01", "gemma-4-31b", "v1", "h1")).state).toBe("not_calibrated");
  });
  it("is stale when the rubric hash or variant no longer matches the file's", async () => {
    await put(summary());
    const r = await lookupCalibration(dir, "esc-scope-creep-01", "gemma-4-31b", "v1", "OTHER");
    expect(r).toMatchObject({ state: "stale" });
  });
  it("is thin under 20 probes and ok otherwise", async () => {
    await put(summary({ probes: { total: 8, tune: 4, holdout: 4 } }));
    expect((await lookupCalibration(dir, "esc-scope-creep-01", "gemma-4-31b", "v1", "h1")).state).toBe("thin");
    await put(summary());
    expect((await lookupCalibration(dir, "esc-scope-creep-01", "gemma-4-31b", "v1", "h1")).state).toBe("ok");
  });
  it("never throws on hostile scenario ids or models", async () => {
    expect(await lookupCalibration(dir, "../x", "m", "v1", "h")).toEqual({ state: "not_calibrated" });
  });
});

describe("stampLine", () => {
  it("states measurements and never claims accuracy", async () => {
    await put(summary());
    const line = stampLine(await lookupCalibration(dir, "esc-scope-creep-01", "gemma-4-31b", "v1", "h1"));
    expect(line).toMatch(/gemma-4-31b/); expect(line).toMatch(/24 probes/); expect(line).toMatch(/24 of 24 exact/);
    expect(line).toMatch(/6 of 8 contrast/); expect(line).toMatch(/\+0\.4/);
    expect(line).not.toMatch(/accurate|validated|reliable/i);
  });
  it("is explicit when not calibrated, stale or thin", () => {
    expect(stampLine({ state: "not_calibrated" })).toMatch(/not calibrated/i);
    expect(stampLine({ state: "stale", reason: "the rubric changed" })).toMatch(/not calibrated for this rubric version/i);
    expect(stampLine(undefined)).toMatch(/not calibrated/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails.** `pnpm --filter @acr/runtime exec vitest run src/calibration/__tests__/stamp.test.ts` Expected: FAIL.
- [ ] **Step 3: Implement `stamp.ts`**

```ts
import { readFile } from "node:fs/promises";
import { isSafeId } from "@acr/events";
import { MIN_SET_PROBES } from "./probe-load.js";
import { summaryFile, type CalibrationSummary } from "./report.js";

export type StampState =
  | { state: "not_calibrated" }
  | { state: "stale"; reason: string }
  | { state: "ok" | "thin"; summary: CalibrationSummary };

export async function lookupCalibration(dataDir: string, scenarioId: string, model: string, variant: string, rubricHash: string): Promise<StampState> {
  try {
    if (!isSafeId(scenarioId)) return { state: "not_calibrated" };
    const s = JSON.parse(await readFile(summaryFile(dataDir, scenarioId, model, variant), "utf8")) as CalibrationSummary;
    if (s.schema !== "acr.calibration.summary/1" || s.scenarioId !== scenarioId) return { state: "not_calibrated" };
    if (s.rubricHash !== rubricHash) return { state: "stale", reason: "the rubric changed since the last calibration" };
    if (s.variant !== variant) return { state: "stale", reason: "the prompt variant changed since the last calibration" };
    return { state: s.probes.total < MIN_SET_PROBES ? "thin" : "ok", summary: s };
  } catch {
    return { state: "not_calibrated" };
  }
}

export function stampLine(s: StampState | undefined): string {
  if (!s || s.state === "not_calibrated") return "Calibration: not calibrated (no calibration result for this judge, prompt variant and rubric).";
  if (s.state === "stale") return `Calibration: not calibrated for this rubric version (${s.reason}).`;
  const m = s.summary;
  const bias = m.bias === null ? "bias n/a" : `bias ${m.bias >= 0 ? "+" : ""}${m.bias.toFixed(1)} levels`;
  const thin = s.state === "thin" ? " Thin: fewer than 20 probes, treat these numbers as indicative only." : "";
  return `Scored by ${m.judge.model}, prompt ${m.variant}. Calibration on ${m.probes.total} probes (${m.ranAt.slice(0, 10)}): ${m.exact.n} of ${m.exact.of} exact, ${bias}, ${m.contrast.ordered} of ${m.contrast.of} contrast groups ordered.${thin}`;
}
```

- [ ] **Step 4: Run to verify it passes.** Expected: PASS.
- [ ] **Step 5: Wire it into the reports (test first).** Add to `reports.test.ts` cases that call the existing report renderer (`renderReports` from `report-write.ts`) with an `EvaluatorInfo` carrying `calibration: { state: "not_calibrated" }` and then an `ok` summary, asserting the stamp line appears in `index.md`, `group.md` and each personal `<role>.md`, that the JSON files carry an `evaluator` block with `variant`, `rubricHash` and `calibration`, and that an `EvaluatorInfo` without calibration renders "not calibrated". Locate the existing evaluator line first: `grep -n "evaluator" services/runtime/src/evaluator/report-md.ts services/runtime/src/evaluator/report-model.ts` and add `stampLine(info.calibration)` beside each place it prints `evaluator.provider` or `evaluator.model` (footer of personal and group reports, and `index.md`); extend `EvaluatorInfo` and the report JSON builders to include the three fields. In `evaluator/cli.ts`, after the existing `evaluatorInfo(env, cfg, ...)` call, compute `rubricHash(rubrics)` and `await lookupCalibration(path.resolve(base, "data/calibration"), scenario.meta.id, cfg.model ?? env.NPC_MODEL ?? "default", cfg.variant ?? "v1", hash)` and attach `variant`, `rubricHash` and `calibration` to the info; the scripted mock evaluator (`scripted: true`) is stamped `not_calibrated` without a lookup. Mock demos must stay deterministic (counts 29 / 42 / 14 / 15; the stamp line for the scripted evaluator is a constant string).
- [ ] **Step 6: Run** `pnpm --filter @acr/runtime exec vitest run src/evaluator src/calibration` and the three mock demos plus `--showcase --fast --evaluate`. Expected: PASS, counts unchanged. Update `docs/EVALUATOR.md` ("Reading a report": the stamp line and its states), `README.md` and `CHANGELOG.md`.
- [ ] **Step 7: Gates for the story, commit.**

```bash
git add services/runtime/src docs/EVALUATOR.md README.md CHANGELOG.md
git commit -m "[feat] US-0039: calibration stamp on evaluation reports"
```

---

## Self-Review

**Spec coverage:** section 1 (success criteria) to Tasks 8, 11, 13; section 3 (probe format, split, linter) to Tasks 1-3; section 4 (components) to Tasks 1-9; section 5 (metrics, report, labels, `--strict`) to Tasks 6-8; section 6 (drafting, drafter family, excerpts) to Tasks 4, 8, 9, 10; section 7 (stage gate, variants, acceptance) to Tasks 11-12; section 8 (stamp, states, limits) to Tasks 8 (docs) and 13; section 9 (security, data) to Global Constraints, Tasks 1, 8; section 10 (stories and order) to Task 0 and the story headings; section 11 (testing, errors) to every task's tests and Review Focus; section 12 (open points) is carried to Task 11 (Holo3 id) and Task 12 (thresholds, 2x cap). One deliberate timing adjustment to the spec: real excerpts are collected in Task 10 (with the scale-up) rather than in the starter set, because each needs a human-assigned level; the starter set is handwritten and reported as thin.

**Placeholder scan:** the data tasks (Task 3 files) are written in full. Task 9's implementation step and Task 8's CLI step describe composition of already-defined functions with exact flags, exit codes and flow rather than repeating boilerplate identical to `evaluator/cli.ts`; the implementer must follow that file as the pattern and the listed tests as the contract.

**Type consistency:** `Observed`, `Outcome` and `Evidence` (Task 5) are used unchanged in Tasks 6, 7, 8, 13; `JudgeMetrics`, `Targets`, `labelFor` (Task 6) feed `buildJudgeReport` (Task 8) and `acceptance` (Task 12); `CalibrationSummary` and `summaryFile` (Task 8) are the only link between `pnpm calibrate` and the stamp (Task 13); `Judge` (Task 4) is what the runner, drafter and CLI all take.
