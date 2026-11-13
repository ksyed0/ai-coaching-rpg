import { SafeJsonFile, type SafeJsonFileHooks } from "./safe-json-file.js";
import type { Account, AccountsFile, PasswordHash, Role, Status } from "./types.js";

const REFUSED = "the accounts file is not usable";
const ROLES: readonly string[] = ["admin", "facilitator"];
const STATUSES: readonly string[] = ["invited", "active", "revoked"];
const ACCOUNT_KEYS = ["id", "login", "name", "role", "status", "password", "mustChange", "tempExpiresAt", "epoch", "createdAt", "createdBy"];

export interface AccountStore {
  /** null = no file yet. An unusable file throws. */
  read(): AccountsFile | null;
  write(f: AccountsFile): void;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const sameKeys = (o: Record<string, unknown>, keys: string[]): boolean => {
  const k = Object.keys(o);
  return k.length === keys.length && keys.every((x) => k.includes(x));
};
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function isPassword(v: unknown): v is PasswordHash {
  return isObj(v) && sameKeys(v, ["salt", "hash"]) && typeof v.salt === "string" && typeof v.hash === "string";
}

function isAccount(v: unknown): v is Account {
  if (!isObj(v) || !sameKeys(v, ACCOUNT_KEYS)) return false;
  return typeof v.id === "string" && v.id.length > 0
    && typeof v.login === "string" && v.login.length > 0
    && typeof v.name === "string"
    && typeof v.role === "string" && ROLES.includes(v.role)
    && typeof v.status === "string" && STATUSES.includes(v.status)
    && isPassword(v.password)
    && typeof v.mustChange === "boolean"
    && (v.tempExpiresAt === null || isNum(v.tempExpiresAt))
    && isNum(v.epoch) && isNum(v.createdAt)
    && (v.createdBy === null || typeof v.createdBy === "string");
}

/** Strict validation; returns a fresh copy holding only the known fields. Throws a plain error on any violation. */
function validate(v: unknown): AccountsFile {
  if (!isObj(v) || !sameKeys(v, ["legacyClosed", "accounts"]) || typeof v.legacyClosed !== "boolean"
    || !Array.isArray(v.accounts) || !v.accounts.every(isAccount)) throw new Error(REFUSED);
  const accounts = (v.accounts as Account[]).map((a): Account => ({
    id: a.id, login: a.login, name: a.name, role: a.role as Role, status: a.status as Status,
    password: { salt: a.password.salt, hash: a.password.hash }, mustChange: a.mustChange,
    tempExpiresAt: a.tempExpiresAt, epoch: a.epoch, createdAt: a.createdAt, createdBy: a.createdBy,
  }));
  if (new Set(accounts.map((a) => a.id)).size !== accounts.length) throw new Error(REFUSED);
  if (new Set(accounts.map((a) => a.login)).size !== accounts.length) throw new Error(REFUSED);
  return { legacyClosed: v.legacyClosed, accounts };
}

/** `accounts.json` over SafeJsonFile. Reads and writes both validate; an invalid file is refused, never replaced. */
export class FileAccountStore implements AccountStore {
  private readonly file: SafeJsonFile;
  constructor(file: string, hooks: SafeJsonFileHooks = {}) { this.file = new SafeJsonFile(file, hooks); }

  read(): AccountsFile | null {
    const raw = this.file.read();
    return raw === null ? null : validate(raw);
  }

  write(f: AccountsFile): void { this.file.write(validate(f)); }
}
