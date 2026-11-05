import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { isValidSessionId } from "@acr/events";
import { RoleIdSchema } from "./protocol.js";
import { ControlError } from "./supervisor.js";

/** What callers see. Never carries the salt, the hash or the secret. */
export type ReportCredential = {
  id: string; sessionId: string; role: string; createdAt: number; expiresAt: number; revokedAt?: number; lastUsedAt?: number;
};
type Record_ = ReportCredential & { salt: string; hash: string };

/** Tests only: a hook run just before every file write (to make writes slow). */
export type ReportAccessHooks = { beforeWrite?: () => Promise<void>; maxBytes?: number; syncDir?: (dir: string) => void };

const ID_RE = /^[A-Za-z0-9_-]{11}$/;       // 8 random bytes, base64url
const SECRET_RE = /^[A-Za-z0-9_-]{22}$/;   // 16 random bytes, base64url
const TOUCH_MS = 10 * 60_000;
const DAY_MS = 86_400_000;
const MAX_BYTES = 8 * 1024 * 1024;
const PRUNE_MS = 30 * DAY_MS;
const UNAVAILABLE = "Report links are unavailable. Try again.";
const CONFLICT = "A link is already active for this role.";
const BAD = "Invalid session or role.";

class Corrupt extends Error {}

const b64 = (b: Buffer): string => b.toString("base64url");
const hashOf = (salt: string, secret: string): Buffer => createHash("sha256").update(Buffer.from(salt, "base64url")).update(secret, "utf8").digest();
const live = (r: ReportCredential, now: number): boolean => r.revokedAt === undefined && now < r.expiresAt;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const strip = (r: Record_): ReportCredential => {
  const c: ReportCredential = { id: r.id, sessionId: r.sessionId, role: r.role, createdAt: r.createdAt, expiresAt: r.expiresAt };
  if (r.revokedAt !== undefined) c.revokedAt = r.revokedAt;
  if (r.lastUsedAt !== undefined) c.lastUsedAt = r.lastUsedAt;
  return c;
};

function isRecord(v: unknown): v is Record_ {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  const allowed = ["id", "sessionId", "role", "salt", "hash", "createdAt", "expiresAt", "revokedAt", "lastUsedAt"];
  return Object.keys(o).every((k) => allowed.includes(k))
    && typeof o.id === "string" && ID_RE.test(o.id)
    && typeof o.sessionId === "string" && isValidSessionId(o.sessionId)
    && typeof o.role === "string" && RoleIdSchema.safeParse(o.role).success
    && typeof o.salt === "string" && o.salt.length > 0 && typeof o.hash === "string" && o.hash.length > 0
    && isNum(o.createdAt) && isNum(o.expiresAt)
    && (o.revokedAt === undefined || isNum(o.revokedAt)) && (o.lastUsedAt === undefined || isNum(o.lastUsedAt));
}

/**
 * Hashed report-access credentials in ONE global file (`report-access.json`, 0600, outside every review folder). The token is
 * `<id>.<secret>`; only the id and a salted SHA-256 of the secret are stored. EVERY file access runs inside one in-process promise
 * chain and every write is read-modify-write inside it, so a `lastUsedAt` touch can never undo a revoke. A file that cannot be read
 * or does not have the expected shape fails closed (verify/check answer null, the rest throw `unavailable`); it is never replaced.
 */
export class ReportAccessStore {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private readonly o: { file: string; days: number; now: () => number }, private readonly hooks: ReportAccessHooks = {}) {
    if (!Number.isInteger(o.days) || o.days < 1 || o.days > 365) throw new Error("days must be an integer from 1 to 365");
  }

  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private readAll(): Record_[] {
    let fd: number;
    try { fd = openSync(this.o.file, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Corrupt();
    }
    try {
      const st = fstatSync(fd);
      const uid = process.getuid?.();
      if (!st.isFile() || st.nlink !== 1 || st.size > MAX_BYTES || (uid !== undefined && st.uid !== uid)) throw new Corrupt();
      const buf = Buffer.alloc(st.size);
      let got = 0;
      while (got < buf.length) {
        const n = readSync(fd, buf, got, buf.length - got, got);
        if (n === 0) break;
        got += n;
      }
      let parsed: unknown;
      try { parsed = JSON.parse(buf.subarray(0, got).toString("utf8")); } catch { throw new Corrupt(); }
      if (!Array.isArray(parsed) || !parsed.every(isRecord)) throw new Corrupt();
      if (new Set(parsed.map((r) => r.id)).size !== parsed.length) throw new Corrupt();
      return parsed;
    } catch (err) {
      throw err instanceof Corrupt ? err : new Corrupt();
    } finally { closeSync(fd); }
  }

  private async writeAll(list: Record_[]): Promise<void> {
    await this.hooks.beforeWrite?.();
    // Never write what the reader would refuse: that would disable the store for good.
    if (!list.every(isRecord)) throw new Corrupt();
    const data = Buffer.from(`${JSON.stringify(list)}\n`, "utf8");
    if (data.length > (this.hooks.maxBytes ?? MAX_BYTES)) throw new Corrupt();
    const dir = path.dirname(this.o.file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(dir, `.${path.basename(this.o.file)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try {
        fchmodSync(fd, 0o600);
        let off = 0;
        while (off < data.length) off += writeSync(fd, data, off, data.length - off);
        fsyncSync(fd);
      } finally { closeSync(fd); }
      renameSync(tmp, this.o.file);
    } catch (err) {
      try { unlinkSync(tmp); } catch { /* already gone */ }
      throw err;
    }
    // The rename already persisted the data; a failed directory sync is best effort.
    try {
      if (this.hooks.syncDir) this.hooks.syncDir(dir);
      else { const dfd = openSync(dir, constants.O_RDONLY); try { fsyncSync(dfd); } finally { closeSync(dfd); } }
    } catch { /* best effort */ }
  }

  /** Drops records that died more than 30 days ago. Live records and recently dead ones stay. */
  private prune(list: Record_[], now: number): Record_[] {
    return list.filter((r) => now - Math.min(r.expiresAt, r.revokedAt ?? Infinity) <= PRUNE_MS);
  }

  /** Runs a mutating step in the queue; any storage failure becomes one fixed-message error. */
  private mutate<T>(fn: (list: Record_[]) => Promise<{ result: T; list?: Record_[] }>): Promise<T> {
    return this.queue(async () => {
      try {
        const { result, list } = await fn(this.readAll());
        if (list) await this.writeAll(list);
        return result;
      } catch (err) {
        if (err instanceof ControlError) throw err;
        throw new ControlError("unavailable", UNAVAILABLE);
      }
    });
  }

  private static subject(sessionId: string, role: string): void {
    if (typeof sessionId !== "string" || typeof role !== "string" || !isValidSessionId(sessionId) || !RoleIdSchema.safeParse(role).success) {
      throw new ControlError("bad_request", BAD);
    }
  }

  private mint(list: Record_[], sessionId: string, role: string): { rec: Record_; token: string } {
    const now = this.o.now();
    let id = b64(randomBytes(8));
    while (list.some((r) => r.id === id)) id = b64(randomBytes(8));
    const secret = b64(randomBytes(16));
    const salt = b64(randomBytes(16));
    const rec: Record_ = { id, sessionId, role, salt, hash: b64(hashOf(salt, secret)), createdAt: now, expiresAt: now + this.o.days * DAY_MS };
    return { rec, token: `${id}.${secret}` };
  }

  async issue(sessionId: string, role: string): Promise<{ credential: ReportCredential; token: string }> {
    ReportAccessStore.subject(sessionId, role);
    return this.mutate(async (list) => {
      const now = this.o.now();
      if (list.some((r) => r.sessionId === sessionId && r.role === role && live(r, now))) throw new ControlError("conflict", CONFLICT);
      const { rec, token } = this.mint(list, sessionId, role);
      return { result: { credential: strip(rec), token }, list: [...this.prune(list, now), rec] };
    });
  }

  async reissue(sessionId: string, role: string): Promise<{ credential: ReportCredential; token: string }> {
    ReportAccessStore.subject(sessionId, role);
    return this.mutate(async (list) => {
      const now = this.o.now();
      const next = list.map((r) => (r.sessionId === sessionId && r.role === role && live(r, now) ? { ...r, revokedAt: now } : r));
      const { rec, token } = this.mint(next, sessionId, role);
      return { result: { credential: strip(rec), token }, list: [...this.prune(next, now), rec] };
    });
  }

  /** Revokes every unrevoked credential for the pair (expired ones too). True when something changed. */
  async revoke(sessionId: string, role: string): Promise<boolean> {
    ReportAccessStore.subject(sessionId, role);
    return this.mutate(async (list) => {
      const now = this.o.now();
      let changed = false;
      const next = list.map((r) => {
        if (r.sessionId === sessionId && r.role === role && r.revokedAt === undefined) { changed = true; return { ...r, revokedAt: now }; }
        return r;
      });
      return changed ? { result: true, list: next } : { result: false };
    });
  }

  async list(sessionId: string): Promise<ReportCredential[]> {
    if (typeof sessionId !== "string" || !isValidSessionId(sessionId)) throw new ControlError("bad_request", BAD);
    return this.mutate(async (list) => ({ result: list.filter((r) => r.sessionId === sessionId).map(strip) }));
  }

  /** Parses `<id>.<secret>` and checks it. Anything malformed, unknown, wrong, expired or revoked (or an unreadable file) is null. */
  async verify(token: string): Promise<ReportCredential | null> {
    if (typeof token !== "string" || token.length !== 34 || token[11] !== ".") return null;
    const id = token.slice(0, 11);
    const secret = token.slice(12);
    if (!ID_RE.test(id) || !SECRET_RE.test(secret)) return null;
    return this.lookup(id, secret);
  }

  /** The per-read re-check: the credential by id if it is live, else null. */
  async check(credentialId: string): Promise<ReportCredential | null> {
    if (typeof credentialId !== "string" || !ID_RE.test(credentialId)) return null;
    return this.lookup(credentialId, undefined);
  }

  private async lookup(id: string, secret: string | undefined): Promise<ReportCredential | null> {
    try {
      return await this.mutate(async (list) => {
        const now = this.o.now();
        const rec = list.find((r) => r.id === id);
        if (secret !== undefined) {
          // Same work for an unknown id as for a wrong secret.
          const salt = rec?.salt ?? "AAAAAAAAAAAAAAAAAAAAAA";
          const want = rec ? Buffer.from(rec.hash, "base64url") : Buffer.alloc(32);
          const got = hashOf(salt, secret);
          if (!(want.length === got.length && timingSafeEqual(want, got)) || !rec) return { result: null };
        }
        if (!rec || !live(rec, now)) return { result: null };
        if (rec.lastUsedAt === undefined || now - rec.lastUsedAt >= TOUCH_MS) {
          const touched: Record_ = { ...rec, lastUsedAt: now };
          return { result: strip(touched), list: list.map((r) => (r.id === id ? touched : r)) };
        }
        return { result: strip(rec) };
      });
    } catch { return null; }
  }
}
