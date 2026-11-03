import { SAFE_ID_MAX_CHARS } from "@acr/events";
import type { Bind } from "./credentials.js";

/**
 * US-0060: which player roles of a lobby are played by an AI. The set is kept in `<id>.ai-roles.json` beside the credentials and
 * consent files until the start; after the start the log (`session.started.aiRoles`) is the record.
 */
export const AI_ROLES_RECORD_VERSION = 1;

export type AiRolesRecord = { v: 1; sessionId: string; scenarioSha256: string; roles: string[] };

/** An AI-role record that cannot be used. The message never contains a value from the record. */
export class AiRolesRecordError extends Error {
  constructor(message: string) { super(message); this.name = "AiRolesRecordError"; }
}

const HEX64 = /^[0-9a-f]{64}$/;

export class AiRoleSet {
  private roles: string[];
  private constructor(roles: string[]) { this.roles = roles; }

  static empty(): AiRoleSet { return new AiRoleSet([]); }

  /** Throws AiRolesRecordError (never quoting the record) for an invalid record or one bound to another session or scenario. */
  static fromRecord(raw: unknown, bind: Bind & { roleIds: string[] }): AiRoleSet {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new AiRolesRecordError("the AI-role file is not a JSON object");
    const r = raw as Record<string, unknown>;
    if (Object.keys(r).sort().join(",") !== "roles,scenarioSha256,sessionId,v") throw new AiRolesRecordError("the AI-role file has missing or unexpected fields");
    if (r.v !== AI_ROLES_RECORD_VERSION) throw new AiRolesRecordError("the AI-role file has an unknown format version");
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
    return new AiRoleSet(bind.roleIds.filter((id) => seen.has(id))); // bind (scenario) order
  }

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
    return { v: AI_ROLES_RECORD_VERSION, sessionId: bind.sessionId, scenarioSha256: bind.scenarioSha256, roles: [...this.roles] };
  }
}
