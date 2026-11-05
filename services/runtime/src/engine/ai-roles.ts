import { SAFE_ID_MAX_CHARS } from "@acr/events";
import type { Bind } from "./credentials.js";

/**
 * US-0060: which player roles of a lobby are played by an AI. The set is kept in `<id>.ai-roles.json` beside the credentials and
 * consent files until the start; after the start the log (`session.started.aiRoles`) is the record.
 */
export const AI_ROLES_RECORD_VERSION = 2;

/**
 * US-0061: v1 is what 3b wrote and means "AI players count toward group scores". v2 is written only while that option is OFF
 * (`includeInGroup: false`), so a lobby with the default option stays a file an older build reads.
 */
export type AiRolesRecord =
  | { v: 1; sessionId: string; scenarioSha256: string; roles: string[] }
  | { v: 2; sessionId: string; scenarioSha256: string; roles: string[]; includeInGroup: boolean };

const V1_KEYS = "roles,scenarioSha256,sessionId,v";
const V2_KEYS = "includeInGroup,roles,scenarioSha256,sessionId,v";

/** An AI-role record that cannot be used. The message never contains a value from the record. */
export class AiRolesRecordError extends Error {
  constructor(message: string) { super(message); this.name = "AiRolesRecordError"; }
}

const HEX64 = /^[0-9a-f]{64}$/;

export class AiRoleSet {
  private roles: string[];
  private include: boolean;
  private constructor(roles: string[], include = true) { this.roles = roles; this.include = include; }

  static empty(): AiRoleSet { return new AiRoleSet([]); }

  /** Throws AiRolesRecordError (never quoting the record) for an invalid record or one bound to another session or scenario. */
  static fromRecord(raw: unknown, bind: Bind & { roleIds: string[] }): AiRoleSet {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new AiRolesRecordError("the AI-role file is not a JSON object");
    const r = raw as Record<string, unknown>;
    const keys = Object.keys(r).sort().join(",");
    if (keys !== V1_KEYS && keys !== V2_KEYS) throw new AiRolesRecordError("the AI-role file has missing or unexpected fields");
    // The key set decides the version: a v1 body must say 1, a v2 body must say 2 (anything else is an unknown version).
    if (r.v !== (keys === V2_KEYS ? 2 : 1)) throw new AiRolesRecordError("the AI-role file has an unknown format version");
    // v2 exists only for the OFF option, so it must say exactly false.
    if (keys === V2_KEYS && r.includeInGroup !== false) throw new AiRolesRecordError("the AI-role file has an invalid group-score option");
    if (typeof r.sessionId !== "string" || r.sessionId.length === 0 || r.sessionId.length > SAFE_ID_MAX_CHARS) throw new AiRolesRecordError("the AI-role file has an invalid session id");
    if (typeof r.scenarioSha256 !== "string" || !HEX64.test(r.scenarioSha256)) throw new AiRolesRecordError("the AI-role file has an invalid scenario hash");
    if (r.sessionId !== bind.sessionId || r.scenarioSha256 !== bind.scenarioSha256) throw new AiRolesRecordError("the AI-role file belongs to another session or scenario");
    const roles = r.roles;
    if (!Array.isArray(roles)) throw new AiRolesRecordError("the AI-role file has no role list");
    if (roles.length > bind.roleIds.length) throw new AiRolesRecordError("the AI-role file names too many roles");
    const seen = new Set<string>();
    for (const id of roles as unknown[]) {
      if (typeof id !== "string" || !bind.roleIds.includes(id)) throw new AiRolesRecordError("the AI-role file names a role that is not a player role of this session");
      if (seen.has(id)) throw new AiRolesRecordError("the AI-role file names a role twice");
      seen.add(id);
    }
    return new AiRoleSet(bind.roleIds.filter((id) => seen.has(id)), keys !== V2_KEYS); // bind (scenario) order
  }

  /** US-0061: whether AI players count toward group scores (default true). */
  get includeInGroup(): boolean { return this.include; }
  setIncludeInGroup(v: boolean): void { this.include = v; }

  has(roleId: string): boolean { return this.roles.includes(roleId); }
  list(): string[] { return [...this.roles]; }
  /**
   * Replaces the set with the distinct entries of `roles` that are player roles of the bind (`roleIds`, in bind order); anything else
   * (an unknown role, a duplicate, a non-string, a prototype key) is dropped, so the set can never hold garbage or be out of order.
   */
  replace(roles: readonly string[], roleIds: readonly string[]): void {
    const wanted = new Set<unknown>(roles);
    this.roles = roleIds.filter((id) => wanted.has(id));
  }

  toRecord(bind: Bind): AiRolesRecord {
    const base = { sessionId: bind.sessionId, scenarioSha256: bind.scenarioSha256, roles: [...this.roles] };
    // v1 while the option is on (byte-identical to 3b's file), v2 only when it is off.
    return this.include ? { v: 1, ...base } : { v: AI_ROLES_RECORD_VERSION, ...base, includeInGroup: false };
  }
}
