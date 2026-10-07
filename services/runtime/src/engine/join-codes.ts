import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/**
 * US-0033: one random join code per player role. A code is 12 symbols of Crockford's base32 (no I, L, O or U, so nothing is
 * mistaken for 1 or 0), shown as XXXX-XXXX-XXXX: 60 bits, far beyond online guessing (one try per connection, 5 failures per
 * address per minute) and expensive offline. Only a salted SHA-256 of each code is ever kept (in memory, and in the session's
 * codes file so that the codes survive a restart); the plain codes exist only in the value `issue` returns, for the one display
 * at start. Never log, echo or persist a plain code.
 */
export const JOIN_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const JOIN_CODE_SYMBOLS = 12;
/** The longest code a client may send (spaces and hyphens included); anything longer is refused unread. */
export const MAX_JOIN_CODE_INPUT_CHARS = 64;
export const JOIN_CODE_RECORD_VERSION = 1;

/** A new code, XXXX-XXXX-XXXX. `pick(n)` returns a uniform integer in [0, n) (crypto.randomInt by default; tests inject one). */
export function newJoinCode(pick: (n: number) => number = randomInt): string {
  let s = "";
  for (let i = 0; i < JOIN_CODE_SYMBOLS; i++) s += JOIN_CODE_ALPHABET[pick(JOIN_CODE_ALPHABET.length)]!;
  return formatJoinCode(s);
}

/** What the server compares: upper case, with spaces and hyphens removed (people type codes loosely). */
export const normalizeJoinCode = (raw: string): string => raw.toUpperCase().replace(/[\s-]+/g, "");

/** XXXX-XXXX-XXXX for display. */
export const formatJoinCode = (raw: string): string => normalizeJoinCode(raw).replace(/(.{4})(?=.)/g, "$1-");

/** What the codes file holds: hashes only, bound to the session and scenario they were issued for. */
export type JoinCodeRecord = { v: 1; sessionId: string; scenarioSha256: string; salt: string; roles: Record<string, string> };

/** A codes record that cannot be used. The message never contains a value from the record. */
export class JoinCodeRecordError extends Error {
  constructor(message: string) { super(message); this.name = "JoinCodeRecordError"; }
}

const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const RESERVED = new Set(["facilitator", "__proto__", "constructor", "prototype"]);

function digest(salt: Buffer, roleId: string, normalized: string): Buffer {
  return createHash("sha256").update(salt).update("\u0000").update(roleId, "utf8").update("\u0000").update(normalized, "utf8").digest();
}

export class JoinCodes {
  /** Compared against when the role has no code (unknown, an AI character, reserved), so every refusal costs the same work. */
  private readonly dummy: Buffer;
  private constructor(private readonly sessionId: string, private readonly scenarioSha256: string, private readonly salt: Buffer, private readonly hashes: Map<string, Buffer>) {
    this.dummy = digest(salt, "\u0000no role\u0000", "");
  }

  /** New random codes for these player roles. `plain` is the only place the codes ever appear: show it once, then drop it. */
  static issue(roleIds: readonly string[], bind: { sessionId: string; scenarioSha256: string }, pick?: (n: number) => number): { codes: JoinCodes; plain: Record<string, string> } {
    if (roleIds.length === 0) throw new Error("join codes need at least one player role");
    const salt = randomBytes(16);
    const hashes = new Map<string, Buffer>();
    const plain: Record<string, string> = {};
    for (const roleId of roleIds) {
      if (RESERVED.has(roleId)) throw new Error("a reserved id cannot be a player role");
      let code = newJoinCode(pick);
      for (let i = 0; Object.values(plain).includes(code) && i < 10; i++) code = newJoinCode(pick); // distinct codes (a clash is ~2^-60)
      plain[roleId] = code;
      hashes.set(roleId, digest(salt, roleId, normalizeJoinCode(code)));
    }
    return { codes: new JoinCodes(bind.sessionId, bind.scenarioSha256, salt, hashes), plain };
  }

  /** Rebuilds the verifier from a codes file. Throws JoinCodeRecordError (never quoting the record) when it is not a valid record. */
  static fromRecord(raw: unknown): JoinCodes {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new JoinCodeRecordError("the join codes file is not a JSON object");
    const r = raw as Record<string, unknown>;
    const keys = Object.keys(r).sort().join(",");
    if (keys !== "roles,salt,scenarioSha256,sessionId,v") throw new JoinCodeRecordError("the join codes file has missing or unexpected fields");
    if (r.v !== JOIN_CODE_RECORD_VERSION) throw new JoinCodeRecordError("the join codes file has an unknown format version");
    if (typeof r.sessionId !== "string" || r.sessionId.length === 0 || r.sessionId.length > 64) throw new JoinCodeRecordError("the join codes file has an invalid session id");
    if (typeof r.scenarioSha256 !== "string" || !HEX64.test(r.scenarioSha256)) throw new JoinCodeRecordError("the join codes file has an invalid scenario hash");
    if (typeof r.salt !== "string" || !HEX32.test(r.salt)) throw new JoinCodeRecordError("the join codes file has an invalid salt");
    const roles = r.roles;
    if (typeof roles !== "object" || roles === null || Array.isArray(roles)) throw new JoinCodeRecordError("the join codes file has no role table");
    const hashes = new Map<string, Buffer>();
    for (const [roleId, h] of Object.entries(roles as Record<string, unknown>)) {
      if (RESERVED.has(roleId) || roleId.length === 0 || roleId.length > 128) throw new JoinCodeRecordError("the join codes file names an invalid role");
      if (typeof h !== "string" || !HEX64.test(h)) throw new JoinCodeRecordError("the join codes file holds an invalid hash");
      hashes.set(roleId, Buffer.from(h, "hex"));
    }
    if (hashes.size === 0) throw new JoinCodeRecordError("the join codes file holds no roles");
    return new JoinCodes(r.sessionId, r.scenarioSha256, Buffer.from(r.salt, "hex"), hashes);
  }

  /** The record to persist: hashes and salt only. */
  toRecord(): JoinCodeRecord {
    return { v: 1, sessionId: this.sessionId, scenarioSha256: this.scenarioSha256, salt: this.salt.toString("hex"), roles: Object.fromEntries([...this.hashes].map(([k, v]) => [k, v.toString("hex")])) };
  }

  /** Were these codes issued for this session, this scenario and exactly these player roles? */
  matches(o: { sessionId: string; scenarioSha256: string; roleIds: readonly string[] }): boolean {
    return o.sessionId === this.sessionId && o.scenarioSha256 === this.scenarioSha256 && o.roleIds.length === this.hashes.size && o.roleIds.every((id) => this.hashes.has(id));
  }

  /**
   * Does `code` open `roleId`? Constant time in the code: both sides are 32-byte digests compared with timingSafeEqual, and a role
   * without a code (unknown, an AI character, reserved, a prototype key) is compared against a dummy digest and refused, so the answer
   * and its cost do not tell whether the role exists. A missing or over-long code is refused unread.
   */
  verify(roleId: string, code: string | undefined): boolean {
    const expected = this.hashes.get(roleId); // a Map: "__proto__" or "toString" is never a key
    const usable = typeof code === "string" && code.length > 0 && code.length <= MAX_JOIN_CODE_INPUT_CHARS;
    const given = digest(this.salt, roleId, usable ? normalizeJoinCode(code) : "");
    const same = timingSafeEqual(given, expected ?? this.dummy);
    return same && expected !== undefined && usable && normalizeJoinCode(code).length === JOIN_CODE_SYMBOLS;
  }
}
