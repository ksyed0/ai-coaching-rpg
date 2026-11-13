import { vi } from "vitest";
import type { Config } from "../config";
import { CONSOLE_COOKIE, secretEpoch, type AccountCookie, type LegacyCookie } from "../console-session";
import { FacilitatorBudget } from "../facilitator-budget";
import { FacilitatorHub } from "../facilitator-hub";
import type { Deps } from "../handlers";
import { LauncherError, type AccountInfo } from "../launcher-client";
import { RuntimeConnection, realTimer } from "../runtime-connection";
import { seal } from "../seal";
import { StreamHub } from "../stream-hub";
import { JoinThrottle } from "../throttle";

// US-0083: shared fixtures for every console test. A console cookie is either an ACCOUNT cookie ({kind: "account", accountId, epoch})
// re-checked by `launcher.accountCheck` on every request, or a LEGACY cookie ({name, epoch: secretEpoch(secret)}) accepted only while
// `launcher.legacyAllowed()` says so. `consoleAuth` is the fake control side of both: a mutable account table the test can revoke from.
// Test code only (vitest): never imported by the app.

export const FIXTURE_ORIGIN = "https://play.example.org";
export const FIXTURE_KEYS: Config["cookieKeys"] = [{ id: "k1", key: Buffer.alloc(32, 7) }];
export const FIXTURE_SECRET = "correct horse battery staple";
export const FIXTURE_T0 = 1_900_000_000_000;
const HOUR_MS = 3_600_000;

export const ADMIN: AccountInfo = { id: "acc-admin-0001", login: "admin", name: "Ann Lee", role: "admin", status: "active", mustChange: false, epoch: 1 };
export const FACILITATOR: AccountInfo = { id: "acc-fac-0002", login: "dana@client.example", name: "Dana Cook", role: "facilitator", status: "active", mustChange: false, epoch: 3 };

const NAMED = "acc-named-";
/**
 * An active admin account for `name` that every `consoleAuth` table knows without being told (its id encodes the name). For tests that
 * only care which display name reaches control (`by`), not which account.
 */
export function adminNamed(name: string): AccountInfo {
  return { ...ADMIN, id: `${NAMED}${Buffer.from(name, "utf8").toString("hex")}`.slice(0, 64), name, login: `${name.toLowerCase().replace(/[^a-z0-9]+/g, ".")}@example.org` };
}
function implicitNamed(id: string): AccountInfo | undefined {
  if (!id.startsWith(NAMED)) return undefined;
  const a = adminNamed(Buffer.from(id.slice(NAMED.length), "hex").toString("utf8"));
  return a.id === id ? a : undefined;
}

/** A console configuration with the console enabled (launcher URL and token) and, by default, the legacy secret. */
export function consoleConfig(over: Partial<Config> = {}): Config {
  return {
    runtimeUrl: "ws://127.0.0.1:1", publicOrigin: FIXTURE_ORIGIN, cookieKeys: FIXTURE_KEYS, cookieMaxAgeHours: 12,
    maxStreams: 10, maxStreamsPerSession: 10, maxStreamsPerAddress: 10,
    facilitatorSecret: FIXTURE_SECRET, launcherUrl: "http://127.0.0.1:47123", launcherToken: "launcher-token-" + "t".repeat(20),
    ...over,
  };
}

type SealOpts = { keys?: Config["cookieKeys"]; now?: number; expiresAt?: number };

/** The sealed VALUE of an account cookie for `info` (its id and current epoch). */
export function accountCookieValue(info: Pick<AccountInfo, "id" | "epoch" | "name">, o: SealOpts = {}): string {
  const now = o.now ?? FIXTURE_T0;
  const c: AccountCookie = { kind: "account", accountId: info.id, epoch: info.epoch, name: info.name, expiresAt: o.expiresAt ?? now + HOUR_MS };
  return seal(c, o.keys ?? FIXTURE_KEYS, now, "fac");
}
/** `Cookie` header text (`name=value`) of an account cookie for `info`. */
export function accountCookie(info: Pick<AccountInfo, "id" | "epoch" | "name">, o: SealOpts = {}): string {
  return `${CONSOLE_COOKIE}=${accountCookieValue(info, o)}`;
}

/** The sealed VALUE of a legacy (shared secret) cookie: no `kind`, the secret's epoch. */
export function legacyCookieValue(name: string, o: SealOpts & { secret?: string } = {}): string {
  const now = o.now ?? FIXTURE_T0;
  const c: LegacyCookie = { name, epoch: secretEpoch(o.secret ?? FIXTURE_SECRET), expiresAt: o.expiresAt ?? now + HOUR_MS };
  return seal(c, o.keys ?? FIXTURE_KEYS, now, "fac");
}
/** `Cookie` header text (`name=value`) of a legacy cookie. */
export function legacyCookie(name: string, o: SealOpts & { secret?: string } = {}): string {
  return `${CONSOLE_COOKIE}=${legacyCookieValue(name, o)}`;
}

/**
 * The control side of console sign-in, as launcher methods to spread into a test's fake launcher. `accounts` is live: `revoke`, `bump`
 * (a reset or password change) and `set` change what the next check answers; `down` makes every call throw `unavailable`.
 */
export function consoleAuth(accounts: AccountInfo[] = [ADMIN, FACILITATOR], o: { legacy?: boolean } = {}) {
  const table = new Map(accounts.map((a) => [a.id, { ...a }]));
  const state = { legacy: o.legacy ?? true, down: false };
  const unavailable = (): never => { throw new LauncherError("unavailable"); };
  const accountCheck = vi.fn(async (accountId: string, epoch: number): Promise<AccountInfo | null> => {
    if (state.down) return unavailable();
    const a = table.get(accountId) ?? implicitNamed(accountId);
    return a && a.status !== "revoked" && a.epoch === epoch ? { ...a } : null;
  });
  const legacyAllowed = vi.fn(async (): Promise<boolean> => {
    if (state.down) return unavailable();
    return state.legacy;
  });
  return {
    launcher: { accountCheck, legacyAllowed },
    accountCheck, legacyAllowed,
    set: (a: AccountInfo) => { table.set(a.id, { ...a }); },
    revoke: (id: string) => { const a = table.get(id) ?? implicitNamed(id); if (a) table.set(id, { ...a, status: "revoked", epoch: a.epoch + 1 }); },
    bump: (id: string, patch: Partial<AccountInfo> = {}) => { const a = table.get(id) ?? implicitNamed(id); if (a) table.set(id, { ...a, epoch: a.epoch + 1, ...patch }); },
    closeLatch: () => { state.legacy = false; },
    down: (v = true) => { state.down = v; },
  };
}
export type ConsoleAuth = ReturnType<typeof consoleAuth>;

/**
 * A test's own fake launcher with `auth`'s account methods in front (a view, so later changes to `launcher` show through, and the
 * account calls never count as calls on the test's own launcher object).
 */
export function withConsoleAuth<T extends object>(launcher: T, auth: ConsoleAuth = consoleAuth()): T {
  const front = auth.launcher as Record<PropertyKey, unknown>;
  return new Proxy(launcher, {
    get: (t, k, r) => (Object.hasOwn(front, k) ? front[k] : Reflect.get(t, k, r)),
    has: (t, k) => Object.hasOwn(front, k) || Reflect.has(t, k),
  });
}

const throttle = (now: () => number, max: number, windowMs: number, blockMs: number) => new JoinThrottle({ max, windowMs, blockMs, now });

/**
 * A complete Deps for console tests: console enabled, a fake launcher with `consoleAuth()` (ADMIN and FACILITATOR, the legacy latch
 * open) plus any `launcher` methods given, and the real throttles and hubs on an injected clock. `over` replaces anything else.
 */
export function fakeDeps(
  over: Omit<Partial<Deps>, "launcher"> & { launcher?: Record<string, unknown>; auth?: ConsoleAuth } = {},
): Deps & { auth: ConsoleAuth } {
  const now = over.now ?? (() => FIXTURE_T0);
  const auth = over.auth ?? consoleAuth();
  const { launcher: extra, auth: _auth, ...rest } = over;
  const deps = {
    config: consoleConfig(), now, connect: RuntimeConnection.connect,
    joinThrottle: throttle(now, 5, 60_000, 60_000), consoleThrottle: throttle(now, 5, 60_000, 60_000), consoleGlobalThrottle: throttle(now, 20, 600_000, 300_000),
    reportThrottle: throttle(now, 60, 60_000, 60_000), reportWriteThrottle: throttle(now, 30, 60_000, 60_000), consoleReportThrottle: throttle(now, 60, 60_000, 60_000),
    reportEnterThrottle: throttle(now, 5, 60_000, 60_000), reportReadFailThrottle: throttle(now, 5, 60_000, 60_000), voiceTokenThrottle: throttle(now, 20, 60_000, 60_000),
    hub: new StreamHub({ maxStreams: 10, maxStreamsPerSession: 10, maxStreamsPerAddress: 10, setTimer: realTimer, now }),
    facilitatorBudget: new FacilitatorBudget(),
    facilitatorHub: new FacilitatorHub({ setTimer: realTimer, now }),
    ...rest,
    launcher: { ...auth.launcher, ...extra } as unknown as Deps["launcher"],
    auth,
  };
  return deps as Deps & { auth: ConsoleAuth };
}
