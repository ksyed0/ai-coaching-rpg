/**
 * The identifier rules (US-0020, AC-0062). Every place that validates a scenario, role, scene, inject, rubric, learning-objective,
 * session or client-supplied id imports its rule from here, so the rules cannot drift apart. Pure, no dependencies.
 *
 * Why it matters: a session id becomes the file names `<id>.jsonl`, `<id>.lock` and `<id>.codes.json` (and a report directory), a role
 * or scene id becomes an object key and a report file name, and a client-supplied id is untrusted input. The rules below are
 * deliberately narrow: no dot, slash, backslash, space, control character or non-ASCII character in anything that reaches a file
 * system, so a name can never be `..`, hidden (a leading dot), absolute or a path with a separator.
 *
 * Three families, kept exactly as they were when they lived in four modules:
 *  - SCENARIO ids (scenario, role, scene, inject, `defer_to`): lower case letters, digits, `_`, `-`; any length >= 1.
 *  - FILE-SAFE ids (rubric and criterion ids, evaluator report role ids): the same characters, 1 to 64.
 *  - SAFE ids (session ids, learning objectives): letters of either case, digits, `_`, `-`; 1 to 64.
 * plus the transport bound of an id a client sends (1 to 128 characters; the host then looks it up as an own property or a Map key,
 * so its content cannot reach a file name) and the reserved words.
 *
 * Known, intentional difference: a SCENARIO id has no length limit while a role id used as a report file name is limited to 64 (the
 * evaluator refuses a longer one when it writes reports). Tightening the scenario rule would refuse scenarios that load today.
 */

/** Ids that resolve to inherited members of a plain object. Refused for roles and scenes; a Map or own-property lookup is safe, but a plain `obj[id]` is not. */
export const PROTOTYPE_KEYS: readonly string[] = Object.freeze(["__proto__", "constructor", "prototype"]);
/** The id the facilitator's connection uses: no role may have it. */
export const FACILITATOR_ROLE_ID = "facilitator";
export const isPrototypeKey = (id: string): boolean => typeof id === "string" && PROTOTYPE_KEYS.includes(id);
/** A role id that may never be given to a scenario role, nor a join code. */
export const isReservedRoleId = (id: string): boolean => id === FACILITATOR_ROLE_ID || isPrototypeKey(id);

/** The longest file-safe or safe id. */
export const SAFE_ID_MAX_CHARS = 64;

/** Scenario, role, scene, inject and `defer_to` ids. No length limit (see the note above). */
export const SCENARIO_ID_PATTERN = /^[a-z0-9_-]+$/;
/** The same characters as a regular-expression class, for code that reads an id out of a longer text (a prompt line); it must not drift from the pattern above. */
export const SCENARIO_ID_CLASS = "[a-z0-9_-]";
export const SCENARIO_ID_MESSAGE = "ids are lowercase letters, digits, _ or -";
export const isScenarioId = (id: string): boolean => typeof id === "string" && SCENARIO_ID_PATTERN.test(id);

/** Rubric ids, criterion ids and the role ids of evaluator report files: a scenario id of at most 64 characters. */
export const FILE_SAFE_ID_PATTERN = /^[a-z0-9_-]{1,64}$/;
export const isFileSafeId = (id: string): boolean => typeof id === "string" && FILE_SAFE_ID_PATTERN.test(id);

/** Session ids and learning-objective ids: letters of either case, digits, `_`, `-`, 1 to 64. */
export const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Strings only: `RegExp.test` would turn undefined, null or `["a"]` into "undefined", "null" or "a" and accept them. */
export const isSafeId = (id: string): boolean => typeof id === "string" && SAFE_ID_PATTERN.test(id);
export const LEARNING_OBJECTIVE_ID_MESSAGE = "learning objective ids are 1 to 64 letters, digits, _ or -";

/** A role key an operator types for another server (the demo's JOIN_CODES `role=CODE`): letters of either case, digits, `_`, `-`, 1 to 128. */
export const CLIENT_ROLE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const isClientRoleKey = (v: string): boolean => typeof v === "string" && CLIENT_ROLE_KEY_PATTERN.test(v);

/** The single source of truth for what a session id may be (it becomes a file name). */
export const isValidSessionId = (id: string): boolean => isSafeId(id);
/** The rule in words, for refusals. */
export const SESSION_ID_RULE_TEXT = "1 to 64 letters, digits, '_' or '-'";

/** The longest id a client may send in a message or type on the command line. */
export const CLIENT_ID_MAX_CHARS = 128;
/** C0 controls, DEL and C1 controls. */
export const hasControlCharacters = (v: string): boolean => /[\u0000-\u001f\u007f-\u009f]/.test(v);
/** The terminal client's check of an id or session it was given: 1 to 128 characters and no control character. */
export const isClientSuppliedId = (v: string): boolean => typeof v === "string" && v.length >= 1 && v.length <= CLIENT_ID_MAX_CHARS && !hasControlCharacters(v);
