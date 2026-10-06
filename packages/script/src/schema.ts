import { z } from "zod";

const Id = z.string().regex(/^[a-z0-9_\-]+$/, "ids are lowercase letters, digits, _ or -");

/** Learning-objective ids appear in report text and file content, so they follow a safe pattern (upper case allowed: LO1). */
const LoId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "learning objective ids are 1 to 64 letters, digits, _ or -");

export const LearningObjectiveSchema = z.object({
  id: LoId, statement: z.string(), rubric_criteria: z.array(z.string()),
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

/** Limits for the voice lists of an AI character: they go into every model prompt, so they stay small. */
export const VOICE_LIST_MAX = 5;
export const VOICE_ITEM_MAX_CHARS = 160;
const VoiceList = z.array(z.string().trim().min(1).max(VOICE_ITEM_MAX_CHARS)).max(VOICE_LIST_MAX).default([]);

export const NpcRoleSchema = z.object({
  id: Id, type: z.literal("npc"), name: z.string(), title: z.string().default(""),
  persona: z.string(), goals: z.array(z.string()), knowledge: z.array(z.string()).default([]),
  hidden: z.array(z.string()).default([]), guardrails: z.array(z.string()).default([]),
  fallback_line: z.string().default("Sorry, give me a moment."),
  voice: z.object({ style: z.string().default("neutral"), pace: z.string().default("medium") }).default({}),
  /** 1 to 5, higher is more senior. Decides the order of replies when several AI characters are in a scene (junior first) and how the characters see each other. */
  seniority: z.number().int().min(1).max(5).default(3),
  /** The KIND of contribution this character makes (a ruling, a condition, a consequence...). */
  responds_with: VoiceList,
  /** Topics and statements that only this role would make. */
  only_you_say: VoiceList,
  /** Role ids of AI characters this one normally lets have the final say when both are in the scene (prompt wording only; the reply order follows seniority). */
  defer_to: z.array(Id).max(VOICE_LIST_MAX).default([]),
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
