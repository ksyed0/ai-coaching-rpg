import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { CLIENT_ID_MAX_CHARS, SAFE_ID_MAX_CHARS, isReservedRoleId } from "@acr/events";

/**
 * US-0053: one durable credential per player role, issued when a person takes a seat and kept (as a salted SHA-256 only) beside the
 * display name and the log identity in the session's credentials file. 128 random bits as 32 hex characters. The plain value exists
 * only in what `issue` returns, for the one response that hands it to the browser's server side. Never log, echo or persist it.
 * Modelled on JoinCodes: salted digest over `salt \0 roleId \0 value`, timingSafeEqual, a dummy digest for a role without one.
 */
export const CREDENTIAL_BYTES = 16;
/** The longest credential a client may send; anything longer is refused unread. */
export const MAX_CREDENTIAL_INPUT_CHARS = 64;
export const CREDENTIAL_RECORD_VERSION = 1;
/** Upper bound for a stored display name (the real limit, 60 code points, is applied before it gets here). */
const MAX_STORED_NAME_CHARS = 240;

export type Bind = { sessionId: string; scenarioSha256: string };
export type CredentialRecord = {
  v: 1; sessionId: string; scenarioSha256: string; logIdentity: string; salt: string;
  roles: Record<string, { hash: string; name: string }>;
};

/** A credentials record that cannot be used. The message never contains a value from the record. */
export class CredentialRecordError extends Error {
  constructor(message: string) { super(message); this.name = "CredentialRecordError"; }
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;

function digest(salt: Buffer, roleId: string, value: string): Buffer {
  return createHash("sha256").update(salt).update("\u0000").update(roleId, "utf8").update("\u0000").update(value, "utf8").digest();
}

export class PlayerCredentials {
  /** Compared against when the role has no credential, so every refusal costs the same work. */
  private readonly dummy: Buffer;
  private constructor(
    private readonly sessionId: string, private readonly scenarioSha256: string, private readonly id: string,
    private readonly salt: Buffer, private readonly entries: Map<string, { hash: Buffer; name: string }>,
  ) {
    this.dummy = digest(salt, "\u0000no role\u0000", "");
  }

  /** An empty registry for this session and scenario, with a fresh salt and log identity. */
  static create(bind: Bind): PlayerCredentials {
    return new PlayerCredentials(bind.sessionId, bind.scenarioSha256, randomBytes(16).toString("hex"), randomBytes(16), new Map());
  }

  /** Rebuilds the registry from its file. Throws CredentialRecordError (never quoting the record) when it is not a valid record. */
  static fromRecord(raw: unknown): PlayerCredentials {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new CredentialRecordError("the credentials file is not a JSON object");
    const r = raw as Record<string, unknown>;
    if (Object.keys(r).sort().join(",") !== "logIdentity,roles,salt,scenarioSha256,sessionId,v") throw new CredentialRecordError("the credentials file has missing or unexpected fields");
    if (r.v !== CREDENTIAL_RECORD_VERSION) throw new CredentialRecordError("the credentials file has an unknown format version");
    if (typeof r.sessionId !== "string" || r.sessionId.length === 0 || r.sessionId.length > SAFE_ID_MAX_CHARS) throw new CredentialRecordError("the credentials file has an invalid session id");
    if (typeof r.scenarioSha256 !== "string" || !HEX64.test(r.scenarioSha256)) throw new CredentialRecordError("the credentials file has an invalid scenario hash");
    if (typeof r.logIdentity !== "string" || !HEX32.test(r.logIdentity)) throw new CredentialRecordError("the credentials file has an invalid log identity");
    if (typeof r.salt !== "string" || !HEX32.test(r.salt)) throw new CredentialRecordError("the credentials file has an invalid salt");
    const roles = r.roles;
    if (typeof roles !== "object" || roles === null || Array.isArray(roles)) throw new CredentialRecordError("the credentials file has no role table");
    const entries = new Map<string, { hash: Buffer; name: string }>();
    for (const [roleId, e] of Object.entries(roles as Record<string, unknown>)) {
      if (isReservedRoleId(roleId) || roleId.length === 0 || roleId.length > CLIENT_ID_MAX_CHARS) throw new CredentialRecordError("the credentials file names an invalid role");
      if (typeof e !== "object" || e === null || Array.isArray(e) || Object.keys(e).sort().join(",") !== "hash,name") throw new CredentialRecordError("the credentials file has an invalid role entry");
      const { hash, name } = e as { hash: unknown; name: unknown };
      if (typeof hash !== "string" || !HEX64.test(hash)) throw new CredentialRecordError("the credentials file holds an invalid hash");
      if (typeof name !== "string" || name.length === 0 || name.length > MAX_STORED_NAME_CHARS) throw new CredentialRecordError("the credentials file holds an invalid name");
      entries.set(roleId, { hash: Buffer.from(hash, "hex"), name });
    }
    return new PlayerCredentials(r.sessionId, r.scenarioSha256, r.logIdentity, Buffer.from(r.salt, "hex"), entries);
  }

  /** The record to persist: hashes, names, salt and log identity only. */
  toRecord(): CredentialRecord {
    return {
      v: 1, sessionId: this.sessionId, scenarioSha256: this.scenarioSha256, logIdentity: this.id, salt: this.salt.toString("hex"),
      roles: Object.fromEntries([...this.entries].map(([k, e]) => [k, { hash: e.hash.toString("hex"), name: e.name }])),
    };
  }

  /** Random per session and stable across restarts: it keys the pseudonymous names in the log, so it is not derived from a name. */
  get logIdentity(): string { return this.id; }

  /** A new credential for `roleId` (replacing any earlier one). The returned plain value is the only copy: hand it over once, then drop it. */
  issue(roleId: string, name: string): string {
    if (isReservedRoleId(roleId) || roleId.length === 0 || roleId.length > CLIENT_ID_MAX_CHARS) throw new Error("not a valid player role");
    if (name.length === 0 || name.length > MAX_STORED_NAME_CHARS) throw new Error("not a valid display name");
    const plain = randomBytes(CREDENTIAL_BYTES).toString("hex");
    this.entries.set(roleId, { hash: digest(this.salt, roleId, plain), name });
    return plain;
  }

  /**
   * Does `presented` open `roleId`? Constant time in the value: both sides are 32-byte digests compared with timingSafeEqual, and a
   * role without a credential (unknown, an AI character, reserved, a prototype key) is compared against a dummy digest and refused.
   * A missing, empty or over-long value is refused unread; this never throws.
   */
  verify(roleId: string, presented: string | undefined): boolean {
    const expected = this.entries.get(roleId); // a Map: "__proto__" or "toString" is never a key
    const usable = typeof presented === "string" && presented.length > 0 && presented.length <= MAX_CREDENTIAL_INPUT_CHARS;
    const given = digest(this.salt, roleId, usable ? presented : "");
    const same = timingSafeEqual(given, expected?.hash ?? this.dummy);
    return same && expected !== undefined && usable;
  }

  has(roleId: string): boolean { return this.entries.has(roleId); }
  revoke(roleId: string): boolean { return this.entries.delete(roleId); }
  /** Revokes every credential and returns the roles that had one. */
  revokeAll(): string[] { const roles = [...this.entries.keys()]; this.entries.clear(); return roles; }
  nameOf(roleId: string): string | undefined { return this.entries.get(roleId)?.name; }
  names(): Record<string, string> { return Object.fromEntries([...this.entries].map(([k, e]) => [k, e.name])); }
  matches(bind: Bind): boolean { return bind.sessionId === this.sessionId && bind.scenarioSha256 === this.scenarioSha256; }
}
