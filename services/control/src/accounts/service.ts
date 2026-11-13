import { randomBytes } from "node:crypto";
import { cleanConsoleName } from "@acr/events";
import { generateTemporaryPassword, hashPassword, verifyPassword } from "./passwords.js";
import type { AccountStore } from "./store.js";
import type { Account, AccountsFile, PasswordHash, PublicAccount, Role } from "./types.js";

const TEMP_TTL_MS = 72 * 3600 * 1000;
const MIN_PASSWORD_LENGTH = 10;
const DEFAULT_ADMIN_LOGIN = "admin";

export type Issued = { account: PublicAccount; temporaryPassword: string };
export type AccountErrorCode = "not_found" | "conflict" | "invalid" | "state";

export class AccountError extends Error {
  constructor(readonly code: AccountErrorCode, message: string) {
    super(message);
    this.name = "AccountError";
  }
}

export type AccountServiceOptions = {
  store: AccountStore;
  now: () => number;
  /** Password of the default admin on first start and on ADMIN_RESET. Never logged. */
  bootstrapPassword: string;
  reset: boolean;
  newTemporary?: () => string;
  newId?: () => string;
  log?: (line: string) => void;
};

const toPublic = (a: Account): PublicAccount => {
  const { password: _password, ...rest } = a;
  return rest;
};
const normLogin = (l: string): string => l.trim().toLowerCase();

/** Facilitator and admin accounts. Passwords exist only as salted hashes; plain text is returned once, as a temporary password. */
export class AccountService {
  private readonly o: AccountServiceOptions;
  private dummy: Promise<PasswordHash> | null = null;

  constructor(o: AccountServiceOptions) { this.o = o; }

  private temporary(): string { return (this.o.newTemporary ?? generateTemporaryPassword)(); }
  private id(): string { return (this.o.newId ?? (() => randomBytes(8).toString("hex")))(); }
  private log(line: string): void { this.o.log?.(line); }
  private dummyHash(): Promise<PasswordHash> {
    this.dummy ??= hashPassword(randomBytes(16).toString("hex"));
    return this.dummy;
  }

  /** The current file; a missing file reads as empty. An unusable file throws (the store refuses it). */
  private load(): AccountsFile { return this.o.store.read() ?? { legacyClosed: false, accounts: [] }; }
  private find(f: AccountsFile, id: string): Account {
    const a = f.accounts.find((x) => x.id === id);
    if (!a) throw new AccountError("not_found", "no such account");
    return a;
  }

  async ensureDefaultAdmin(): Promise<void> {
    const existing = this.o.store.read();
    if (existing && !this.o.reset) return;
    const password = await hashPassword(this.o.bootstrapPassword);
    const f = this.o.store.read() ?? { legacyClosed: false, accounts: [] };
    const found = f.accounts.find((a) => a.login === DEFAULT_ADMIN_LOGIN);
    if (found) {
      Object.assign(found, { role: "admin" as Role, status: "active" as const, password, mustChange: true, tempExpiresAt: null, epoch: found.epoch + 1 });
      this.log("accounts: the default admin was reset (ADMIN_RESET)");
    } else {
      f.accounts.push({
        id: this.id(), login: DEFAULT_ADMIN_LOGIN, name: "Administrator", role: "admin", status: "active", password,
        mustChange: true, tempExpiresAt: null, epoch: 0, createdAt: this.o.now(), createdBy: null,
      });
      this.log("accounts: the default admin was created");
    }
    this.o.store.write(f);
  }

  async login(login: string, password: string): Promise<{ ok: true; account: PublicAccount } | { ok: false; reason: "refused" | "expired" }> {
    const a = this.load().accounts.find((x) => x.login === normLogin(login));
    const usable = a !== undefined && a.status !== "revoked";
    // Exactly one hash verification on every path, so timing does not reveal which logins exist.
    const correct = await verifyPassword(password, usable ? a.password : await this.dummyHash());
    if (!usable || !correct) return { ok: false, reason: "refused" };
    if (a.tempExpiresAt !== null && this.o.now() > a.tempExpiresAt) return { ok: false, reason: "expired" };
    return { ok: true, account: toPublic(a) };
  }

  check(id: string, epoch: number): PublicAccount | null {
    const a = this.load().accounts.find((x) => x.id === id);
    return a && a.status !== "revoked" && a.epoch === epoch ? toPublic(a) : null;
  }

  async changePassword(id: string, epoch: number, current: string, next: string): Promise<{ ok: true; account: PublicAccount } | { ok: false; reason: "refused" | "weak" }> {
    const a0 = this.load().accounts.find((x) => x.id === id);
    if (!a0 || a0.status === "revoked" || a0.epoch !== epoch) return { ok: false, reason: "refused" };
    if (!(await verifyPassword(current, a0.password))) return { ok: false, reason: "refused" };
    if (next.length < MIN_PASSWORD_LENGTH || next === current) return { ok: false, reason: "weak" };
    const password = await hashPassword(next);
    const f = this.load();
    const a = f.accounts.find((x) => x.id === id);
    if (!a || a.status === "revoked" || a.epoch !== epoch) return { ok: false, reason: "refused" };
    Object.assign(a, { password, status: "active" as const, mustChange: false, tempExpiresAt: null, epoch: a.epoch + 1 });
    f.legacyClosed = true;
    this.o.store.write(f);
    return { ok: true, account: toPublic(a) };
  }

  list(): PublicAccount[] { return this.load().accounts.map(toPublic); }

  async create(i: { login: string; name: string; role: Role }, by: string | null): Promise<Issued> {
    const login = normLogin(i.login);
    const name = cleanConsoleName(i.name);
    if (login.length === 0) throw new AccountError("invalid", "login is required");
    if (name === null) throw new AccountError("invalid", "name is required");
    if (i.role !== "admin" && i.role !== "facilitator") throw new AccountError("invalid", "unknown role");
    if (this.load().accounts.some((a) => a.login === login)) throw new AccountError("conflict", "that login is taken");
    const temporaryPassword = this.temporary();
    const password = await hashPassword(temporaryPassword);
    const f = this.load();
    if (f.accounts.some((a) => a.login === login)) throw new AccountError("conflict", "that login is taken");
    const now = this.o.now();
    const account: Account = {
      id: this.id(), login, name, role: i.role, status: "invited", password, mustChange: true,
      tempExpiresAt: now + TEMP_TTL_MS, epoch: 0, createdAt: now, createdBy: by,
    };
    f.accounts.push(account);
    f.legacyClosed = true;
    this.o.store.write(f);
    return { account: toPublic(account), temporaryPassword };
  }

  /** Issue a fresh temporary password: epoch bump signs the account out, the old password stops working. */
  private async issue(id: string, allowed: Account["status"], status: Account["status"]): Promise<Issued> {
    this.expect(id, allowed);
    const temporaryPassword = this.temporary();
    const password = await hashPassword(temporaryPassword);
    const f = this.load();
    const a = this.find(f, id);
    if (a.status !== allowed) throw new AccountError("state", `the account is ${a.status}`);
    Object.assign(a, { password, status, mustChange: true, tempExpiresAt: this.o.now() + TEMP_TTL_MS, epoch: a.epoch + 1 });
    this.o.store.write(f);
    return { account: toPublic(a), temporaryPassword };
  }

  private expect(id: string, status: Account["status"]): void {
    const a = this.find(this.load(), id);
    if (a.status !== status) throw new AccountError("state", `the account is ${a.status}`);
  }

  resend(id: string): Promise<Issued> { return this.issue(id, "invited", "invited"); }
  resetPassword(id: string): Promise<Issued> { return this.issue(id, "active", "active"); }
  reinstate(id: string): Promise<Issued> { return this.issue(id, "revoked", "invited"); }

  revoke(id: string): void {
    const f = this.load();
    const a = this.find(f, id);
    if (a.status === "revoked") throw new AccountError("state", "the account is already revoked");
    if (a.role === "admin" && a.status === "active" && !f.accounts.some((x) => x !== a && x.role === "admin" && x.status === "active")) {
      throw new AccountError("conflict", "the last active admin cannot be revoked");
    }
    a.status = "revoked";
    a.epoch += 1;
    this.o.store.write(f);
  }

  /** False once any account password was changed or a non-default account was created: the shared FACILITATOR_SECRET stops working. */
  legacySecretAllowed(): boolean { return !this.load().legacyClosed; }
}
