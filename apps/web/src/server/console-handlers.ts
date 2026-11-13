import { createHash, timingSafeEqual } from "node:crypto";
import { missingConsoleVars } from "./config";
import {
  CONSOLE_COOKIE,
  cleanConsoleName,
  isAccountCookieValue,
  openConsoleCookie,
  readConsoleCookie,
  secretEpoch,
  type AccountCookie,
  type ConsoleCookie,
  type LegacyCookie,
} from "./console-session";
import { fail, ok } from "./envelope";
import { checkFetchSite, checkOrigin, requestAddress } from "./guards";
import { readJson, type Deps } from "./handlers";
import { LauncherError, type AccountInfo } from "./launcher-client";
import { seal } from "./seal";

// The facilitator console's login and logout. Nothing here logs or echoes the secret, a cookie, a name or an address.

const HOUR_S = 3600;
/** The throttle role: one shared bucket per address (there is no role on a console login). */
const THROTTLE_ROLE = "console";
/** The address slot of the address-independent bucket: every login attempt shares it. */
const GLOBAL_KEY = "*";

const REFUSED = {
  status: 401,
  code: "login_refused",
  message: "That did not work. Check the secret and the name and try again.",
};
const refuse = (headers?: Record<string, string>) =>
  fail(
    REFUSED.status,
    REFUSED.code,
    REFUSED.message,
    headers ? { headers } : undefined,
  );
const forbidden = () => fail(403, "forbidden", "This request was refused.");
const badRequest = () =>
  fail(400, "bad_request", "The request could not be read.");
const throttled = (retryMs: number) =>
  fail(429, "rate_limited", "Too many attempts. Wait a minute and try again.", {
    headers: { "Retry-After": String(Math.max(1, Math.ceil(retryMs / 1000))) },
  });
/** Generic on purpose: which variables are unset is in the server log (createDeps), never in a browser. */
export const CONSOLE_DISABLED_MESSAGE =
  "The console is not set up on this server.";
const disabled = () => fail(503, "console_disabled", CONSOLE_DISABLED_MESSAGE);

const cookieHeader = (value: string, maxAgeSeconds: number) =>
  `${CONSOLE_COOKIE}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Strict`;
const CLEAR = cookieHeader("", 0);

/** Equal-length digests, so the comparison neither leaks the secret's length nor short-circuits. */
function secretsMatch(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

const MAX_CREDENTIAL_CHARS = 200;
/** The throttle role of the per-login (and per-account password change) bucket on `consoleLoginThrottle`. */
const LOGIN_ROLE = "login";
const PASSWORD_ROLE = "password";
const ACCOUNT_REFUSED_MESSAGE = "That did not work. Check the login and the password and try again.";
const unreachableAnswer = () => fail(502, "launcher_unavailable", "The session service is not reachable. Try again.");

const field = (v: unknown): v is string => typeof v === "string" && v.length >= 1 && v.length <= MAX_CREDENTIAL_CHARS;

function sessionCookie(deps: Deps, value: string): string {
  return cookieHeader(value, deps.config.cookieMaxAgeHours * HOUR_S);
}

function accountSession(deps: Deps, a: AccountInfo): { cookie: string; body: { name: string; role: AccountInfo["role"]; mustChange: boolean } } {
  const now = deps.now();
  const session: AccountCookie = { kind: "account", accountId: a.id, epoch: a.epoch, name: a.name, expiresAt: now + deps.config.cookieMaxAgeHours * HOUR_S * 1000 };
  return { cookie: sessionCookie(deps, seal(session, deps.config.cookieKeys, now, "fac")), body: { name: a.name, role: a.role, mustChange: a.mustChange } };
}

/** A wrong guess: charged to the address, to everyone (global) and, for an account sign-in, to the lower-cased login. */
function chargeAndRefuse(deps: Deps, address: string, loginKey: string | null, message?: string): Response {
  deps.consoleThrottle.fail(address, THROTTLE_ROLE);
  deps.consoleGlobalThrottle.fail(GLOBAL_KEY, THROTTLE_ROLE);
  if (loginKey !== null) deps.consoleLoginThrottle.fail(loginKey, LOGIN_ROLE);
  const after = Math.max(
    deps.consoleThrottle.blockedForMs(address, THROTTLE_ROLE),
    deps.consoleGlobalThrottle.blockedForMs(GLOBAL_KEY, THROTTLE_ROLE),
    loginKey === null ? 0 : deps.consoleLoginThrottle.blockedForMs(loginKey, LOGIN_ROLE),
  );
  if (after > 0) return throttled(after);
  return message === undefined ? refuse() : fail(REFUSED.status, REFUSED.code, message);
}

async function accountLogin(deps: Deps, address: string, loginName: string, pw: string): Promise<Response> {
  const key = loginName.trim().toLowerCase();
  const loginBlocked = deps.consoleLoginThrottle.blockedForMs(key, LOGIN_ROLE);
  if (loginBlocked > 0) return throttled(loginBlocked);
  if (!deps.launcher) return unreachableAnswer();
  let account: AccountInfo;
  try {
    account = await deps.launcher.accountLogin(loginName, pw);
  } catch (err) {
    if (err instanceof LauncherError && err.reason === "login_refused") return chargeAndRefuse(deps, address, key, ACCOUNT_REFUSED_MESSAGE);
    // Only after the right password: a temporary password past its expiry. Not a guess, so it is not charged.
    if (err instanceof LauncherError && err.reason === "login_expired")
      return fail(401, "login_expired", "This temporary password has expired. Ask an administrator for a new one.");
    return unreachableAnswer();
  }
  const { cookie, body } = accountSession(deps, account);
  return ok(body, { headers: { "Set-Cookie": cookie } });
}

async function legacyLogin(deps: Deps, address: string, secret: string, rawName: string): Promise<Response> {
  const { config } = deps;
  // Fail closed: a latch that cannot be read is a 502, a closed latch is the same neutral refusal as a wrong secret.
  let allowed: boolean;
  try {
    if (!deps.launcher) return unreachableAnswer();
    allowed = await deps.launcher.legacyAllowed();
  } catch {
    return unreachableAnswer();
  }
  if (!allowed || !config.facilitatorSecret || !secretsMatch(secret, config.facilitatorSecret)) return chargeAndRefuse(deps, address, null);
  const name = cleanConsoleName(rawName);
  if (name === null) return refuse();
  const now = deps.now();
  const session: LegacyCookie = { name, epoch: secretEpoch(config.facilitatorSecret), expiresAt: now + config.cookieMaxAgeHours * HOUR_S * 1000 };
  return ok({ name }, { headers: { "Set-Cookie": sessionCookie(deps, seal(session, config.cookieKeys, now, "fac")) } });
}

/**
 * POST /api/v1/console/login, either { login, password } (an account) or { secret, name } (the legacy shared secret, only while control's
 * latch is open). Origin first; throttled per address and globally before the credentials are looked at; only a wrong guess is charged
 * (an account's also per lower-cased login). The answer never says which of login and password was wrong.
 */
export async function handleConsoleLogin(
  req: Request,
  deps: Deps,
): Promise<Response> {
  const { config } = deps;
  if (missingConsoleVars(config).length > 0) return disabled();
  if (!checkOrigin(req, config.publicOrigin) || !checkFetchSite(req))
    return forbidden();
  const address = requestAddress(req);
  if (address === null) return badRequest();
  const blocked = Math.max(
    deps.consoleThrottle.blockedForMs(address, THROTTLE_ROLE),
    deps.consoleGlobalThrottle.blockedForMs(GLOBAL_KEY, THROTTLE_ROLE),
  );
  if (blocked > 0) return throttled(blocked);
  const body = await readJson(req);
  if (body === null) return badRequest();
  if (typeof body.login === "string" || typeof body.password === "string") {
    if (!field(body.login) || !field(body.password)) return badRequest();
    return accountLogin(deps, address, body.login, body.password);
  }
  if (typeof body.secret !== "string" || typeof body.name !== "string") return badRequest();
  return legacyLogin(deps, address, body.secret, body.name);
}

/**
 * POST /api/v1/console/password { current, next }: an account changes its own password. Control checks the current one and bumps the
 * epoch; this closes the account's other open streams and re-seals THIS cookie with the new epoch (every other cookie is now refused).
 * A valid cookie is never held up by the address throttle; a wrong `current` is charged to the account instead.
 */
export async function handleConsolePassword(
  req: Request,
  deps: Deps,
): Promise<Response> {
  if (missingConsoleVars(deps.config).length > 0) return disabled();
  if (!checkOrigin(req, deps.config.publicOrigin) || !checkFetchSite(req)) return forbidden();
  const who = await requireConsole(req, deps);
  if (who instanceof Response) return who;
  if (who.legacy || who.accountId === null || who.epoch === null) return forbidden();
  const body = await readJson(req);
  if (body === null || !field(body.current) || !field(body.next)) return badRequest();
  const accountId = who.accountId;
  const lock = deps.consoleLoginThrottle.blockedForMs(accountId, PASSWORD_ROLE);
  if (lock > 0) return throttled(lock);
  let changed: AccountInfo;
  try {
    changed = await deps.launcher!.accountChangePassword(accountId, who.epoch, body.current, body.next);
  } catch (err) {
    if (err instanceof LauncherError) {
      if (err.reason === "weak_password") return fail(400, "weak_password", "Choose a longer password that is not easy to guess.");
      if (err.reason === "account_refused") return unauthorized({ "Set-Cookie": CLEAR });
      if (err.reason === "login_refused") {
        deps.consoleLoginThrottle.fail(accountId, PASSWORD_ROLE);
        return fail(403, "wrong_password", "The current password is not right.");
      }
    }
    return unreachableAnswer();
  }
  deps.facilitatorHub.closeAccount(accountId);
  const { cookie, body: out } = accountSession(deps, changed);
  return ok(out, { headers: { "Set-Cookie": cookie } });
}

/** POST /api/v1/console/logout: clears the cookie. Origin-checked like every state change. */
export async function handleConsoleLogout(
  req: Request,
  deps: Deps,
): Promise<Response> {
  if (!checkOrigin(req, deps.config.publicOrigin) || !checkFetchSite(req))
    return forbidden();
  return ok({}, { headers: { "Set-Cookie": CLEAR } });
}

/** US-0083: who is calling the console, re-checked against the control service on this request. */
export type ConsoleCaller = {
  name: string;
  role: "admin" | "facilitator";
  /** Null for a legacy (shared secret) sign-in, which acts as admin for sessions. */
  accountId: string | null;
  legacy: boolean;
  mustChange: boolean;
  /** The account's epoch the cookie was sealed with (null for legacy): the stream's heartbeat re-checks the same pair. */
  epoch: number | null;
  /** The cookie's own expiry. */
  expiresAt: number;
};

/** The pages a signed-in account that must change its password may still reach. */
export const MUST_CHANGE_EXEMPT_PATHS: ReadonlySet<string> = new Set(["/api/v1/console/password", "/api/v1/console/logout"]);

/**
 * The caller behind an opened cookie: "refused" when control refuses the account (or the legacy latch is closed), "unavailable" when
 * control cannot answer (unreachable, timed out, a malformed answer). Never cached: every request, page and heartbeat asks again.
 */
export async function resolveConsoleCaller(
  cookie: ConsoleCookie,
  deps: Pick<Deps, "launcher">,
): Promise<ConsoleCaller | "refused" | "unavailable"> {
  const launcher = deps.launcher;
  if (!launcher) return "unavailable";
  try {
    if (isAccountCookieValue(cookie)) {
      const a = await launcher.accountCheck(cookie.accountId, cookie.epoch);
      if (a === null || a.status === "revoked") return "refused";
      return { name: a.name, role: a.role, accountId: a.id, legacy: false, mustChange: a.mustChange, epoch: a.epoch, expiresAt: cookie.expiresAt };
    }
    if (!(await launcher.legacyAllowed())) return "refused";
    return { name: cookie.name, role: "admin", accountId: null, legacy: true, mustChange: false, epoch: null, expiresAt: cookie.expiresAt };
  } catch {
    return "unavailable";
  }
}

const unauthorized = (headers?: Record<string, string>) =>
  fail(401, "unauthorized", "Sign in to the facilitator console.", headers ? { headers } : undefined);
const unreachable = () => fail(502, "launcher_unavailable", "The session service is not reachable. Try again.");
const mustChangePassword = () => fail(403, "must_change_password", "Change your password to continue.");

/**
 * The facilitator, or the response to send: 503 when the console is disabled; 401 without a cookie, and 401 that CLEARS the cookie when
 * it cannot be opened or control refuses it; 502 (the cookie KEPT) when control cannot answer; 403 `must_change_password` for an account
 * that must change its password, except on the password-change and logout routes. Every console route, the stream and every `guard`
 * user go through here, so they all inherit each rule.
 */
export async function requireConsole(
  req: Request,
  deps: Deps,
): Promise<ConsoleCaller | Response> {
  if (missingConsoleVars(deps.config).length > 0) return disabled();
  const token = readConsoleCookie(req);
  if (token === undefined) return unauthorized();
  const cookie = openConsoleCookie(token, deps.config, deps.now());
  if (cookie === null) return unauthorized({ "Set-Cookie": CLEAR });
  const who = await resolveConsoleCaller(cookie, deps);
  if (who === "unavailable") return unreachable();
  if (who === "refused") return unauthorized({ "Set-Cookie": CLEAR });
  if (who.mustChange && !MUST_CHANGE_EXEMPT_PATHS.has(new URL(req.url).pathname)) return mustChangePassword();
  return who;
}
