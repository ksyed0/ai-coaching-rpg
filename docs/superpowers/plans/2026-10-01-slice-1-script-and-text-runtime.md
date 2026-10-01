# Slice 1: Script Package and Text-Only Runtime — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three people on one LAN can play the Friday Escalation scenario in text from a terminal client against AI-played NPCs, with the Game Master advancing scenes and every turn captured in an event log, all started from one laptop with one command.

**Architecture:** A pnpm monorepo with three packages (`events`, `script`, `adapters`) and one service (`runtime`). The scenario is a YAML folder parsed and validated by `packages/script`; `runtime` hosts a `SessionEngine` that owns an event-sourced log and a scene finite-state machine, an `NpcAgent` per NPC role on the fast path, and a `GameMaster` that runs beside it on a tick. Clients talk to `runtime` over a small WebSocket protocol; the only client in this slice is a terminal program. Model access goes through a `ModelProvider` adapter with a scripted mock (used by every test) and an Anthropic implementation.

**Tech Stack:** Node 22, pnpm 9 workspaces, TypeScript 5 (strict, ESM), Zod 3 (schemas) with `zod-to-json-schema`, `yaml` 2, Vitest 2, `ws` 8, `@anthropic-ai/sdk`, `tsx` for running TypeScript directly, Docker Compose for the one-command start.

**Spec:** `docs/ARCHITECTURE.md` (sections 2, 3, 4, 7, 13) and the product specification (*AI Coaching RPG — Product Specification*, sections 3, 5.3, 5.4, 6). The plan argues from those; executors read both. PlanVisualizer tracking for this slice is `docs/RELEASE_PLAN.md` EPIC-0001 (US-0001 to US-0012); each task below names its story.

## Global Constraints

- Node `>=22`, pnpm `>=9`; `"type": "module"` in every package; TypeScript `strict: true`, `moduleResolution: "NodeNext"`.
- Nothing outside `packages/adapters` imports a provider SDK (`@anthropic-ai/sdk` or any other). Architecture §9 rule 1.
- The scenario on disk is always the YAML package from Spec §6; the parsed form is derived and never saved. Architecture §6.
- Every `id` in a scenario is unique within the scenario (`scenario`, roles, scenes, injects). Spec §6 format rules.
- NPC prompts never contain the rubric, another role's `private_facts` or `brief`, or `hidden` facts the Game Master has not released. Architecture §4 guardrails.
- Participant display names never leave the system in prompts; prompts use role ids. Architecture §4.
- Session state is a projection of the event log; no component keeps authoritative state outside the log. Architecture §3.
- Every event carries `seq` (monotonic per session, starting at 1), `ts` (epoch ms) and `sessionId`.
- A model call with no first token after 4 000 ms yields the persona's `fallback_line` and a `facilitator.alert` event; the session never stalls. Architecture §4.
- No secrets in the repo: `.env` is git-ignored, `.env.example` is committed.
- Commit messages follow `AGENTS.md`: `[TYPE] US-XXXX: imperative description` and reference the story id.
- Tests: Vitest; every package has `pnpm test`; the root `pnpm test` runs all of them; coverage threshold 80% lines per package (`AGENTS.md` §8).

## Review Focus

1. **A scenario folder with a missing or empty `roles/` directory** — `loadScenario` must fail with one error naming the folder, not a stack trace from an undefined iteration. Test added to Task 3.
2. **Two participants claiming the same player role** — the second `join` must be refused with `role_taken`; the first keeps the role. Test added to Task 9.
3. **An utterance arriving while the session is paused** — it must be rejected with `paused`, not appended to the log, and no NPC turn may start. Test added to Task 6.
4. **The model streams nothing and then closes (empty reply)** — the NPC must emit its `fallback_line`, not an empty utterance. Test added to Task 7.
5. **An inject whose `at_minute` is past the scene's `time_box_minutes`** — validation must warn, and at runtime the inject must never fire after the scene exits. Tests added to Task 3 (warning) and Task 8 (never fires).

---

### Task 1: Monorepo scaffold and shared tooling (US-0001)

**Files:**
- Create: `package.json` (modify the one PlanVisualizer bootstrapped — keep its `plan:*`, `memory:*`, `agent:*`, `dashboard:*` scripts and devDependencies; add workspaces and the scripts below)
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `vitest.workspace.ts`
- Create: `.gitignore`, `.env.example`, `.nvmrc`
- Create: `packages/events/package.json`, `packages/events/tsconfig.json`, `packages/events/src/index.ts`
- Create: `packages/events/src/__tests__/smoke.test.ts`

**Interfaces:**
- Produces: the workspace layout every later task assumes: `packages/<name>/src/index.ts` is each package's public surface; packages are imported as `@acr/events`, `@acr/script`, `@acr/adapters`; the service is `@acr/runtime`.

- [ ] **Step 1: Write the workspace files**

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
  - "services/*"
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  }
}
```

`vitest.workspace.ts`:
```ts
export default ["packages/*/vitest.config.ts", "services/*/vitest.config.ts"];
```

`.nvmrc`: `22`

`.gitignore` (append to whatever PlanVisualizer created):
```
node_modules/
dist/
coverage/
.env
*.local
data/sessions/
```

`.env.example`:
```
# Model provider for NPCs and the Game Master. "mock" needs no key.
MODEL_PROVIDER=mock
ANTHROPIC_API_KEY=
NPC_MODEL=claude-sonnet-4-5
GM_MODEL=claude-sonnet-4-5
RUNTIME_PORT=8080
DEPLOYMENT_STAGE=local
```

- [ ] **Step 2: Update the root package.json**

Open `package.json` (PlanVisualizer created it). Set `"name": "ai-coaching-rpg"`, `"private": true`, `"type": "module"`, `"packageManager": "pnpm@9.12.0"`, `"engines": {"node": ">=22"}`. Add to `scripts` (keep the existing PlanVisualizer scripts untouched):
```json
"build": "pnpm -r run build",
"test": "vitest run",
"test:watch": "vitest",
"typecheck": "pnpm -r run typecheck",
"dev:runtime": "pnpm --filter @acr/runtime dev",
"play": "pnpm --filter @acr/runtime play"
```
Add to `devDependencies`: `"typescript": "^5.6.0"`, `"vitest": "^2.1.0"`, `"@vitest/coverage-v8": "^2.1.0"`, `"tsx": "^4.19.0"`, `"@types/node": "^22.7.0"`.

- [ ] **Step 3: Create the first package so the workspace has something to test**

`packages/events/package.json`:
```json
{
  "name": "@acr/events",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "build": "tsc -p tsconfig.json --noEmit",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  }
}
```

`packages/events/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src"] }
```

`packages/events/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], coverage: { provider: "v8", thresholds: { lines: 80 } } },
});
```

`packages/events/src/index.ts`:
```ts
export const EVENTS_PACKAGE = "@acr/events";
```

`packages/events/src/__tests__/smoke.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { EVENTS_PACKAGE } from "../index.js";

describe("workspace smoke", () => {
  it("resolves the package", () => {
    expect(EVENTS_PACKAGE).toBe("@acr/events");
  });
});
```

- [ ] **Step 4: Install and run**

Run: `corepack enable && pnpm install && pnpm test`
Expected: `1 passed` from `packages/events`.

Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git checkout -b feature/EPIC-0001-US-0001-monorepo
git add -A
git commit -m "[chore] US-0001: scaffold pnpm workspace, TypeScript base, Vitest"
```

---

### Task 2: Session events and the state reducer (US-0002)

**Files:**
- Create: `packages/events/src/events.ts`
- Create: `packages/events/src/state.ts`
- Modify: `packages/events/src/index.ts`
- Test: `packages/events/src/__tests__/state.test.ts`

**Interfaces:**
- Produces:
  - `type SessionEvent = EventEnvelope & EventBody` where `EventEnvelope = { seq: number; ts: number; sessionId: string }`
  - `type EventBody` (discriminated on `type`, listed in Step 2)
  - `type SessionState` and `function reduce(state: SessionState, event: SessionEvent): SessionState`
  - `function initialState(): SessionState`
  - `function visibleTranscript(state: SessionState, roleId: string): Utterance[]` — the transcript a role may see (used by the NPC prompt builder)

- [ ] **Step 1: Write the failing reducer tests**

`packages/events/src/__tests__/state.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { initialState, reduce, visibleTranscript, type SessionEvent } from "../index.js";

const env = (seq: number) => ({ seq, ts: 1_000 + seq, sessionId: "s1" });

const started: SessionEvent = {
  ...env(1),
  type: "session.started",
  scenarioId: "esc-scope-creep-01",
  version: "1.2",
  roles: {
    delivery_lead: { kind: "player", participantId: "p1" },
    client_sponsor: { kind: "npc" },
  },
};

describe("reduce", () => {
  it("starts a session and enters the first scene", () => {
    let s = reduce(initialState(), started);
    s = reduce(s, { ...env(2), type: "scene.entered", sceneId: "s1_huddle", participants: ["delivery_lead"] });
    expect(s.status).toBe("running");
    expect(s.currentScene?.id).toBe("s1_huddle");
    expect(s.currentScene?.enteredAt).toBe(1_002);
  });

  it("appends utterances to the transcript with scene and seq", () => {
    let s = reduce(initialState(), started);
    s = reduce(s, { ...env(2), type: "scene.entered", sceneId: "s1_huddle", participants: ["delivery_lead"] });
    s = reduce(s, { ...env(3), type: "utterance", roleId: "delivery_lead", text: "Hi all", channel: "text" });
    expect(s.transcript).toEqual([{ seq: 3, ts: 1_003, sceneId: "s1_huddle", roleId: "delivery_lead", text: "Hi all", channel: "text" }]);
  });

  it("tracks pause and resume", () => {
    let s = reduce(initialState(), started);
    s = reduce(s, { ...env(2), type: "facilitator.command", command: "pause" });
    expect(s.paused).toBe(true);
    s = reduce(s, { ...env(3), type: "facilitator.command", command: "resume" });
    expect(s.paused).toBe(false);
  });

  it("applies NPC goal updates", () => {
    let s = reduce(initialState(), started);
    s = reduce(s, { ...env(2), type: "npc.updated", roleId: "client_sponsor", goals: ["Get a yes"], knowledge: ["CFO asked"] });
    expect(s.npcs.client_sponsor).toEqual({ goals: ["Get a yes"], knowledge: ["CFO asked"], released: [] });
  });

  it("ends the session", () => {
    let s = reduce(initialState(), started);
    s = reduce(s, { ...env(2), type: "session.ended", reason: "script_complete" });
    expect(s.status).toBe("ended");
  });

  it("rejects an event whose seq is not the next one", () => {
    const s = reduce(initialState(), started);
    expect(() => reduce(s, { ...env(5), type: "facilitator.command", command: "pause" })).toThrow(/seq/);
  });
});

describe("visibleTranscript", () => {
  it("shows a role only the scenes it participated in", () => {
    let s = reduce(initialState(), started);
    s = reduce(s, { ...env(2), type: "scene.entered", sceneId: "s1_huddle", participants: ["delivery_lead"] });
    s = reduce(s, { ...env(3), type: "utterance", roleId: "delivery_lead", text: "internal only", channel: "text" });
    s = reduce(s, { ...env(4), type: "scene.exited", sceneId: "s1_huddle", reason: "facilitator_advance" });
    s = reduce(s, { ...env(5), type: "scene.entered", sceneId: "s2_client_call", participants: ["delivery_lead", "client_sponsor"] });
    s = reduce(s, { ...env(6), type: "utterance", roleId: "delivery_lead", text: "Hi Priya", channel: "text" });
    expect(visibleTranscript(s, "client_sponsor").map((u) => u.text)).toEqual(["Hi Priya"]);
    expect(visibleTranscript(s, "delivery_lead").map((u) => u.text)).toEqual(["internal only", "Hi Priya"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @acr/events test`
Expected: FAIL — `initialState` and `reduce` are not exported.

- [ ] **Step 3: Write the event types**

`packages/events/src/events.ts`:
```ts
export type RoleKind = "player" | "npc";
export type Channel = "voice" | "text";
export type ExitReason = "time_box_elapsed" | "facilitator_advance" | "gm_detects";
export type FacilitatorCommand =
  | { command: "pause" }
  | { command: "resume" }
  | { command: "advance" }
  | { command: "fire_inject"; injectId: string }
  | { command: "whisper"; roleId: string; text: string }
  | { command: "set_npc_stance"; roleId: string; goals: string[] };

export type EventEnvelope = { seq: number; ts: number; sessionId: string };

export type EventBody =
  | { type: "session.started"; scenarioId: string; version: string; roles: Record<string, { kind: RoleKind; participantId?: string }> }
  | { type: "scene.entered"; sceneId: string; participants: string[] }
  | { type: "scene.exited"; sceneId: string; reason: ExitReason }
  | { type: "utterance"; roleId: string; text: string; channel: Channel }
  | { type: "inject.fired"; injectId: string; sceneId: string; to: string[]; content: string }
  | { type: "npc.updated"; roleId: string; goals: string[]; knowledge: string[]; released?: string[] }
  | { type: "gm.decision"; sceneId: string; condition: string; verdict: boolean; reasoning: string }
  | ({ type: "facilitator.command" } & FacilitatorCommand)
  | { type: "facilitator.alert"; level: "info" | "warning"; message: string }
  | { type: "session.ended"; reason: "script_complete" | "facilitator_end" };

export type SessionEvent = EventEnvelope & EventBody;
export type EventType = EventBody["type"];
```

- [ ] **Step 4: Write the reducer**

`packages/events/src/state.ts`:
```ts
import type { RoleKind, SessionEvent, Channel } from "./events.js";

export type Utterance = { seq: number; ts: number; sceneId: string | null; roleId: string; text: string; channel: Channel };
export type NpcState = { goals: string[]; knowledge: string[]; released: string[] };

export type SessionState = {
  status: "idle" | "running" | "ended";
  lastSeq: number;
  scenarioId: string | null;
  version: string | null;
  roles: Record<string, { kind: RoleKind; participantId?: string }>;
  currentScene: { id: string; enteredAt: number; participants: string[] } | null;
  sceneHistory: { id: string; participants: string[] }[];
  paused: boolean;
  transcript: Utterance[];
  injectsFired: string[];
  npcs: Record<string, NpcState>;
};

export function initialState(): SessionState {
  return {
    status: "idle", lastSeq: 0, scenarioId: null, version: null, roles: {},
    currentScene: null, sceneHistory: [], paused: false, transcript: [], injectsFired: [], npcs: {},
  };
}

export function reduce(state: SessionState, e: SessionEvent): SessionState {
  if (e.seq !== state.lastSeq + 1) throw new Error(`event seq ${e.seq} out of order; expected ${state.lastSeq + 1}`);
  const s: SessionState = { ...state, lastSeq: e.seq };
  switch (e.type) {
    case "session.started":
      return { ...s, status: "running", scenarioId: e.scenarioId, version: e.version, roles: e.roles };
    case "scene.entered":
      return { ...s, currentScene: { id: e.sceneId, enteredAt: e.ts, participants: e.participants },
        sceneHistory: [...s.sceneHistory, { id: e.sceneId, participants: e.participants }] };
    case "scene.exited":
      return { ...s, currentScene: null };
    case "utterance":
      return { ...s, transcript: [...s.transcript, { seq: e.seq, ts: e.ts, sceneId: s.currentScene?.id ?? null, roleId: e.roleId, text: e.text, channel: e.channel }] };
    case "inject.fired":
      return { ...s, injectsFired: [...s.injectsFired, e.injectId] };
    case "npc.updated": {
      const prev = s.npcs[e.roleId] ?? { goals: [], knowledge: [], released: [] };
      return { ...s, npcs: { ...s.npcs, [e.roleId]: { goals: e.goals, knowledge: e.knowledge, released: e.released ?? prev.released } } };
    }
    case "facilitator.command":
      if (e.command === "pause") return { ...s, paused: true };
      if (e.command === "resume") return { ...s, paused: false };
      return s;
    case "gm.decision":
    case "facilitator.alert":
      return s;
    case "session.ended":
      return { ...s, status: "ended", currentScene: null };
  }
}

export function visibleTranscript(state: SessionState, roleId: string): Utterance[] {
  const visibleScenes = new Set(state.sceneHistory.filter((sc) => sc.participants.includes(roleId)).map((sc) => sc.id));
  return state.transcript.filter((u) => u.sceneId !== null && visibleScenes.has(u.sceneId));
}
```

`packages/events/src/index.ts`:
```ts
export * from "./events.js";
export * from "./state.js";
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @acr/events test`
Expected: 7 passed.

- [ ] **Step 6: Commit**

```bash
git add packages/events
git commit -m "[feat] US-0002: session event types and state reducer"
```

---

### Task 3: Scenario schema, loader and validator (US-0003)

**Files:**
- Create: `packages/script/package.json`, `packages/script/tsconfig.json`, `packages/script/vitest.config.ts` (copy the three from `packages/events`, with the name `@acr/script` and a dependency `"@acr/events": "workspace:*"`, plus dependencies `"zod": "^3.23.0"`, `"yaml": "^2.5.0"`, `"zod-to-json-schema": "^3.23.0"`)
- Create: `packages/script/src/schema.ts`
- Create: `packages/script/src/load.ts`
- Create: `packages/script/src/validate.ts`
- Create: `packages/script/src/index.ts`
- Create: `packages/script/src/__tests__/fixtures/minimal/scenario.yaml`, `.../roles/host.yaml`, `.../roles/guest.yaml`, `.../script.yaml`
- Test: `packages/script/src/__tests__/load.test.ts`, `packages/script/src/__tests__/validate.test.ts`

**Interfaces:**
- Produces:
  - Zod schemas `ScenarioMetaSchema`, `RoleSchema`, `SceneSchema`, `ScriptSchema`, `ScenarioSchema` and inferred types `ScenarioMeta`, `Role`, `PlayerRole`, `NpcRole`, `Scene`, `Inject`, `ExitCondition`, `Scenario`
  - `loadScenario(dir: string): Promise<Scenario>` — reads `scenario.yaml`, `roles/*.yaml`, `script.yaml`; throws `ScenarioLoadError` with a one-line `message` naming the file and the problem
  - `validateScenario(s: Scenario): { errors: string[]; warnings: string[] }`
  - `scenarioJsonSchema: object` — JSON Schema for editors
- Consumes: nothing from other tasks.

- [ ] **Step 1: Write the fixture scenario**

`packages/script/src/__tests__/fixtures/minimal/scenario.yaml`:
```yaml
id: minimal-01
title: Minimal
version: "0.1"
audience: Tests
duration_minutes: 10
players: { min: 1, max: 2 }
context: A two-person check-in.
learning_objectives:
  - id: LO1
    statement: Say hello clearly
    rubric_criteria: [clarity]
rubrics: [test_rubric]
facilitator_notes: none
```

`.../roles/host.yaml`:
```yaml
id: host
type: player
brief: You are hosting the check-in.
private_facts:
  - You have five minutes
```

`.../roles/guest.yaml`:
```yaml
id: guest
name: Sam
type: npc
title: Guest
persona: Friendly and brief.
goals:
  - Be welcomed
knowledge:
  - The meeting is a check-in
hidden:
  - Sam is leaving the company next month
guardrails:
  - Stay friendly
fallback_line: Sorry, could you say that again?
voice: { style: warm, pace: medium }
```

`.../script.yaml`:
```yaml
scenes:
  - id: s1_open
    title: Opening
    goal: Exchange greetings
    participants: [host, guest]
    time_box_minutes: 2
    injects:
      - id: late_inject
        at_minute: 1
        to: [guest]
        content: "Sam remembers an urgent email."
        effect: { goals_add: ["Leave early"] }
    exit_when:
      any_of:
        - time_box_elapsed
        - facilitator_advance
        - gm_detects: "both parties have said hello"
  - id: s2_close
    title: Close
    goal: Say goodbye
    participants: [host, guest]
    time_box_minutes: 1
    exit_when: { any_of: [time_box_elapsed, facilitator_advance] }
```

- [ ] **Step 2: Write the failing loader and validator tests**

`packages/script/src/__tests__/load.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadScenario, ScenarioLoadError } from "../index.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("loadScenario", () => {
  it("loads the minimal fixture", async () => {
    const s = await loadScenario(path.join(fixtures, "minimal"));
    expect(s.meta.id).toBe("minimal-01");
    expect(Object.keys(s.roles).sort()).toEqual(["guest", "host"]);
    expect(s.script.scenes.map((sc) => sc.id)).toEqual(["s1_open", "s2_close"]);
    const guest = s.roles.guest;
    expect(guest.type).toBe("npc");
    if (guest.type === "npc") expect(guest.fallback_line).toMatch(/say that again/);
  });

  it("fails with one message when roles/ is missing", async () => {
    await expect(loadScenario(path.join(fixtures, "no-roles"))).rejects.toBeInstanceOf(ScenarioLoadError);
    await expect(loadScenario(path.join(fixtures, "no-roles"))).rejects.toThrow(/roles\/ directory/);
  });

  it("fails naming the file when a role file is invalid", async () => {
    await expect(loadScenario(path.join(fixtures, "bad-role"))).rejects.toThrow(/roles\/broken\.yaml/);
  });
});
```

Create the two extra fixtures: `fixtures/no-roles/` containing only the `scenario.yaml` and `script.yaml` copied from `minimal` (no `roles/`), and `fixtures/bad-role/` as a copy of `minimal` plus `roles/broken.yaml` containing `id: broken` and `type: wizard`.

`packages/script/src/__tests__/validate.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadScenario, validateScenario } from "../index.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("validateScenario", () => {
  it("passes the minimal fixture with no errors", async () => {
    const s = await loadScenario(path.join(fixtures, "minimal"));
    expect(validateScenario(s).errors).toEqual([]);
  });

  it("errors on a scene participant that is not a role", async () => {
    const s = await loadScenario(path.join(fixtures, "minimal"));
    s.script.scenes[0].participants.push("ghost");
    expect(validateScenario(s).errors).toContain("scene s1_open: participant 'ghost' is not a role");
  });

  it("errors on duplicate inject ids across scenes", async () => {
    const s = await loadScenario(path.join(fixtures, "minimal"));
    s.script.scenes[1].injects = [{ ...s.script.scenes[0].injects![0] }];
    expect(validateScenario(s).errors).toContain("inject id 'late_inject' is used more than once");
  });

  it("warns when an inject fires after the scene time box", async () => {
    const s = await loadScenario(path.join(fixtures, "minimal"));
    s.script.scenes[0].injects![0].at_minute = 5;
    expect(validateScenario(s).warnings).toContain("scene s1_open: inject 'late_inject' at minute 5 is after the 2 minute time box");
  });

  it("warns on a learning objective with no rubric criteria", async () => {
    const s = await loadScenario(path.join(fixtures, "minimal"));
    s.meta.learning_objectives[0].rubric_criteria = [];
    expect(validateScenario(s).warnings).toContain("learning objective LO1 maps to no rubric criteria");
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm install && pnpm --filter @acr/script test`
Expected: FAIL — module `../index.js` has no exports.

- [ ] **Step 4: Write the schema**

`packages/script/src/schema.ts`:
```ts
import { z } from "zod";

const Id = z.string().regex(/^[a-z0-9_\-]+$/, "ids are lowercase letters, digits, _ or -");

export const LearningObjectiveSchema = z.object({
  id: z.string(), statement: z.string(), rubric_criteria: z.array(z.string()),
});

export const ScenarioMetaSchema = z.object({
  id: Id, title: z.string(), version: z.string(), audience: z.string().default(""),
  duration_minutes: z.number().int().positive(),
  players: z.object({ min: z.number().int().min(1), max: z.number().int().min(1) }),
  context: z.string(),
  learning_objectives: z.array(LearningObjectiveSchema).default([]),
  rubrics: z.array(z.string()).default([]),
  facilitator_notes: z.string().default(""),
});

export const PlayerRoleSchema = z.object({
  id: Id, type: z.literal("player"), brief: z.string(), private_facts: z.array(z.string()).default([]),
});

export const NpcRoleSchema = z.object({
  id: Id, type: z.literal("npc"), name: z.string(), title: z.string().default(""),
  persona: z.string(), goals: z.array(z.string()), knowledge: z.array(z.string()).default([]),
  hidden: z.array(z.string()).default([]), guardrails: z.array(z.string()).default([]),
  fallback_line: z.string().default("Sorry, give me a moment."),
  voice: z.object({ style: z.string().default("neutral"), pace: z.string().default("medium") }).default({}),
});

export const RoleSchema = z.discriminatedUnion("type", [PlayerRoleSchema, NpcRoleSchema]);

export const InjectSchema = z.object({
  id: Id, at_minute: z.number().min(0).optional(), to: z.array(Id).min(1), content: z.string(),
  effect: z.object({ goals_add: z.array(z.string()).optional(), knowledge_add: z.array(z.string()).optional() }).optional(),
});

export const ExitConditionSchema = z.union([
  z.literal("time_box_elapsed"), z.literal("facilitator_advance"), z.object({ gm_detects: z.string() }),
]);

export const SceneSchema = z.object({
  id: Id, title: z.string(), goal: z.string(), participants: z.array(Id).min(1),
  time_box_minutes: z.number().positive(), opening_inject: Id.optional(),
  injects: z.array(InjectSchema).optional(),
  exit_when: z.object({ any_of: z.array(ExitConditionSchema).min(1) }),
});

export const ScriptSchema = z.object({ scenes: z.array(SceneSchema).min(1) });

export const ScenarioSchema = z.object({
  meta: ScenarioMetaSchema, roles: z.record(RoleSchema), script: ScriptSchema,
});

export type ScenarioMeta = z.infer<typeof ScenarioMetaSchema>;
export type PlayerRole = z.infer<typeof PlayerRoleSchema>;
export type NpcRole = z.infer<typeof NpcRoleSchema>;
export type Role = z.infer<typeof RoleSchema>;
export type Inject = z.infer<typeof InjectSchema>;
export type ExitCondition = z.infer<typeof ExitConditionSchema>;
export type Scene = z.infer<typeof SceneSchema>;
export type Script = z.infer<typeof ScriptSchema>;
export type Scenario = z.infer<typeof ScenarioSchema>;
```

- [ ] **Step 5: Write the loader**

`packages/script/src/load.ts`:
```ts
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import { ZodError } from "zod";
import { RoleSchema, ScenarioMetaSchema, ScriptSchema, type Role, type Scenario } from "./schema.js";

export class ScenarioLoadError extends Error {
  constructor(message: string) { super(message); this.name = "ScenarioLoadError"; }
}

async function readYaml(file: string): Promise<unknown> {
  let text: string;
  try { text = await readFile(file, "utf8"); }
  catch { throw new ScenarioLoadError(`missing file ${file}`); }
  try { return parse(text); }
  catch (err) { throw new ScenarioLoadError(`${file}: ${(err as Error).message}`); }
}

function parseWith<T>(schema: { parse(v: unknown): T }, value: unknown, label: string): T {
  try { return schema.parse(value); }
  catch (err) {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      throw new ScenarioLoadError(`${label}: ${first.path.join(".") || "(root)"} ${first.message}`);
    }
    throw err;
  }
}

export async function loadScenario(dir: string): Promise<Scenario> {
  const meta = parseWith(ScenarioMetaSchema, await readYaml(path.join(dir, "scenario.yaml")), "scenario.yaml");
  const rolesDir = path.join(dir, "roles");
  try { if (!(await stat(rolesDir)).isDirectory()) throw new Error(); }
  catch { throw new ScenarioLoadError(`${dir}: roles/ directory is missing`); }
  const files = (await readdir(rolesDir)).filter((f) => f.endsWith(".yaml")).sort();
  if (files.length === 0) throw new ScenarioLoadError(`${dir}: roles/ directory is empty`);
  const roles: Record<string, Role> = {};
  for (const f of files) {
    const role = parseWith(RoleSchema, await readYaml(path.join(rolesDir, f)), `roles/${f}`);
    if (roles[role.id]) throw new ScenarioLoadError(`roles/${f}: role id '${role.id}' is already defined`);
    roles[role.id] = role;
  }
  const script = parseWith(ScriptSchema, await readYaml(path.join(dir, "script.yaml")), "script.yaml");
  return { meta, roles, script };
}
```

- [ ] **Step 6: Write the validator and the index**

`packages/script/src/validate.ts`:
```ts
import type { Scenario } from "./schema.js";

export function validateScenario(s: Scenario): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const roleIds = new Set(Object.keys(s.roles));
  const sceneIds = new Set<string>();
  const injectIds = new Map<string, number>();

  for (const scene of s.script.scenes) {
    if (sceneIds.has(scene.id)) errors.push(`scene id '${scene.id}' is used more than once`);
    sceneIds.add(scene.id);
    for (const p of scene.participants) if (!roleIds.has(p)) errors.push(`scene ${scene.id}: participant '${p}' is not a role`);
    for (const inj of scene.injects ?? []) {
      injectIds.set(inj.id, (injectIds.get(inj.id) ?? 0) + 1);
      for (const t of inj.to) if (!roleIds.has(t)) errors.push(`scene ${scene.id}: inject '${inj.id}' targets unknown role '${t}'`);
      if (inj.at_minute !== undefined && inj.at_minute > scene.time_box_minutes)
        warnings.push(`scene ${scene.id}: inject '${inj.id}' at minute ${inj.at_minute} is after the ${scene.time_box_minutes} minute time box`);
    }
    if (scene.opening_inject && !(scene.injects ?? []).some((i) => i.id === scene.opening_inject))
      errors.push(`scene ${scene.id}: opening_inject '${scene.opening_inject}' is not defined in its injects`);
  }
  for (const [id, n] of injectIds) if (n > 1) errors.push(`inject id '${id}' is used more than once`);

  const playerCount = Object.values(s.roles).filter((r) => r.type === "player").length;
  if (playerCount < s.meta.players.min) errors.push(`only ${playerCount} player roles but players.min is ${s.meta.players.min}`);
  for (const lo of s.meta.learning_objectives)
    if (lo.rubric_criteria.length === 0) warnings.push(`learning objective ${lo.id} maps to no rubric criteria`);

  return { errors, warnings };
}
```

`packages/script/src/index.ts`:
```ts
import { zodToJsonSchema } from "zod-to-json-schema";
import { ScenarioSchema } from "./schema.js";
export * from "./schema.js";
export * from "./load.js";
export * from "./validate.js";
export const scenarioJsonSchema = zodToJsonSchema(ScenarioSchema, "Scenario");
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @acr/script test`
Expected: 8 passed.

- [ ] **Step 8: Commit**

```bash
git add packages/script
git commit -m "[feat] US-0003: scenario schema, YAML loader and validator"
```

---

### Task 4: Scene finite-state machine (US-0004)

**Files:**
- Create: `packages/script/src/fsm.ts`
- Modify: `packages/script/src/index.ts` (add `export * from "./fsm.js";`)
- Test: `packages/script/src/__tests__/fsm.test.ts`

**Interfaces:**
- Produces:
  - `type ExitContext = { elapsedMs: number; facilitatorAdvance: boolean; gmVerdicts: Record<string, boolean> }` — `gmVerdicts` keyed by the `gm_detects` condition text
  - `evaluateExit(scene: Scene, ctx: ExitContext): ExitReason | null`
  - `nextSceneId(script: Script, currentId: string): string | null`
  - `dueInjects(scene: Scene, elapsedMs: number, alreadyFired: string[]): Inject[]`
- Consumes: `Scene`, `Script`, `Inject` from Task 3; `ExitReason` from Task 2.

- [ ] **Step 1: Write the failing tests**

`packages/script/src/__tests__/fsm.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { dueInjects, evaluateExit, nextSceneId, type Scene, type Script } from "../index.js";

const scene: Scene = {
  id: "s1", title: "t", goal: "g", participants: ["a"], time_box_minutes: 2,
  injects: [
    { id: "i1", at_minute: 1, to: ["a"], content: "one" },
    { id: "i0", to: ["a"], content: "manual only" },
  ],
  exit_when: { any_of: ["time_box_elapsed", "facilitator_advance", { gm_detects: "done" }] },
};
const script: Script = { scenes: [scene, { ...scene, id: "s2" }] };

describe("evaluateExit", () => {
  it("returns null while nothing has happened", () => {
    expect(evaluateExit(scene, { elapsedMs: 10_000, facilitatorAdvance: false, gmVerdicts: {} })).toBeNull();
  });
  it("exits on the time box", () => {
    expect(evaluateExit(scene, { elapsedMs: 120_000, facilitatorAdvance: false, gmVerdicts: {} })).toBe("time_box_elapsed");
  });
  it("exits on facilitator advance", () => {
    expect(evaluateExit(scene, { elapsedMs: 0, facilitatorAdvance: true, gmVerdicts: {} })).toBe("facilitator_advance");
  });
  it("exits on a true GM verdict for its own condition", () => {
    expect(evaluateExit(scene, { elapsedMs: 0, facilitatorAdvance: false, gmVerdicts: { done: true } })).toBe("gm_detects");
    expect(evaluateExit(scene, { elapsedMs: 0, facilitatorAdvance: false, gmVerdicts: { other: true } })).toBeNull();
  });
  it("ignores a time box when the scene does not list it", () => {
    const s = { ...scene, exit_when: { any_of: ["facilitator_advance" as const] } };
    expect(evaluateExit(s, { elapsedMs: 999_999, facilitatorAdvance: false, gmVerdicts: {} })).toBeNull();
  });
});

describe("nextSceneId", () => {
  it("walks the script in order and ends with null", () => {
    expect(nextSceneId(script, "s1")).toBe("s2");
    expect(nextSceneId(script, "s2")).toBeNull();
  });
});

describe("dueInjects", () => {
  it("returns timed injects whose minute has passed and were not fired", () => {
    expect(dueInjects(scene, 59_000, []).map((i) => i.id)).toEqual([]);
    expect(dueInjects(scene, 60_000, []).map((i) => i.id)).toEqual(["i1"]);
    expect(dueInjects(scene, 60_000, ["i1"]).map((i) => i.id)).toEqual([]);
  });
  it("never returns injects with no at_minute", () => {
    expect(dueInjects(scene, 999_999, []).map((i) => i.id)).not.toContain("i0");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @acr/script test fsm`
Expected: FAIL — `evaluateExit` is not exported.

- [ ] **Step 3: Write the FSM**

`packages/script/src/fsm.ts`:
```ts
import type { ExitReason } from "@acr/events";
import type { Inject, Scene, Script } from "./schema.js";

export type ExitContext = { elapsedMs: number; facilitatorAdvance: boolean; gmVerdicts: Record<string, boolean> };

export function evaluateExit(scene: Scene, ctx: ExitContext): ExitReason | null {
  for (const cond of scene.exit_when.any_of) {
    if (cond === "facilitator_advance" && ctx.facilitatorAdvance) return "facilitator_advance";
    if (cond === "time_box_elapsed" && ctx.elapsedMs >= scene.time_box_minutes * 60_000) return "time_box_elapsed";
    if (typeof cond === "object" && ctx.gmVerdicts[cond.gm_detects] === true) return "gm_detects";
  }
  return null;
}

export function nextSceneId(script: Script, currentId: string): string | null {
  const i = script.scenes.findIndex((s) => s.id === currentId);
  return i >= 0 && i + 1 < script.scenes.length ? script.scenes[i + 1].id : null;
}

export function dueInjects(scene: Scene, elapsedMs: number, alreadyFired: string[]): Inject[] {
  return (scene.injects ?? []).filter(
    (i) => i.at_minute !== undefined && elapsedMs >= i.at_minute * 60_000 && !alreadyFired.includes(i.id),
  );
}
```

Add `export * from "./fsm.js";` to `packages/script/src/index.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @acr/script test`
Expected: 16 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/script
git commit -m "[feat] US-0004: scene FSM, exit evaluation and due injects"
```

---

### Task 5: ModelProvider adapter with mock and Anthropic implementations (US-0005)

**Files:**
- Create: `packages/adapters/package.json`, `tsconfig.json`, `vitest.config.ts` (as Task 3, name `@acr/adapters`, dependencies `"@anthropic-ai/sdk": "^0.30.0"`)
- Create: `packages/adapters/src/model/types.ts`
- Create: `packages/adapters/src/model/mock.ts`
- Create: `packages/adapters/src/model/anthropic.ts`
- Create: `packages/adapters/src/model/contract.ts`
- Create: `packages/adapters/src/model/select.ts`
- Create: `packages/adapters/src/index.ts`
- Test: `packages/adapters/src/model/__tests__/mock.test.ts`, `packages/adapters/src/model/__tests__/anthropic.test.ts`

**Interfaces:**
- Produces:
  - `type ChatMessage = { role: "user" | "assistant"; content: string }`
  - `type ChatRequest = { system: string; messages: ChatMessage[]; maxTokens: number; model?: string; cacheSystem?: boolean }`
  - `interface ModelProvider { name: string; stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<string> }`
  - `class MockModelProvider implements ModelProvider` with `constructor(script: Array<string | ((req: ChatRequest) => string)> = [])`, `calls: ChatRequest[]`, and a `defaultReply` of `"[mock reply]"` once the script is exhausted
  - `class AnthropicModelProvider implements ModelProvider` with `constructor(opts: { apiKey: string; model: string })`
  - `modelProviderContract(make: () => ModelProvider)` — a Vitest suite factory every implementation runs
  - `selectModelProvider(env: NodeJS.ProcessEnv, role: "npc" | "gm"): ModelProvider`

- [ ] **Step 1: Write the contract suite and the mock test**

`packages/adapters/src/model/contract.ts`:
```ts
import { describe, expect, it } from "vitest";
import type { ModelProvider } from "./types.js";

export function modelProviderContract(make: () => ModelProvider): void {
  describe(`ModelProvider contract: ${make().name}`, () => {
    it("streams at least one non-empty chunk for a simple request", async () => {
      const p = make();
      const chunks: string[] = [];
      for await (const c of p.stream({ system: "Reply with the single word OK.", messages: [{ role: "user", content: "Ready?" }], maxTokens: 16 })) chunks.push(c);
      expect(chunks.join("").trim().length).toBeGreaterThan(0);
    });
    it("stops when the signal aborts", async () => {
      const p = make();
      const ac = new AbortController();
      ac.abort();
      const chunks: string[] = [];
      try { for await (const c of p.stream({ system: "x", messages: [{ role: "user", content: "y" }], maxTokens: 16 }, ac.signal)) chunks.push(c); }
      catch { /* an abort error is acceptable */ }
      expect(chunks.join("").length).toBeLessThan(2_000);
    });
  });
}
```

`packages/adapters/src/model/__tests__/mock.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { MockModelProvider } from "../mock.js";
import { modelProviderContract } from "../contract.js";

modelProviderContract(() => new MockModelProvider(["OK"]));

describe("MockModelProvider", () => {
  it("replays scripted replies in order, then the default", async () => {
    const p = new MockModelProvider(["one", (req) => `echo:${req.messages.at(-1)?.content}`]);
    const read = async () => { let s = ""; for await (const c of p.stream({ system: "", messages: [{ role: "user", content: "hi" }], maxTokens: 8 })) s += c; return s; };
    expect(await read()).toBe("one");
    expect(await read()).toBe("echo:hi");
    expect(await read()).toBe("[mock reply]");
    expect(p.calls).toHaveLength(3);
  });
  it("streams word by word", async () => {
    const p = new MockModelProvider(["two words"]);
    const chunks: string[] = [];
    for await (const c of p.stream({ system: "", messages: [], maxTokens: 8 })) chunks.push(c);
    expect(chunks).toEqual(["two ", "words"]);
  });
});
```

`packages/adapters/src/model/__tests__/anthropic.test.ts` (runs only with a key):
```ts
import { describe, it } from "vitest";
import { AnthropicModelProvider } from "../anthropic.js";
import { modelProviderContract } from "../contract.js";

const key = process.env.ANTHROPIC_API_KEY;
if (key) {
  modelProviderContract(() => new AnthropicModelProvider({ apiKey: key, model: process.env.NPC_MODEL ?? "claude-sonnet-4-5" }));
} else {
  describe.skip("AnthropicModelProvider (set ANTHROPIC_API_KEY to run)", () => { it("skipped", () => {}); });
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm install && pnpm --filter @acr/adapters test`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the types, mock and Anthropic implementations**

`packages/adapters/src/model/types.ts`:
```ts
export type ChatMessage = { role: "user" | "assistant"; content: string };
export type ChatRequest = { system: string; messages: ChatMessage[]; maxTokens: number; model?: string; cacheSystem?: boolean };
export interface ModelProvider {
  readonly name: string;
  stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<string>;
}
```

`packages/adapters/src/model/mock.ts`:
```ts
import type { ChatRequest, ModelProvider } from "./types.js";

type Scripted = string | ((req: ChatRequest) => string);

export class MockModelProvider implements ModelProvider {
  readonly name = "mock";
  readonly calls: ChatRequest[] = [];
  defaultReply = "[mock reply]";
  private queue: Scripted[];
  constructor(script: Scripted[] = []) { this.queue = [...script]; }

  async *stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<string> {
    this.calls.push(req);
    const next = this.queue.shift();
    const text = next === undefined ? this.defaultReply : typeof next === "function" ? next(req) : next;
    const words = text.split(" ");
    for (let i = 0; i < words.length; i++) {
      if (signal?.aborted) return;
      yield i < words.length - 1 ? `${words[i]} ` : words[i];
    }
  }
}
```

`packages/adapters/src/model/anthropic.ts`:
```ts
import Anthropic from "@anthropic-ai/sdk";
import type { ChatRequest, ModelProvider } from "./types.js";

export class AnthropicModelProvider implements ModelProvider {
  readonly name = "anthropic";
  private client: Anthropic;
  private model: string;
  constructor(opts: { apiKey: string; model: string }) {
    this.client = new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model;
  }

  async *stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<string> {
    const system = req.cacheSystem === false
      ? req.system
      : [{ type: "text" as const, text: req.system, cache_control: { type: "ephemeral" as const } }];
    const stream = this.client.messages.stream(
      { model: req.model ?? this.model, max_tokens: req.maxTokens, system, messages: req.messages },
      { signal },
    );
    for await (const ev of stream) {
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") yield ev.delta.text;
    }
  }
}
```

`packages/adapters/src/model/select.ts`:
```ts
import { AnthropicModelProvider } from "./anthropic.js";
import { MockModelProvider } from "./mock.js";
import type { ModelProvider } from "./types.js";

export function selectModelProvider(env: NodeJS.ProcessEnv, role: "npc" | "gm"): ModelProvider {
  const kind = env.MODEL_PROVIDER ?? "mock";
  if (kind === "mock") return new MockModelProvider();
  if (kind === "anthropic") {
    if (!env.ANTHROPIC_API_KEY) throw new Error("MODEL_PROVIDER=anthropic but ANTHROPIC_API_KEY is empty");
    const model = (role === "npc" ? env.NPC_MODEL : env.GM_MODEL) ?? "claude-sonnet-4-5";
    return new AnthropicModelProvider({ apiKey: env.ANTHROPIC_API_KEY, model });
  }
  throw new Error(`unknown MODEL_PROVIDER '${kind}'`);
}
```

`packages/adapters/src/index.ts`:
```ts
export * from "./model/types.js";
export { MockModelProvider } from "./model/mock.js";
export { AnthropicModelProvider } from "./model/anthropic.js";
export { modelProviderContract } from "./model/contract.js";
export { selectModelProvider } from "./model/select.js";
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @acr/adapters test`
Expected: 4 passed, 1 skipped (Anthropic suite without a key).

- [ ] **Step 5: Add the SDK-import lint rule (Architecture §9 rule 1)**

Create `scripts/check-sdk-imports.sh`:
```bash
#!/usr/bin/env bash
# Fails if any file outside packages/adapters imports a provider SDK.
set -euo pipefail
if grep -rn --include='*.ts' -E "from ['\"](@anthropic-ai/sdk|openai|@aws-sdk/client-bedrock-runtime|@google-cloud/vertexai)" packages services 2>/dev/null | grep -v '^packages/adapters/'; then
  echo "provider SDK imported outside packages/adapters" >&2; exit 1
fi
echo "sdk-imports: ok"
```
Run `chmod +x scripts/check-sdk-imports.sh` and add `"lint:sdk": "bash scripts/check-sdk-imports.sh"` to the root `package.json` scripts.

Run: `pnpm lint:sdk`
Expected: `sdk-imports: ok`.

- [ ] **Step 6: Commit**

```bash
git add packages/adapters scripts/check-sdk-imports.sh package.json
git commit -m "[feat] US-0005: ModelProvider adapter with mock and Anthropic implementations"
```

---

### Task 6: SessionEngine with event log and scene control (US-0006)

**Files:**
- Create: `services/runtime/package.json`, `tsconfig.json`, `vitest.config.ts` (name `@acr/runtime`; dependencies `"@acr/events"`, `"@acr/script"`, `"@acr/adapters"` all `workspace:*`, `"ws": "^8.18.0"`; devDependencies `"@types/ws": "^8.5.12"`; scripts `"dev": "tsx watch src/main.ts"`, `"start": "tsx src/main.ts"`, `"play": "tsx src/cli/play.ts"`, plus the usual `test`/`typecheck`)
- Create: `services/runtime/src/engine/event-log.ts`
- Create: `services/runtime/src/engine/clock.ts`
- Create: `services/runtime/src/engine/session-engine.ts`
- Test: `services/runtime/src/engine/__tests__/session-engine.test.ts`

**Interfaces:**
- Produces:
  - `interface EventLog { append(body: EventBody): Promise<SessionEvent>; all(): Promise<SessionEvent[]>; sessionId: string }` with `class MemoryEventLog` and `class JsonlEventLog(dir)` (append-only file `data/sessions/<id>.jsonl`)
  - `interface Clock { now(): number }` with `class SystemClock` and `class FakeClock { advance(ms) }`
  - `class SessionEngine` with:
    - `constructor(opts: { scenario: Scenario; log: EventLog; clock: Clock })`
    - `state: SessionState` (current projection)
    - `start(assignments: Record<string, string>): Promise<void>` — player roleId → participantId; emits `session.started` then enters the first scene (and fires its `opening_inject` if any)
    - `say(roleId: string, text: string, channel?: Channel): Promise<SessionEvent>` — throws `EngineError("paused")` when paused, `EngineError("not_in_scene")` if the role is not in the current scene
    - `command(cmd: FacilitatorCommand): Promise<void>`
    - `tick(): Promise<void>` — evaluates exits and timed injects at `clock.now()`
    - `recordGmVerdict(condition: string, verdict: boolean, reasoning: string): Promise<void>`
    - `updateNpc(roleId, patch: { goals?: string[]; knowledge?: string[]; released?: string[] }): Promise<void>`
    - `subscribe(fn: (e: SessionEvent) => void): () => void`
    - `currentScene(): Scene | null`
  - `class EngineError extends Error { code: "paused" | "not_in_scene" | "ended" | "unknown_role" | "unknown_inject" }`

- [ ] **Step 1: Write the failing engine tests**

`services/runtime/src/engine/__tests__/session-engine.test.ts`:
```ts
import { describe, expect, it, beforeEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenario, type Scenario } from "@acr/script";
import { SessionEngine, EngineError } from "../session-engine.js";
import { MemoryEventLog } from "../event-log.js";
import { FakeClock } from "../clock.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");

let scenario: Scenario;
let clock: FakeClock;
let engine: SessionEngine;

beforeEach(async () => {
  scenario = await loadScenario(fixture);
  clock = new FakeClock(1_000_000);
  engine = new SessionEngine({ scenario, log: new MemoryEventLog("sess-1"), clock });
  await engine.start({ host: "participant-1" });
});

describe("SessionEngine", () => {
  it("starts and enters the first scene", () => {
    expect(engine.state.status).toBe("running");
    expect(engine.state.currentScene?.id).toBe("s1_open");
    expect(engine.state.roles.host).toEqual({ kind: "player", participantId: "participant-1" });
    expect(engine.state.roles.guest).toEqual({ kind: "npc" });
  });

  it("records an utterance", async () => {
    const e = await engine.say("host", "hello");
    expect(e.type).toBe("utterance");
    expect(engine.state.transcript.at(-1)?.text).toBe("hello");
  });

  it("rejects utterances while paused and does not log them", async () => {
    await engine.command({ command: "pause" });
    await expect(engine.say("host", "x")).rejects.toMatchObject({ code: "paused" });
    expect(engine.state.transcript).toHaveLength(0);
    await engine.command({ command: "resume" });
    await engine.say("host", "y");
    expect(engine.state.transcript).toHaveLength(1);
  });

  it("rejects a role that is not in the current scene", async () => {
    await engine.command({ command: "advance" });
    await engine.tick();
    expect(engine.state.currentScene?.id).toBe("s2_close");
    scenario.script.scenes[1].participants = ["host"]; // guest no longer in s2
    await expect(engine.say("guest", "x")).rejects.toBeInstanceOf(EngineError);
  });

  it("fires a timed inject on tick and never twice", async () => {
    clock.advance(61_000);
    await engine.tick();
    expect(engine.state.injectsFired).toEqual(["late_inject"]);
    expect(engine.state.npcs.guest.goals).toContain("Leave early");
    await engine.tick();
    expect(engine.state.injectsFired).toEqual(["late_inject"]);
  });

  it("exits a scene on its time box and enters the next", async () => {
    clock.advance(120_000);
    await engine.tick();
    expect(engine.state.currentScene?.id).toBe("s2_close");
    expect(engine.state.sceneHistory.map((s) => s.id)).toEqual(["s1_open", "s2_close"]);
  });

  it("exits a scene on a GM verdict", async () => {
    await engine.recordGmVerdict("both parties have said hello", true, "both greeted");
    await engine.tick();
    expect(engine.state.currentScene?.id).toBe("s2_close");
  });

  it("ends the session after the last scene", async () => {
    clock.advance(120_000); await engine.tick();
    clock.advance(60_000); await engine.tick();
    expect(engine.state.status).toBe("ended");
    await expect(engine.say("host", "x")).rejects.toMatchObject({ code: "ended" });
  });

  it("fires a manual inject on facilitator command", async () => {
    await engine.command({ command: "fire_inject", injectId: "late_inject" });
    expect(engine.state.injectsFired).toEqual(["late_inject"]);
  });

  it("notifies subscribers of every event", async () => {
    const seen: string[] = [];
    engine.subscribe((e) => seen.push(e.type));
    await engine.say("host", "a");
    expect(seen).toEqual(["utterance"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm install && pnpm --filter @acr/runtime test`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the clock and event log**

`services/runtime/src/engine/clock.ts`:
```ts
export interface Clock { now(): number }
export class SystemClock implements Clock { now() { return Date.now(); } }
export class FakeClock implements Clock {
  constructor(private t: number) {}
  now() { return this.t; }
  advance(ms: number) { this.t += ms; }
}
```

`services/runtime/src/engine/event-log.ts`:
```ts
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { EventBody, SessionEvent } from "@acr/events";

export interface EventLog {
  readonly sessionId: string;
  append(body: EventBody, ts: number): Promise<SessionEvent>;
  all(): Promise<SessionEvent[]>;
}

export class MemoryEventLog implements EventLog {
  private events: SessionEvent[] = [];
  constructor(readonly sessionId: string) {}
  async append(body: EventBody, ts: number): Promise<SessionEvent> {
    const e = { ...body, seq: this.events.length + 1, ts, sessionId: this.sessionId } as SessionEvent;
    this.events.push(e);
    return e;
  }
  async all() { return [...this.events]; }
}

export class JsonlEventLog implements EventLog {
  private seq = 0;
  private file: string;
  constructor(readonly sessionId: string, dir = "data/sessions") { this.file = path.join(dir, `${sessionId}.jsonl`); }
  async append(body: EventBody, ts: number): Promise<SessionEvent> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const e = { ...body, seq: ++this.seq, ts, sessionId: this.sessionId } as SessionEvent;
    await appendFile(this.file, JSON.stringify(e) + "\n", "utf8");
    return e;
  }
  async all(): Promise<SessionEvent[]> {
    try { return (await readFile(this.file, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l) as SessionEvent); }
    catch { return []; }
  }
}
```

- [ ] **Step 4: Write the engine**

`services/runtime/src/engine/session-engine.ts`:
```ts
import { initialState, reduce, type Channel, type EventBody, type FacilitatorCommand, type SessionEvent, type SessionState } from "@acr/events";
import { dueInjects, evaluateExit, nextSceneId, type Inject, type Scenario, type Scene } from "@acr/script";
import type { Clock } from "./clock.js";
import type { EventLog } from "./event-log.js";

export type EngineErrorCode = "paused" | "not_in_scene" | "ended" | "unknown_role" | "unknown_inject";
export class EngineError extends Error {
  constructor(readonly code: EngineErrorCode, message = code) { super(message); this.name = "EngineError"; }
}

export class SessionEngine {
  state: SessionState = initialState();
  private readonly scenario: Scenario;
  private readonly log: EventLog;
  private readonly clock: Clock;
  private readonly listeners = new Set<(e: SessionEvent) => void>();
  private advanceRequested = false;
  private gmVerdicts: Record<string, boolean> = {};

  constructor(opts: { scenario: Scenario; log: EventLog; clock: Clock }) {
    this.scenario = opts.scenario; this.log = opts.log; this.clock = opts.clock;
  }

  subscribe(fn: (e: SessionEvent) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  currentScene(): Scene | null {
    const id = this.state.currentScene?.id;
    return id ? this.scenario.script.scenes.find((s) => s.id === id) ?? null : null;
  }

  private async emit(body: EventBody): Promise<SessionEvent> {
    const e = await this.log.append(body, this.clock.now());
    this.state = reduce(this.state, e);
    for (const l of this.listeners) l(e);
    return e;
  }

  async start(assignments: Record<string, string>): Promise<void> {
    const roles: Record<string, { kind: "player" | "npc"; participantId?: string }> = {};
    for (const [id, role] of Object.entries(this.scenario.roles)) {
      roles[id] = role.type === "npc" ? { kind: "npc" } : { kind: "player", participantId: assignments[id] };
    }
    await this.emit({ type: "session.started", scenarioId: this.scenario.meta.id, version: this.scenario.meta.version, roles });
    for (const [id, role] of Object.entries(this.scenario.roles)) {
      if (role.type === "npc") await this.emit({ type: "npc.updated", roleId: id, goals: role.goals, knowledge: role.knowledge, released: [] });
    }
    await this.enterScene(this.scenario.script.scenes[0]);
  }

  private async enterScene(scene: Scene): Promise<void> {
    this.advanceRequested = false;
    this.gmVerdicts = {};
    await this.emit({ type: "scene.entered", sceneId: scene.id, participants: scene.participants });
    if (scene.opening_inject) await this.fireInject(scene, scene.injects!.find((i) => i.id === scene.opening_inject)!);
  }

  private async fireInject(scene: Scene, inject: Inject): Promise<void> {
    await this.emit({ type: "inject.fired", injectId: inject.id, sceneId: scene.id, to: inject.to, content: inject.content });
    for (const roleId of inject.to) {
      const npc = this.state.npcs[roleId];
      if (!npc) continue;
      await this.emit({ type: "npc.updated", roleId,
        goals: [...npc.goals, ...(inject.effect?.goals_add ?? [])],
        knowledge: [...npc.knowledge, ...(inject.effect?.knowledge_add ?? [])] });
    }
  }

  async say(roleId: string, text: string, channel: Channel = "text"): Promise<SessionEvent> {
    if (this.state.status === "ended") throw new EngineError("ended");
    if (!this.state.roles[roleId]) throw new EngineError("unknown_role", `unknown role ${roleId}`);
    if (this.state.paused) throw new EngineError("paused");
    const scene = this.currentScene();
    if (!scene || !scene.participants.includes(roleId)) throw new EngineError("not_in_scene", `${roleId} is not in the current scene`);
    return this.emit({ type: "utterance", roleId, text, channel });
  }

  async command(cmd: FacilitatorCommand): Promise<void> {
    if (this.state.status === "ended") throw new EngineError("ended");
    await this.emit({ type: "facilitator.command", ...cmd });
    if (cmd.command === "advance") this.advanceRequested = true;
    if (cmd.command === "fire_inject") {
      const scene = this.currentScene();
      const inject = scene?.injects?.find((i) => i.id === cmd.injectId);
      if (!scene || !inject) throw new EngineError("unknown_inject", `no inject ${cmd.injectId} in the current scene`);
      await this.fireInject(scene, inject);
    }
    if (cmd.command === "set_npc_stance") await this.updateNpc(cmd.roleId, { goals: cmd.goals });
  }

  async updateNpc(roleId: string, patch: { goals?: string[]; knowledge?: string[]; released?: string[] }): Promise<void> {
    const npc = this.state.npcs[roleId];
    if (!npc) throw new EngineError("unknown_role", `${roleId} is not an NPC`);
    await this.emit({ type: "npc.updated", roleId, goals: patch.goals ?? npc.goals, knowledge: patch.knowledge ?? npc.knowledge, released: patch.released ?? npc.released });
  }

  async recordGmVerdict(condition: string, verdict: boolean, reasoning: string): Promise<void> {
    const scene = this.currentScene();
    if (!scene) return;
    this.gmVerdicts[condition] = verdict;
    await this.emit({ type: "gm.decision", sceneId: scene.id, condition, verdict, reasoning });
  }

  async tick(): Promise<void> {
    const scene = this.currentScene();
    if (!scene || this.state.paused || this.state.status !== "running") return;
    const elapsedMs = this.clock.now() - this.state.currentScene!.enteredAt;
    for (const inject of dueInjects(scene, elapsedMs, this.state.injectsFired)) await this.fireInject(scene, inject);
    const reason = evaluateExit(scene, { elapsedMs, facilitatorAdvance: this.advanceRequested, gmVerdicts: this.gmVerdicts });
    if (!reason) return;
    await this.emit({ type: "scene.exited", sceneId: scene.id, reason });
    const nextId = nextSceneId(this.scenario.script, scene.id);
    if (nextId) await this.enterScene(this.scenario.script.scenes.find((s) => s.id === nextId)!);
    else await this.emit({ type: "session.ended", reason: "script_complete" });
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @acr/runtime test`
Expected: 10 passed.

- [ ] **Step 6: Commit**

```bash
git add services/runtime
git commit -m "[feat] US-0006: SessionEngine with event log, scene FSM and facilitator commands"
```

---

### Task 7: NPC agent on the fast path (US-0007)

**Files:**
- Create: `services/runtime/src/agents/npc-prompt.ts`
- Create: `services/runtime/src/agents/npc-agent.ts`
- Test: `services/runtime/src/agents/__tests__/npc-prompt.test.ts`, `services/runtime/src/agents/__tests__/npc-agent.test.ts`

**Interfaces:**
- Produces:
  - `buildNpcRequest(opts: { role: NpcRole; scene: Scene; state: SessionState; window?: number }): ChatRequest` — pure; `system` is the cacheable persona prefix, `messages` is the visible transcript as alternating turns (the NPC's own lines as `assistant`, everyone else's as `user` prefixed `[role_id]: `), limited to the last `window` (default 30) utterances
  - `class NpcAgent` with `constructor(opts: { role: NpcRole; engine: SessionEngine; provider: ModelProvider; firstTokenTimeoutMs?: number })` and `respond(): Promise<SessionEvent | null>` — streams a reply, emits one `utterance` for the NPC, or emits the `fallback_line` plus a `facilitator.alert` on timeout or empty reply; returns `null` when the NPC is not in the current scene or the session is paused
- Consumes: `SessionEngine` (Task 6), `ModelProvider`/`ChatRequest` (Task 5), `visibleTranscript` (Task 2), `NpcRole`/`Scene` (Task 3).

- [ ] **Step 1: Write the failing prompt-builder tests**

`services/runtime/src/agents/__tests__/npc-prompt.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { initialState, reduce, type SessionEvent } from "@acr/events";
import type { NpcRole, Scene } from "@acr/script";
import { buildNpcRequest } from "../npc-prompt.js";

const role: NpcRole = {
  id: "client_sponsor", type: "npc", name: "Priya Raman", title: "VP Operations", persona: "Direct, time-poor.",
  goals: ["Get the module"], knowledge: ["The CFO asked about cost"], hidden: ["Would accept phasing"],
  guardrails: ["Never reveal hidden information unless earned"], fallback_line: "Sorry, say again?", voice: { style: "brisk", pace: "fast" },
};
const scene: Scene = { id: "s2", title: "Call", goal: "Respond to the request", participants: ["delivery_lead", "client_sponsor"], time_box_minutes: 15, exit_when: { any_of: ["facilitator_advance"] } };
const env = (seq: number) => ({ seq, ts: seq, sessionId: "s" });

function stateWith(...texts: Array<[string, string]>) {
  let s = reduce(initialState(), { ...env(1), type: "session.started", scenarioId: "x", version: "1", roles: { delivery_lead: { kind: "player", participantId: "Kamal Syed" }, client_sponsor: { kind: "npc" } } });
  s = reduce(s, { ...env(2), type: "npc.updated", roleId: "client_sponsor", goals: ["Get the module", "Get a yes today"], knowledge: ["The CFO asked about cost"], released: [] });
  s = reduce(s, { ...env(3), type: "scene.entered", sceneId: "s2", participants: scene.participants });
  let seq = 4;
  for (const [r, t] of texts) s = reduce(s, { ...env(seq++), type: "utterance", roleId: r, text: t, channel: "text" } as SessionEvent);
  return s;
}

describe("buildNpcRequest", () => {
  it("puts persona, current goals, knowledge and guardrails in the system prefix", () => {
    const req = buildNpcRequest({ role, scene, state: stateWith() });
    expect(req.system).toContain("Priya Raman");
    expect(req.system).toContain("Get a yes today");
    expect(req.system).toContain("The CFO asked about cost");
    expect(req.system).toContain("Never reveal hidden information");
    expect(req.system).toContain("Respond to the request");
    expect(req.cacheSystem).toBe(true);
  });

  it("never includes hidden facts that have not been released, nor participant names", () => {
    const req = buildNpcRequest({ role, scene, state: stateWith(["delivery_lead", "Hi Priya"]) });
    const all = req.system + JSON.stringify(req.messages);
    expect(all).not.toContain("Would accept phasing");
    expect(all).not.toContain("Kamal Syed");
  });

  it("includes a released hidden fact", () => {
    let s = stateWith();
    s = reduce(s, { ...env(s.lastSeq + 1), type: "npc.updated", roleId: "client_sponsor", goals: s.npcs.client_sponsor.goals, knowledge: s.npcs.client_sponsor.knowledge, released: ["Would accept phasing"] });
    expect(buildNpcRequest({ role, scene, state: s }).system).toContain("Would accept phasing");
  });

  it("maps the transcript to alternating turns with the NPC as assistant", () => {
    const req = buildNpcRequest({ role, scene, state: stateWith(["delivery_lead", "Hi Priya"], ["client_sponsor", "Hello"], ["delivery_lead", "About the module"]) });
    expect(req.messages).toEqual([
      { role: "user", content: "[delivery_lead]: Hi Priya" },
      { role: "assistant", content: "Hello" },
      { role: "user", content: "[delivery_lead]: About the module" },
    ]);
  });

  it("merges consecutive user lines into one turn and ends with a user turn", () => {
    const req = buildNpcRequest({ role, scene, state: stateWith(["delivery_lead", "One"], ["delivery_lead", "Two"]) });
    expect(req.messages).toEqual([{ role: "user", content: "[delivery_lead]: One\n[delivery_lead]: Two" }]);
    const empty = buildNpcRequest({ role, scene, state: stateWith() });
    expect(empty.messages).toEqual([{ role: "user", content: "[scene]: The scene has started. Speak first if it is natural for you to." }]);
  });

  it("keeps only the last `window` utterances", () => {
    const lines: Array<[string, string]> = Array.from({ length: 40 }, (_, i) => ["delivery_lead", `line ${i}`]);
    const req = buildNpcRequest({ role, scene, state: stateWith(...lines), window: 5 });
    expect(req.messages[0].content.split("\n")).toHaveLength(5);
    expect(req.messages[0].content).toContain("line 39");
  });
});
```

- [ ] **Step 2: Write the failing agent tests**

`services/runtime/src/agents/__tests__/npc-agent.test.ts`:
```ts
import { describe, expect, it, beforeEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenario, type NpcRole } from "@acr/script";
import { MockModelProvider, type ChatRequest, type ModelProvider } from "@acr/adapters";
import { SessionEngine } from "../../engine/session-engine.js";
import { MemoryEventLog } from "../../engine/event-log.js";
import { FakeClock } from "../../engine/clock.js";
import { NpcAgent } from "../npc-agent.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");
let engine: SessionEngine; let guest: NpcRole;

beforeEach(async () => {
  const scenario = await loadScenario(fixture);
  guest = scenario.roles.guest as NpcRole;
  engine = new SessionEngine({ scenario, log: new MemoryEventLog("s"), clock: new FakeClock(0) });
  await engine.start({ host: "p1" });
  await engine.say("host", "Hello Sam");
});

describe("NpcAgent", () => {
  it("emits one utterance with the streamed reply", async () => {
    const agent = new NpcAgent({ role: guest, engine, provider: new MockModelProvider(["Hi there, good to see you"]) });
    const e = await agent.respond();
    expect(e?.type).toBe("utterance");
    expect(engine.state.transcript.at(-1)).toMatchObject({ roleId: "guest", text: "Hi there, good to see you" });
  });

  it("uses the fallback line and alerts the facilitator on an empty reply", async () => {
    const alerts: string[] = [];
    engine.subscribe((e) => { if (e.type === "facilitator.alert") alerts.push(e.message); });
    const agent = new NpcAgent({ role: guest, engine, provider: new MockModelProvider([""]) });
    await agent.respond();
    expect(engine.state.transcript.at(-1)?.text).toBe(guest.fallback_line);
    expect(alerts[0]).toMatch(/guest.*empty reply/);
  });

  it("uses the fallback line when the first token does not arrive in time", async () => {
    const slow: ModelProvider = { name: "slow", async *stream(_req: ChatRequest, signal?: AbortSignal) {
      await new Promise((r) => setTimeout(r, 50)); if (signal?.aborted) return; yield "late"; } };
    const agent = new NpcAgent({ role: guest, engine, provider: slow, firstTokenTimeoutMs: 10 });
    await agent.respond();
    expect(engine.state.transcript.at(-1)?.text).toBe(guest.fallback_line);
  });

  it("returns null and says nothing while paused", async () => {
    await engine.command({ command: "pause" });
    const agent = new NpcAgent({ role: guest, engine, provider: new MockModelProvider(["x"]) });
    expect(await agent.respond()).toBeNull();
    expect(engine.state.transcript).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @acr/runtime test agents`
Expected: FAIL — modules not found.

- [ ] **Step 4: Write the prompt builder**

`services/runtime/src/agents/npc-prompt.ts`:
```ts
import { visibleTranscript, type SessionState } from "@acr/events";
import type { NpcRole, Scene } from "@acr/script";
import type { ChatMessage, ChatRequest } from "@acr/adapters";

const bullets = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join("\n") : "- (none)");

export function buildNpcRequest(opts: { role: NpcRole; scene: Scene; state: SessionState; window?: number }): ChatRequest {
  const { role, scene, state } = opts;
  const npc = state.npcs[role.id] ?? { goals: role.goals, knowledge: role.knowledge, released: [] };
  const system = [
    `You are playing ${role.name}${role.title ? `, ${role.title}` : ""} in a live role-play training session.`,
    `Stay in character at all times. Speak only as ${role.name}. Reply in one to four sentences of natural spoken dialogue, no stage directions, no lists.`,
    `Other speakers are shown as [role_id]: text. Never mention role ids; address people the way ${role.name} would.`,
    "", "## Persona", role.persona,
    "", "## Your current goals", bullets(npc.goals),
    "", "## What you know", bullets([...npc.knowledge, ...npc.released]),
    "", "## Rules you must follow", bullets(role.guardrails),
    "", "## Current scene", `${scene.title}: ${scene.goal}`,
    "", `## Voice`, `Style: ${role.voice.style}. Pace: ${role.voice.pace}.`,
  ].join("\n");

  const lines = visibleTranscript(state, role.id).slice(-(opts.window ?? 30));
  const messages: ChatMessage[] = [];
  for (const u of lines) {
    const turn: ChatMessage = u.roleId === role.id ? { role: "assistant", content: u.text } : { role: "user", content: `[${u.roleId}]: ${u.text}` };
    const last = messages.at(-1);
    if (last && last.role === turn.role) last.content += `\n${turn.content}`; else messages.push(turn);
  }
  if (messages.length === 0 || messages.at(-1)!.role === "assistant") {
    messages.push({ role: "user", content: "[scene]: The scene has started. Speak first if it is natural for you to." });
  }
  return { system, messages, maxTokens: 300, cacheSystem: true };
}
```

- [ ] **Step 5: Write the agent**

`services/runtime/src/agents/npc-agent.ts`:
```ts
import type { SessionEvent } from "@acr/events";
import type { NpcRole } from "@acr/script";
import type { ModelProvider } from "@acr/adapters";
import type { SessionEngine } from "../engine/session-engine.js";
import { buildNpcRequest } from "./npc-prompt.js";

export class NpcAgent {
  private readonly role: NpcRole;
  private readonly engine: SessionEngine;
  private readonly provider: ModelProvider;
  private readonly firstTokenTimeoutMs: number;

  constructor(opts: { role: NpcRole; engine: SessionEngine; provider: ModelProvider; firstTokenTimeoutMs?: number }) {
    this.role = opts.role; this.engine = opts.engine; this.provider = opts.provider;
    this.firstTokenTimeoutMs = opts.firstTokenTimeoutMs ?? 4_000;
  }

  async respond(): Promise<SessionEvent | null> {
    const scene = this.engine.currentScene();
    if (!scene || !scene.participants.includes(this.role.id) || this.engine.state.paused || this.engine.state.status !== "running") return null;
    const req = buildNpcRequest({ role: this.role, scene, state: this.engine.state });
    const ac = new AbortController();
    let text = "";
    let failure: string | null = null;
    try {
      const it = this.provider.stream(req, ac.signal)[Symbol.asyncIterator]();
      const first = await Promise.race([
        it.next(),
        new Promise<"timeout">((r) => setTimeout(() => r("timeout"), this.firstTokenTimeoutMs)),
      ]);
      if (first === "timeout") { ac.abort(); failure = "no first token within timeout"; }
      else if (!first.done) {
        text += first.value;
        for (let r = await it.next(); !r.done; r = await it.next()) text += r.value;
      }
    } catch (err) { failure = (err as Error).message; }
    if (!failure && text.trim().length === 0) failure = "empty reply";
    if (failure) {
      await this.engine.emit({ type: "facilitator.alert", level: "warning", message: `NPC ${this.role.id}: ${failure}; used fallback line` });
      return this.engine.say(this.role.id, this.role.fallback_line);
    }
    return this.engine.say(this.role.id, text.trim());
  }
}
```

Make `emit` reachable: in `session-engine.ts` change `private async emit` to `async emit` and add the comment `/** Append any event. Used by agents for alerts; prefer the typed methods elsewhere. */`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @acr/runtime test`
Expected: 20 passed.

- [ ] **Step 7: Commit**

```bash
git add services/runtime
git commit -m "[feat] US-0007: NPC agent with cached persona prompt, timeout and fallback"
```

---

### Task 8: Game Master beside the fast path (US-0008)

**Files:**
- Create: `services/runtime/src/agents/gm-prompt.ts`
- Create: `services/runtime/src/agents/game-master.ts`
- Test: `services/runtime/src/agents/__tests__/game-master.test.ts`

**Interfaces:**
- Produces:
  - `buildGmRequest(opts: { scene: Scene; condition: string; state: SessionState }): ChatRequest` — asks for a strict JSON verdict `{"verdict": true|false, "reasoning": "..."}` over the current scene's transcript
  - `parseGmVerdict(text: string): { verdict: boolean; reasoning: string } | null`
  - `class GameMaster` with `constructor(opts: { engine: SessionEngine; provider: ModelProvider; everyNUtterances?: number })` and `tick(): Promise<void>` — calls `engine.tick()` for timers and injects, and every N new utterances (default 3) evaluates each `gm_detects` condition of the current scene with the model, recording verdicts through `engine.recordGmVerdict`, then calls `engine.tick()` again so a true verdict exits the scene in the same tick
- Consumes: `SessionEngine` (Task 6), `ModelProvider` (Task 5).

- [ ] **Step 1: Write the failing tests**

`services/runtime/src/agents/__tests__/game-master.test.ts`:
```ts
import { describe, expect, it, beforeEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenario } from "@acr/script";
import { MockModelProvider } from "@acr/adapters";
import { SessionEngine } from "../../engine/session-engine.js";
import { MemoryEventLog } from "../../engine/event-log.js";
import { FakeClock } from "../../engine/clock.js";
import { GameMaster } from "../game-master.js";
import { parseGmVerdict } from "../gm-prompt.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");
let engine: SessionEngine; let clock: FakeClock;

beforeEach(async () => {
  clock = new FakeClock(0);
  engine = new SessionEngine({ scenario: await loadScenario(fixture), log: new MemoryEventLog("s"), clock });
  await engine.start({ host: "p1" });
});

describe("parseGmVerdict", () => {
  it("reads a JSON object even when wrapped in prose or fences", () => {
    expect(parseGmVerdict('Sure:\n```json\n{"verdict": true, "reasoning": "both said hi"}\n```')).toEqual({ verdict: true, reasoning: "both said hi" });
    expect(parseGmVerdict("not json")).toBeNull();
  });
});

describe("GameMaster", () => {
  it("does not call the model until N utterances have accumulated", async () => {
    const provider = new MockModelProvider();
    const gm = new GameMaster({ engine, provider, everyNUtterances: 2 });
    await engine.say("host", "hello");
    await gm.tick();
    expect(provider.calls).toHaveLength(0);
    await engine.say("guest", "hi");
    await gm.tick();
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].system).toContain("both parties have said hello");
  });

  it("exits the scene when the model returns a true verdict", async () => {
    const provider = new MockModelProvider(['{"verdict": true, "reasoning": "greeted"}']);
    const gm = new GameMaster({ engine, provider, everyNUtterances: 1 });
    await engine.say("host", "hello");
    await gm.tick();
    expect(engine.state.currentScene?.id).toBe("s2_close");
    const decision = (await engine["log"].all()).find((e) => e.type === "gm.decision");
    expect(decision).toMatchObject({ verdict: true, reasoning: "greeted" });
  });

  it("stays in the scene on a false verdict and on unparseable output", async () => {
    const provider = new MockModelProvider(['{"verdict": false, "reasoning": "only one greeted"}', "garbage"]);
    const gm = new GameMaster({ engine, provider, everyNUtterances: 1 });
    await engine.say("host", "hello"); await gm.tick();
    await engine.say("host", "hello again"); await gm.tick();
    expect(engine.state.currentScene?.id).toBe("s1_open");
  });

  it("fires timed injects and time-box exits through engine.tick, and never fires an inject after its scene exits", async () => {
    const gm = new GameMaster({ engine, provider: new MockModelProvider() });
    clock.advance(120_000);
    await gm.tick();
    expect(engine.state.currentScene?.id).toBe("s2_close");
    expect(engine.state.injectsFired).toEqual(["late_inject"]);
    clock.advance(10_000);
    await gm.tick();
    expect(engine.state.injectsFired).toEqual(["late_inject"]);
  });
});
```

Also expose the log for tests: in `SessionEngine` change `private readonly log` to `readonly log`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @acr/runtime test game-master`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the GM prompt and parser**

`services/runtime/src/agents/gm-prompt.ts`:
```ts
import type { SessionState } from "@acr/events";
import type { Scene } from "@acr/script";
import type { ChatRequest } from "@acr/adapters";

export function buildGmRequest(opts: { scene: Scene; condition: string; state: SessionState }): ChatRequest {
  const { scene, condition, state } = opts;
  const lines = state.transcript.filter((u) => u.sceneId === scene.id).map((u) => `[${u.roleId}]: ${u.text}`).join("\n") || "(no dialogue yet)";
  const system = [
    "You are the Game Master of a role-play training session. You never speak as a character.",
    `Scene: ${scene.title}. Goal: ${scene.goal}.`,
    `Decide whether this condition is now true in the dialogue: "${condition}".`,
    'Answer with JSON only: {"verdict": true or false, "reasoning": "one sentence citing what was said"}.',
    "Be strict: the condition must be clearly met by what was said, not merely attempted.",
  ].join("\n");
  return { system, messages: [{ role: "user", content: `Dialogue so far:\n${lines}` }], maxTokens: 200, cacheSystem: false };
}

export function parseGmVerdict(text: string): { verdict: boolean; reasoning: string } | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]) as { verdict?: unknown; reasoning?: unknown };
    if (typeof obj.verdict !== "boolean") return null;
    return { verdict: obj.verdict, reasoning: typeof obj.reasoning === "string" ? obj.reasoning : "" };
  } catch { return null; }
}
```

- [ ] **Step 4: Write the Game Master**

`services/runtime/src/agents/game-master.ts`:
```ts
import type { ModelProvider } from "@acr/adapters";
import type { SessionEngine } from "../engine/session-engine.js";
import { buildGmRequest, parseGmVerdict } from "./gm-prompt.js";

export class GameMaster {
  private readonly engine: SessionEngine;
  private readonly provider: ModelProvider;
  private readonly everyN: number;
  private evaluatedCount = 0; // utterances in the current scene at the last evaluation
  private lastSceneId: string | null = null;

  constructor(opts: { engine: SessionEngine; provider: ModelProvider; everyNUtterances?: number }) {
    this.engine = opts.engine; this.provider = opts.provider; this.everyN = opts.everyNUtterances ?? 3;
  }

  async tick(): Promise<void> {
    await this.engine.tick();
    const scene = this.engine.currentScene();
    if (!scene || this.engine.state.paused) return;
    if (scene.id !== this.lastSceneId) { this.lastSceneId = scene.id; this.evaluatedCount = 0; }
    const count = this.engine.state.transcript.filter((u) => u.sceneId === scene.id).length;
    if (count === 0 || count - this.evaluatedCount < this.everyN) return;
    this.evaluatedCount = count;
    for (const cond of scene.exit_when.any_of) {
      if (typeof cond !== "object") continue;
      let text = "";
      try { for await (const c of this.provider.stream(buildGmRequest({ scene, condition: cond.gm_detects, state: this.engine.state }))) text += c; }
      catch (err) { await this.engine.emit({ type: "facilitator.alert", level: "warning", message: `GM: model error: ${(err as Error).message}` }); continue; }
      const parsed = parseGmVerdict(text);
      if (!parsed) { await this.engine.emit({ type: "facilitator.alert", level: "info", message: `GM: could not parse verdict for "${cond.gm_detects}"` }); continue; }
      await this.engine.recordGmVerdict(cond.gm_detects, parsed.verdict, parsed.reasoning);
    }
    await this.engine.tick();
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @acr/runtime test`
Expected: 25 passed.

- [ ] **Step 6: Commit**

```bash
git add services/runtime
git commit -m "[feat] US-0008: Game Master evaluates gm_detects conditions beside the NPC path"
```

---

### Task 9: Session host, WebSocket protocol and server (US-0009)

**Files:**
- Create: `services/runtime/src/host/session-host.ts`
- Create: `services/runtime/src/host/protocol.ts`
- Create: `services/runtime/src/host/ws-server.ts`
- Create: `services/runtime/src/main.ts`
- Test: `services/runtime/src/host/__tests__/session-host.test.ts`, `services/runtime/src/host/__tests__/ws-server.test.ts`

**Interfaces:**
- Produces:
  - `protocol.ts`: Zod-validated message types.
    - Client → server: `{ type: "join"; sessionId: string; roleId: string; participantId: string }`, `{ type: "join_facilitator"; sessionId: string }`, `{ type: "start" }` (facilitator only; begins the session once everyone has joined), `{ type: "say"; text: string }`, `{ type: "command"; command: FacilitatorCommand }`
    - Server → client: `{ type: "joined"; roleId: string | "facilitator"; brief?: string; privateFacts?: string[]; state: SessionState }`, `{ type: "event"; event: SessionEvent }` (filtered: a player receives `utterance` events only for scenes they participate in, `inject.fired` only when they are in `to`; the facilitator receives everything), `{ type: "error"; code: string; message: string }`
  - `class SessionHost` — one per session: `constructor(opts: { scenario: Scenario; engine: SessionEngine; npcProvider: ModelProvider; gmProvider: ModelProvider; clock: Clock })`; `join(roleId, participantId): { brief: string; privateFacts: string[] }` (throws `HostError("role_taken" | "unknown_role" | "npc_role")`); `onPlayerUtterance(roleId, text): Promise<void>` — records the line, then schedules every NPC in the scene to respond (one at a time, in scene participant order) and a GM tick; `startTicker(ms)` / `stopTicker()`; `subscribe(fn)`; `filterFor(roleId | "facilitator")(event): boolean`
  - `ws-server.ts`: `startServer(opts: { port: number; hosts: Map<string, SessionHost>; log?: (msg: string) => void }): Promise<{ close(): Promise<void> }>`
  - `main.ts`: loads `.env`, loads the scenario at `SCENARIO_DIR` (default `scenarios/friday-escalation`), validates it (exits 1 on errors, prints warnings), creates one session with id from `SESSION_ID` (default `local`), a `JsonlEventLog`, providers from `selectModelProvider`, starts the ticker every 1 000 ms and the server on `RUNTIME_PORT`.

- [ ] **Step 1: Write the failing host tests**

`services/runtime/src/host/__tests__/session-host.test.ts`:
```ts
import { describe, expect, it, beforeEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenario } from "@acr/script";
import { MockModelProvider } from "@acr/adapters";
import { SessionEngine } from "../../engine/session-engine.js";
import { MemoryEventLog } from "../../engine/event-log.js";
import { FakeClock } from "../../engine/clock.js";
import { SessionHost } from "../session-host.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");
let host: SessionHost; let engine: SessionEngine; let npc: MockModelProvider;

beforeEach(async () => {
  const scenario = await loadScenario(fixture);
  const clock = new FakeClock(0);
  engine = new SessionEngine({ scenario, log: new MemoryEventLog("s"), clock });
  npc = new MockModelProvider(["Hello host, lovely to be here"]);
  host = new SessionHost({ scenario, engine, npcProvider: npc, gmProvider: new MockModelProvider(), clock });
});

describe("SessionHost.join", () => {
  it("assigns a player role and returns the private brief", () => {
    const r = host.join("host", "p1");
    expect(r.brief).toMatch(/hosting/);
    expect(r.privateFacts).toEqual(["You have five minutes"]);
  });
  it("refuses a second participant for the same role, and keeps the first", () => {
    host.join("host", "p1");
    expect(() => host.join("host", "p2")).toThrow(/role_taken/);
    expect(host.assignments).toEqual({ host: "p1" });
  });
  it("refuses NPC roles and unknown roles", () => {
    expect(() => host.join("guest", "p1")).toThrow(/npc_role/);
    expect(() => host.join("nobody", "p1")).toThrow(/unknown_role/);
  });
});

describe("SessionHost.onPlayerUtterance", () => {
  it("records the line, has the NPC reply, and runs a GM tick", async () => {
    host.join("host", "p1");
    await host.start();
    await host.onPlayerUtterance("host", "Hi Sam");
    expect(engine.state.transcript.map((u) => `${u.roleId}:${u.text}`)).toEqual(["host:Hi Sam", "guest:Hello host, lovely to be here"]);
    expect(npc.calls).toHaveLength(1);
  });
});

describe("SessionHost.filterFor", () => {
  it("hides scenes a player is not in and injects not addressed to them", async () => {
    host.join("host", "p1");
    await host.start();
    const forHost = host.filterFor("host");
    const forFac = host.filterFor("facilitator");
    const inject = { seq: 9, ts: 0, sessionId: "s", type: "inject.fired" as const, injectId: "x", sceneId: "s1_open", to: ["guest"], content: "secret" };
    expect(forHost(inject)).toBe(false);
    expect(forFac(inject)).toBe(true);
    const line = await engine.say("guest", "hi"); // host and guest share s1_open
    expect(forHost(line)).toBe(true);
  });
});
```

- [ ] **Step 2: Write the failing server test**

`services/runtime/src/host/__tests__/ws-server.test.ts`:
```ts
import { describe, expect, it, afterEach } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { loadScenario } from "@acr/script";
import { MockModelProvider } from "@acr/adapters";
import { SessionEngine } from "../../engine/session-engine.js";
import { MemoryEventLog } from "../../engine/event-log.js";
import { FakeClock } from "../../engine/clock.js";
import { SessionHost } from "../session-host.js";
import { startServer } from "../ws-server.js";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../../packages/script/src/__tests__/fixtures/minimal");
let server: Awaited<ReturnType<typeof startServer>> | null = null;
afterEach(async () => { await server?.close(); server = null; });

function open(port: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const inbox: unknown[] = [];
  ws.on("message", (d) => inbox.push(JSON.parse(d.toString())));
  const next = (pred: (m: any) => boolean, ms = 2000) => new Promise<any>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    const check = () => { const m = inbox.find(pred); if (m) { clearTimeout(t); resolve(m); } else setTimeout(check, 10); };
    check();
  });
  return { ws, inbox, next, send: (m: unknown) => ws.send(JSON.stringify(m)), ready: new Promise<void>((r) => ws.on("open", () => r())) };
}

describe("ws-server", () => {
  it("joins, speaks, and streams events to both the player and the facilitator", async () => {
    const scenario = await loadScenario(fixture);
    const engine = new SessionEngine({ scenario, log: new MemoryEventLog("local"), clock: new FakeClock(0) });
    const host = new SessionHost({ scenario, engine, npcProvider: new MockModelProvider(["Hi!"]), gmProvider: new MockModelProvider(), clock: new FakeClock(0) });
    const hosts = new Map([["local", host]]);
    server = await startServer({ port: 0, hosts });
    const port = server.port;

    const fac = open(port); await fac.ready;
    fac.send({ type: "join_facilitator", sessionId: "local" });
    await fac.next((m) => m.type === "joined" && m.roleId === "facilitator");

    const player = open(port); await player.ready;
    player.send({ type: "join", sessionId: "local", roleId: "host", participantId: "p1" });
    const joined = await player.next((m) => m.type === "joined");
    expect(joined.brief).toMatch(/hosting/);

    fac.send({ type: "start" });
    await player.next((m) => m.type === "event" && m.event.type === "scene.entered");
    player.send({ type: "say", text: "Hello Sam" });
    const reply = await player.next((m) => m.type === "event" && m.event.type === "utterance" && m.event.roleId === "guest");
    expect(reply.event.text).toBe("Hi!");
    await fac.next((m) => m.type === "event" && m.event.type === "utterance" && m.event.roleId === "guest");

    const dup = open(port); await dup.ready;
    dup.send({ type: "join", sessionId: "local", roleId: "host", participantId: "p2" });
    const err = await dup.next((m) => m.type === "error");
    expect(err.code).toBe("role_taken");
    fac.ws.close(); player.ws.close(); dup.ws.close();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm --filter @acr/runtime test host`
Expected: FAIL — modules not found.

- [ ] **Step 4: Write the protocol**

`services/runtime/src/host/protocol.ts`:
```ts
import { z } from "zod";
import type { SessionEvent, SessionState } from "@acr/events";

const FacilitatorCommandSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("pause") }), z.object({ command: z.literal("resume") }), z.object({ command: z.literal("advance") }),
  z.object({ command: z.literal("fire_inject"), injectId: z.string() }),
  z.object({ command: z.literal("whisper"), roleId: z.string(), text: z.string() }),
  z.object({ command: z.literal("set_npc_stance"), roleId: z.string(), goals: z.array(z.string()) }),
]);

export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("join"), sessionId: z.string(), roleId: z.string(), participantId: z.string().min(1) }),
  z.object({ type: z.literal("join_facilitator"), sessionId: z.string() }),
  z.object({ type: z.literal("start") }),
  z.object({ type: z.literal("say"), text: z.string().min(1).max(2_000) }),
  z.object({ type: z.literal("command"), command: FacilitatorCommandSchema }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export type ServerMessage =
  | { type: "joined"; roleId: string | "facilitator"; brief?: string; privateFacts?: string[]; state: SessionState }
  | { type: "event"; event: SessionEvent }
  | { type: "error"; code: string; message: string };
```
Add `"zod": "^3.23.0"` to `services/runtime/package.json` dependencies and run `pnpm install`.

- [ ] **Step 5: Write the session host**

`services/runtime/src/host/session-host.ts`:
```ts
import type { SessionEvent } from "@acr/events";
import type { NpcRole, Scenario } from "@acr/script";
import type { ModelProvider } from "@acr/adapters";
import type { Clock } from "../engine/clock.js";
import { EngineError, type SessionEngine } from "../engine/session-engine.js";
import { NpcAgent } from "../agents/npc-agent.js";
import { GameMaster } from "../agents/game-master.js";

export class HostError extends Error {
  constructor(readonly code: "role_taken" | "unknown_role" | "npc_role" | "not_started") { super(code); this.name = "HostError"; }
}

export class SessionHost {
  readonly assignments: Record<string, string> = {};
  readonly engine: SessionEngine;
  private readonly scenario: Scenario;
  private readonly npcs = new Map<string, NpcAgent>();
  private readonly gm: GameMaster;
  private started = false;
  private queue: Promise<void> = Promise.resolve();
  private ticker: NodeJS.Timeout | null = null;

  constructor(opts: { scenario: Scenario; engine: SessionEngine; npcProvider: ModelProvider; gmProvider: ModelProvider; clock: Clock }) {
    this.scenario = opts.scenario; this.engine = opts.engine;
    for (const role of Object.values(opts.scenario.roles)) {
      if (role.type === "npc") this.npcs.set(role.id, new NpcAgent({ role: role as NpcRole, engine: opts.engine, provider: opts.npcProvider }));
    }
    this.gm = new GameMaster({ engine: opts.engine, provider: opts.gmProvider });
  }

  join(roleId: string, participantId: string): { brief: string; privateFacts: string[] } {
    const role = this.scenario.roles[roleId];
    if (!role) throw new HostError("unknown_role");
    if (role.type !== "player") throw new HostError("npc_role");
    if (this.assignments[roleId] && this.assignments[roleId] !== participantId) throw new HostError("role_taken");
    this.assignments[roleId] = participantId;
    return { brief: role.brief, privateFacts: role.private_facts };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.engine.start(this.assignments);
  }

  /** Serialises everything that mutates the session so NPC turns never interleave. */
  private enqueue(fn: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(fn, fn);
    return this.queue;
  }

  async onPlayerUtterance(roleId: string, text: string): Promise<void> {
    if (!this.started) throw new HostError("not_started");
    await this.engine.say(roleId, text);
    return this.enqueue(async () => {
      const scene = this.engine.currentScene();
      if (!scene) return;
      for (const id of scene.participants) {
        const agent = this.npcs.get(id);
        if (agent) { try { await agent.respond(); } catch (err) { if (!(err instanceof EngineError)) throw err; } }
      }
      await this.gm.tick();
    });
  }

  async command(cmd: Parameters<SessionEngine["command"]>[0]): Promise<void> {
    await this.engine.command(cmd);
    return this.enqueue(() => this.gm.tick());
  }

  startTicker(ms: number): void { this.ticker = setInterval(() => void this.enqueue(() => this.gm.tick()), ms); }
  stopTicker(): void { if (this.ticker) clearInterval(this.ticker); this.ticker = null; }
  subscribe(fn: (e: SessionEvent) => void): () => void { return this.engine.subscribe(fn); }

  filterFor(who: string | "facilitator"): (e: SessionEvent) => boolean {
    if (who === "facilitator") return () => true;
    return (e) => {
      if (e.type === "inject.fired") return e.to.includes(who);
      if (e.type === "utterance") {
        const u = this.engine.state.transcript.find((x) => x.seq === e.seq);
        const scene = this.engine.state.sceneHistory.find((s) => s.id === u?.sceneId);
        return !!scene && scene.participants.includes(who);
      }
      if (e.type === "gm.decision" || e.type === "facilitator.alert") return false;
      if (e.type === "facilitator.command") return e.command === "pause" || e.command === "resume" || (e.command === "whisper" && e.roleId === who);
      return true;
    };
  }
}
```

- [ ] **Step 6: Write the WebSocket server and main**

`services/runtime/src/host/ws-server.ts`:
```ts
import { WebSocketServer, type WebSocket } from "ws";
import { ClientMessageSchema, type ServerMessage } from "./protocol.js";
import { HostError, type SessionHost } from "./session-host.js";
import { EngineError } from "../engine/session-engine.js";

export async function startServer(opts: { port: number; hosts: Map<string, SessionHost>; log?: (m: string) => void }) {
  const log = opts.log ?? (() => {});
  const wss = new WebSocketServer({ port: opts.port });
  await new Promise<void>((r) => wss.on("listening", () => r()));
  const port = (wss.address() as { port: number }).port;
  log(`runtime listening on ws://0.0.0.0:${port}`);

  wss.on("connection", (ws: WebSocket) => {
    let host: SessionHost | null = null;
    let who: string | "facilitator" | null = null;
    let unsubscribe: (() => void) | null = null;
    const send = (m: ServerMessage) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); };
    const fail = (code: string, message: string) => send({ type: "error", code, message });

    ws.on("message", async (raw) => {
      const parsed = ClientMessageSchema.safeParse(JSON.parse(raw.toString()));
      if (!parsed.success) return fail("bad_message", parsed.error.issues[0]?.message ?? "invalid");
      const m = parsed.data;
      try {
        if (m.type === "join" || m.type === "join_facilitator") {
          const h = opts.hosts.get(m.sessionId);
          if (!h) return fail("unknown_session", m.sessionId);
          host = h;
          if (m.type === "join") {
            const { brief, privateFacts } = h.join(m.roleId, m.participantId);
            who = m.roleId;
            send({ type: "joined", roleId: m.roleId, brief, privateFacts, state: h.engine.state });
          } else {
            who = "facilitator";
            send({ type: "joined", roleId: "facilitator", state: h.engine.state });
          }
          const filter = h.filterFor(who);
          unsubscribe = h.subscribe((e) => { if (filter(e)) send({ type: "event", event: e }); });
          return;
        }
        if (!host || !who) return fail("not_joined", "join first");
        if (m.type === "start") {
          if (who !== "facilitator") return fail("forbidden", "only the facilitator may start the session");
          await host.start();
          return;
        }
        if (m.type === "say") {
          if (who === "facilitator") return fail("forbidden", "the facilitator cannot speak as a role");
          if (host.engine.state.status === "idle") await host.start();
          await host.onPlayerUtterance(who, m.text);
        }
        if (m.type === "command") {
          if (who !== "facilitator") return fail("forbidden", "only the facilitator may send commands");
          if (host.engine.state.status === "idle") await host.start();
          await host.command(m.command);
        }
      } catch (err) {
        if (err instanceof HostError || err instanceof EngineError) return fail(err.code, err.message);
        log(`error: ${(err as Error).stack}`); fail("internal", "internal error");
      }
    });
    ws.on("close", () => unsubscribe?.());
  });

  return { port, close: () => new Promise<void>((r) => wss.close(() => r())) };
}
```

`services/runtime/src/main.ts`:
```ts
import "dotenv/config";
import { loadScenario, validateScenario } from "@acr/script";
import { selectModelProvider } from "@acr/adapters";
import { SessionEngine } from "./engine/session-engine.js";
import { JsonlEventLog } from "./engine/event-log.js";
import { SystemClock } from "./engine/clock.js";
import { SessionHost } from "./host/session-host.js";
import { startServer } from "./host/ws-server.js";

const scenarioDir = process.env.SCENARIO_DIR ?? "scenarios/friday-escalation";
const sessionId = process.env.SESSION_ID ?? "local";
const port = Number(process.env.RUNTIME_PORT ?? 8080);

const scenario = await loadScenario(scenarioDir);
const { errors, warnings } = validateScenario(scenario);
for (const w of warnings) console.warn(`warning: ${w}`);
if (errors.length) { for (const e of errors) console.error(`error: ${e}`); process.exit(1); }

const clock = new SystemClock();
const engine = new SessionEngine({ scenario, log: new JsonlEventLog(sessionId), clock });
const host = new SessionHost({ scenario, engine, npcProvider: selectModelProvider(process.env, "npc"), gmProvider: selectModelProvider(process.env, "gm"), clock });
host.startTicker(1_000);
const server = await startServer({ port, hosts: new Map([[sessionId, host]]), log: console.log });
console.log(`scenario "${scenario.meta.title}" v${scenario.meta.version}; session "${sessionId}"; players: ${Object.values(scenario.roles).filter((r) => r.type === "player").map((r) => r.id).join(", ")}`);
process.on("SIGINT", async () => { host.stopTicker(); await server.close(); process.exit(0); });
```
Add `"dotenv": "^16.4.0"` to `services/runtime` dependencies and run `pnpm install`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @acr/runtime test`
Expected: 31 passed.

- [ ] **Step 8: Commit**

```bash
git add services/runtime
git commit -m "[feat] US-0009: session host, WebSocket protocol and runtime entry point"
```

---

### Task 10: Terminal client (US-0010)

**Files:**
- Create: `services/runtime/src/cli/play.ts`
- Test: `services/runtime/src/cli/__tests__/render.test.ts`
- Create: `services/runtime/src/cli/render.ts`

**Interfaces:**
- Produces: `pnpm play --role delivery_lead --name Kamal [--url ws://host:8080] [--session local]` and `pnpm play --facilitator`. The facilitator types `/start`, `/pause`, `/resume`, `/advance`, `/inject <id>`, `/whisper <role> <text>`, `/quit`. Pure `renderEvent(e: SessionEvent, me: string): string | null` so the output is testable.

- [ ] **Step 1: Write the failing render test**

`services/runtime/src/cli/__tests__/render.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { renderEvent } from "../render.js";

const env = { seq: 1, ts: 0, sessionId: "s" };
describe("renderEvent", () => {
  it("renders utterances with the speaker, marking mine", () => {
    expect(renderEvent({ ...env, type: "utterance", roleId: "guest", text: "Hi", channel: "text" }, "host")).toBe("guest: Hi");
    expect(renderEvent({ ...env, type: "utterance", roleId: "host", text: "Yo", channel: "text" }, "host")).toBe("you: Yo");
  });
  it("renders scene changes and injects", () => {
    expect(renderEvent({ ...env, type: "scene.entered", sceneId: "s2", participants: ["host"] }, "host")).toBe("--- scene s2 ---");
    expect(renderEvent({ ...env, type: "inject.fired", injectId: "i", sceneId: "s", to: ["host"], content: "An email arrives." }, "host")).toBe("[inject] An email arrives.");
  });
  it("renders nothing for GM decisions to players and the decision for the facilitator", () => {
    const d = { ...env, type: "gm.decision" as const, sceneId: "s", condition: "c", verdict: true, reasoning: "r" };
    expect(renderEvent(d, "host")).toBeNull();
    expect(renderEvent(d, "facilitator")).toBe("[gm] c => true (r)");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @acr/runtime test render`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the renderer and the client**

`services/runtime/src/cli/render.ts`:
```ts
import type { SessionEvent } from "@acr/events";

export function renderEvent(e: SessionEvent, me: string): string | null {
  switch (e.type) {
    case "utterance": return `${e.roleId === me ? "you" : e.roleId}: ${e.text}`;
    case "scene.entered": return `--- scene ${e.sceneId} ---`;
    case "scene.exited": return `--- scene ${e.sceneId} ended (${e.reason}) ---`;
    case "inject.fired": return `[inject] ${e.content}`;
    case "gm.decision": return me === "facilitator" ? `[gm] ${e.condition} => ${e.verdict} (${e.reasoning})` : null;
    case "facilitator.alert": return me === "facilitator" ? `[alert] ${e.message}` : null;
    case "facilitator.command": return e.command === "whisper" ? `[whisper] ${e.text}` : `[facilitator] ${e.command}`;
    case "session.started": return `session started: ${e.scenarioId} v${e.version}`;
    case "session.ended": return `=== session ended (${e.reason}) ===`;
    case "npc.updated": return me === "facilitator" ? `[npc ${e.roleId}] goals: ${e.goals.join("; ")}` : null;
  }
}
```

`services/runtime/src/cli/play.ts`:
```ts
import readline from "node:readline";
import WebSocket from "ws";
import { parseArgs } from "node:util";
import { renderEvent } from "./render.js";

const { values } = parseArgs({ options: {
  role: { type: "string" }, name: { type: "string" }, facilitator: { type: "boolean", default: false },
  url: { type: "string", default: "ws://127.0.0.1:8080" }, session: { type: "string", default: "local" },
} });
if (!values.facilitator && (!values.role || !values.name)) { console.error("usage: pnpm play --role <roleId> --name <you> | --facilitator"); process.exit(2); }
const me = values.facilitator ? "facilitator" : values.role!;

const ws = new WebSocket(values.url!);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: `${me}> ` });
const send = (m: unknown) => ws.send(JSON.stringify(m));

ws.on("open", () => {
  send(values.facilitator ? { type: "join_facilitator", sessionId: values.session } : { type: "join", sessionId: values.session, roleId: values.role, participantId: values.name });
});
ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === "joined") {
    console.log(`joined as ${m.roleId}`);
    if (m.brief) console.log(`\nYour brief: ${m.brief}\n${(m.privateFacts ?? []).map((f: string) => `  - ${f}`).join("\n")}\n`);
    rl.prompt();
  } else if (m.type === "event") {
    const line = renderEvent(m.event, me);
    if (line) { readline.clearLine(process.stdout, 0); readline.cursorTo(process.stdout, 0); console.log(line); rl.prompt(true); }
  } else if (m.type === "error") { console.log(`error: ${m.code} ${m.message}`); rl.prompt(true); }
});
ws.on("close", () => { console.log("disconnected"); process.exit(0); });

rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return rl.prompt();
  if (text === "/quit") return ws.close();
  if (me === "facilitator") {
    const [cmd, ...rest] = text.slice(1).split(" ");
    if (text === "/start") { send({ type: "start" }); return rl.prompt(); }
    const map: Record<string, unknown> = {
      pause: { command: "pause" }, resume: { command: "resume" }, advance: { command: "advance" },
      inject: { command: "fire_inject", injectId: rest[0] }, whisper: { command: "whisper", roleId: rest[0], text: rest.slice(1).join(" ") },
    };
    if (!text.startsWith("/") || !map[cmd]) console.log("commands: /start /pause /resume /advance /inject <id> /whisper <role> <text> /quit");
    else send({ type: "command", command: map[cmd] });
  } else send({ type: "say", text });
  rl.prompt();
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @acr/runtime test`
Expected: 34 passed.

- [ ] **Step 5: Commit**

```bash
git add services/runtime
git commit -m "[feat] US-0010: terminal play client for players and the facilitator"
```

---

### Task 11: The Friday Escalation scenario and the simulation test (US-0011)

**Files:**
- Create: `scenarios/friday-escalation/scenario.yaml`, `roles/client_sponsor.yaml`, `roles/delivery_lead.yaml`, `roles/tech_lead.yaml`, `roles/account_manager.yaml`, `script.yaml`
- Test: `services/runtime/src/__tests__/simulation.test.ts`

**Interfaces:**
- Consumes: everything above. Produces nothing new; this task proves the slice.

- [ ] **Step 1: Write the scenario (from Spec §6, completed)**

`scenarios/friday-escalation/scenario.yaml`:
```yaml
id: esc-scope-creep-01
title: The Friday Escalation
version: "1.2"
audience: Delivery leads and project managers
duration_minutes: 45
players: { min: 3, max: 3 }
context: >
  A fixed-fee data platform programme is six weeks from go-live. The client
  sponsor has emailed asking for a "small" additional reconciliation module
  before launch and expects an answer by end of day Friday.
learning_objectives:
  - id: LO1
    statement: Separate the client's stated request from their underlying need before responding
    rubric_criteria: [discovery, listening]
  - id: LO2
    statement: Protect scope and margin while preserving the relationship
    rubric_criteria: [negotiation, commercial_judgement]
  - id: LO3
    statement: Align the delivery team on one position before engaging the client
    rubric_criteria: [team_alignment, role_clarity]
rubrics: [individual_delivery_v2, group_collaboration_v1]
facilitator_notes: >
  Common failure mode is agreeing to the module in scene 2 without pricing it.
  Let it happen; the debrief is where the learning lands.
```

`roles/client_sponsor.yaml`:
```yaml
id: client_sponsor
name: Priya Raman
type: npc
title: VP Operations, client side
persona: >
  Direct, time-poor, under pressure from her CFO. Likes the team but is
  testing whether they will push back. Respects clear reasoning; dislikes
  being told "we'll take it away and come back".
goals:
  - Get the reconciliation module before go-live
  - Avoid a change request going to her CFO
knowledge:
  - The CFO has already asked why the programme costs what it does
  - The module was in an early scope draft but was removed in contract negotiation
hidden:
  - Would accept a phased delivery after go-live if the risk is explained well
guardrails:
  - Never reveal hidden information unless a player asks a question that earns it
  - Stay professional; frustration shows as brevity, not rudeness
  - Do not invent contractual facts beyond the knowledge list
fallback_line: Sorry, you cut out for a second there. Say that again?
voice: { style: warm-but-brisk, pace: fast }
```

`roles/delivery_lead.yaml`:
```yaml
id: delivery_lead
type: player
brief: >
  You run the programme day to day. Margin is already thin. You want to keep
  Priya happy without eating the cost of the module.
private_facts:
  - The module is roughly 6 person-weeks of work
  - Your account lead has hinted that a renewal is being discussed
```

`roles/tech_lead.yaml`:
```yaml
id: tech_lead
type: player
brief: >
  You own the architecture. A reconciliation module touches the ingestion
  layer that is still being hardened for go-live.
private_facts:
  - Adding the module before go-live puts the go-live date at real risk
  - A phased version after go-live would be about half the effort
```

`roles/account_manager.yaml`:
```yaml
id: account_manager
type: player
brief: >
  You own the commercial relationship. A renewal conversation is live and
  you do not want this request to sour it.
private_facts:
  - The renewal is worth roughly three times this programme
  - Priya's CFO is the renewal decision maker
```

`script.yaml`:
```yaml
scenes:
  - id: s1_huddle
    title: Team huddle
    goal: Agree the team's position before replying to the client
    participants: [delivery_lead, tech_lead, account_manager]
    time_box_minutes: 10
    opening_inject: email_from_priya
    injects:
      - id: email_from_priya
        to: [delivery_lead, tech_lead, account_manager]
        content: >
          Email from Priya Raman: "Quick one. Before go-live we need a small
          reconciliation module so Finance can tie out the daily loads. I know
          it's late but it's a must-have. Can you confirm by end of day Friday?"
    exit_when:
      any_of:
        - time_box_elapsed
        - facilitator_advance
        - gm_detects: "the team has stated a single agreed position on the request"
  - id: s2_client_call
    title: Call with Priya
    goal: Respond to the request and agree next steps
    participants: [delivery_lead, account_manager, client_sponsor]
    time_box_minutes: 15
    injects:
      - id: cfo_pressure
        at_minute: 7
        to: [client_sponsor]
        content: Priya's CFO messages her during the call asking for an update.
        effect: { goals_add: ["Get a yes on this call"] }
    exit_when:
      any_of:
        - time_box_elapsed
        - facilitator_advance
        - gm_detects: "a concrete next step has been agreed between the team and Priya"
  - id: s3_internal_wrap
    title: Internal wrap-up
    goal: Capture decisions, owners and the message to the wider team
    participants: [delivery_lead, tech_lead, account_manager]
    time_box_minutes: 8
    exit_when: { any_of: [time_box_elapsed, facilitator_advance] }
```

- [ ] **Step 2: Write the simulation test**

`services/runtime/src/__tests__/simulation.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenario, validateScenario } from "@acr/script";
import { MockModelProvider } from "@acr/adapters";
import { SessionEngine } from "../engine/session-engine.js";
import { MemoryEventLog } from "../engine/event-log.js";
import { FakeClock } from "../engine/clock.js";
import { SessionHost } from "../host/session-host.js";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../scenarios/friday-escalation");

describe("The Friday Escalation, simulated", () => {
  it("validates cleanly", async () => {
    const { errors, warnings } = validateScenario(await loadScenario(dir));
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("plays through all three scenes with scripted participants and a scripted GM", async () => {
    const scenario = await loadScenario(dir);
    const clock = new FakeClock(0);
    const log = new MemoryEventLog("sim");
    const engine = new SessionEngine({ scenario, log, clock });
    const npc = new MockModelProvider([
      "Thanks for calling. So, can you confirm the reconciliation module for go-live?",
      "I hear you. What would phasing actually look like for Finance?",
      "Alright. Send me the phased plan by Monday and I'll take it to the CFO.",
    ]);
    const gm = new MockModelProvider([
      '{"verdict": false, "reasoning": "still discussing"}',
      '{"verdict": true, "reasoning": "delivery lead summarised one position and the others agreed"}',
      '{"verdict": false, "reasoning": "no next step yet"}',
      '{"verdict": true, "reasoning": "a phased plan by Monday was agreed"}',
    ]);
    const host = new SessionHost({ scenario, engine, npcProvider: npc, gmProvider: gm, clock });
    host.join("delivery_lead", "A"); host.join("tech_lead", "B"); host.join("account_manager", "C");
    await host.start();

    // Scene 1: opening inject lands for all three; no NPC in the room.
    expect(engine.state.currentScene?.id).toBe("s1_huddle");
    expect(engine.state.injectsFired).toEqual(["email_from_priya"]);
    await host.onPlayerUtterance("delivery_lead", "Did everyone see Priya's email?");
    await host.onPlayerUtterance("tech_lead", "Yes. Doing it before go-live is a real risk.");
    await host.onPlayerUtterance("account_manager", "And the renewal is live, so we can't just say no.");
    expect(npc.calls).toHaveLength(0);
    expect(engine.state.currentScene?.id).toBe("s1_huddle"); // first GM verdict false
    await host.onPlayerUtterance("delivery_lead", "Position: we offer a phased module after go-live, priced, and explain the risk.");
    await host.onPlayerUtterance("tech_lead", "Agreed."); await host.onPlayerUtterance("account_manager", "Agreed.");
    expect(engine.state.currentScene?.id).toBe("s2_client_call"); // second verdict true

    // Scene 2: Priya replies to every player line; the CFO inject fires at minute 7.
    await host.onPlayerUtterance("delivery_lead", "Hi Priya, thanks for making time.");
    expect(engine.state.transcript.at(-1)?.roleId).toBe("client_sponsor");
    clock.advance(7 * 60_000);
    await host.command({ command: "resume" }); // any command runs a GM tick; injects fire
    expect(engine.state.injectsFired).toContain("cfo_pressure");
    expect(engine.state.npcs.client_sponsor.goals).toContain("Get a yes on this call");
    await host.onPlayerUtterance("account_manager", "We can phase the module after go-live and price it properly.");
    await host.onPlayerUtterance("delivery_lead", "We'll send the phased plan by Monday.");
    await host.onPlayerUtterance("account_manager", "Does that work?");
    expect(engine.state.currentScene?.id).toBe("s3_internal_wrap");

    // Scene 3 ends on its time box.
    clock.advance(8 * 60_000);
    await host.command({ command: "resume" });
    expect(engine.state.status).toBe("ended");

    const events = await log.all();
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    expect(events.filter((e) => e.type === "gm.decision")).toHaveLength(4);
    // Guardrail: Priya's prompts never contained hidden info or player briefs.
    for (const req of npc.calls) {
      const all = req.system + JSON.stringify(req.messages);
      expect(all).not.toContain("phased delivery after go-live if the risk");
      expect(all).not.toContain("6 person-weeks");
    }
  });
});
```

- [ ] **Step 3: Run the simulation**

Run: `pnpm --filter @acr/runtime test simulation`
Expected: 2 passed. If the GM verdict order does not line up with the turn count, adjust `everyNUtterances` in the `SessionHost` constructor call (the default is 3) rather than the scripted verdicts; the test is written for the default.

- [ ] **Step 4: Commit**

```bash
git add scenarios services/runtime/src/__tests__
git commit -m "[feat] US-0011: Friday Escalation scenario and end-to-end simulation test"
```

---

### Task 12: One-command local start, README and CI (US-0012)

**Files:**
- Create: `deploy/compose/docker-compose.yml`, `deploy/compose/Dockerfile.runtime`, `run.sh`
- Create: `.github/workflows/ci.yml`
- Modify: `README.md`
- Modify: `plan-visualizer.config.json` (project name and tagline)

**Interfaces:**
- Produces: `./run.sh` starts the runtime in Docker on port 8080 with the Friday Escalation scenario; `./run.sh --dev` runs it with `tsx watch` outside Docker. CI runs typecheck, tests and the SDK-import check on every push and PR.

- [ ] **Step 1: Write the container files**

`deploy/compose/Dockerfile.runtime`:
```dockerfile
FROM node:22-alpine
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
COPY services ./services
COPY scenarios ./scenarios
RUN pnpm install --frozen-lockfile --prod=false
EXPOSE 8080
CMD ["pnpm", "--filter", "@acr/runtime", "start"]
```

`deploy/compose/docker-compose.yml`:
```yaml
services:
  runtime:
    build: { context: ../.., dockerfile: deploy/compose/Dockerfile.runtime }
    env_file: ../../.env
    environment:
      RUNTIME_PORT: "8080"
      SCENARIO_DIR: scenarios/friday-escalation
    ports: ["8080:8080"]
    volumes:
      - ../../data:/app/data
      - ../../scenarios:/app/scenarios:ro
```

`run.sh`:
```bash
#!/usr/bin/env bash
# One-command local start. ./run.sh (Docker) or ./run.sh --dev (tsx watch, no Docker).
set -euo pipefail
cd "$(dirname "$0")"
[ -f .env ] || { cp .env.example .env; echo "created .env from .env.example (MODEL_PROVIDER=mock)"; }
if [ "${1:-}" = "--dev" ]; then
  corepack enable >/dev/null 2>&1 || true
  pnpm install
  exec pnpm dev:runtime
fi
docker compose -f deploy/compose/docker-compose.yml up --build
```
Run `chmod +x run.sh`.

- [ ] **Step 2: Write the CI workflow**

`.github/workflows/ci.yml`:
```yaml
name: ci
on: { push: { branches: [main, develop] }, pull_request: {} }
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck
      - run: pnpm lint:sdk
      - run: pnpm test -- --coverage
```

- [ ] **Step 3: Write the README quickstart**

Replace `README.md` with:
```markdown
# AI Coaching RPG

A multiplayer, script-driven role-play simulator for team training. Participants play scripted scenarios against AI-played counterparts; everything is recorded and later scored against rubrics.

Slice 1 (this build): text-only sessions from a laptop, with NPC agents and a Game Master, playable from a terminal.

## Quick start (one laptop, three terminals)

    ./run.sh --dev                      # starts the runtime on ws://0.0.0.0:8080 with the Friday Escalation scenario

In other terminals (same machine, or any machine on the LAN using the host's IP):

    pnpm play --facilitator
    pnpm play --role delivery_lead --name Kamal --url ws://<host-ip>:8080
    pnpm play --role tech_lead --name Alex --url ws://<host-ip>:8080
    pnpm play --role account_manager --name Sam --url ws://<host-ip>:8080

Players type to speak. Once everyone has joined, the facilitator types `/start`; after that `/advance`, `/pause`, `/resume`, `/inject <id>`, `/whisper <role> <text>`. (If a player speaks before `/start`, the session starts with whoever has joined.)

By default NPCs use a scripted mock. For real NPCs set `MODEL_PROVIDER=anthropic` and `ANTHROPIC_API_KEY` in `.env`.

## Layout

    packages/events     session event types and the state reducer
    packages/script     scenario YAML schema, loader, validator, scene FSM
    packages/adapters   provider adapters (model; later storage, queue, speech)
    services/runtime    session engine, NPC agents, Game Master, WebSocket server, terminal client
    scenarios/          playable scenarios (YAML)
    docs/ARCHITECTURE.md  the technical architecture this implements

## Develop

    pnpm install && pnpm test && pnpm typecheck
```

Set in `plan-visualizer.config.json`: `"name": "AI Coaching RPG"`, `"tagline": "Script-driven multiplayer role-play training with AI counterparts."`

- [ ] **Step 4: Verify the one-command start**

Run: `./run.sh --dev` in one terminal; in another `pnpm play --facilitator`, then in a third `pnpm play --role delivery_lead --name Test`.
Expected: after `/start` the facilitator sees `session started` and `--- scene s1_huddle ---` and the inject text; typing a line as `delivery_lead` echoes `you: ...` and, with the mock provider, nothing from Priya until scene 2 (she is not in the huddle). Type `/advance` as the facilitator; scene 2 begins; the next player line gets `client_sponsor: [mock reply]`.

Run: `docker compose -f deploy/compose/docker-compose.yml build`
Expected: image builds.

- [ ] **Step 5: Commit, push, open the PR**

```bash
git add -A
git commit -m "[chore] US-0012: one-command local start, README, CI"
git push -u origin feature/EPIC-0001-US-0001-monorepo
gh pr create --base main --title "EPIC-0001 Slice 1: script package and text-only runtime" --body "Implements docs/superpowers/plans/2026-10-01-slice-1-script-and-text-runtime.md (US-0001 to US-0012)."
```

---

## Self-review notes

- **Spec coverage.** Architecture §3 session state and reconnect: the event log and reducer exist; reconnect replay is deferred to slice 2 with the web client, noted in RELEASE_PLAN as US-0013. §4 NPC fast path and GM beside the path: Tasks 7 and 8. §4 guardrails: enforced in `buildNpcRequest` and asserted in Task 7 and Task 11. §4 timeout fallback: Task 7. §9 adapter rule: Task 5 lint. §10 Stage A one command: Task 12. Voice, 3D, Postgres and Redis are deliberately out of this slice.
- **Interfaces.** `SessionEngine.emit` is made public in Task 7 and `log` in Task 8; both are referenced consistently afterwards.
- **Review Focus** tests are in Tasks 3, 6, 7, 8 and 9 as listed.
