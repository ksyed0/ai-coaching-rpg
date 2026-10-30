import { createHash, timingSafeEqual } from "node:crypto";
import { missingConsoleVars } from "./config";
import {
  CONSOLE_COOKIE,
  cleanConsoleName,
  readConsoleCookie,
  readConsoleSession,
  secretEpoch,
  type ConsoleSession,
} from "./console-session";
import { fail, ok } from "./envelope";
import { checkFetchSite, checkOrigin, requestAddress } from "./guards";
import { readJson, type Deps } from "./handlers";
import { seal } from "./seal";

// The facilitator console's login and logout. Nothing here logs or echoes the secret, a cookie, a name or an address.

const HOUR_S = 3600;
/** The throttle role: one shared bucket per address (there is no role on a console login). */
const THROTTLE_ROLE = "console";

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

/** POST /api/v1/console/login { secret, name }. Origin first; throttled per address before the secret is looked at; only a wrong secret is charged. */
export async function handleConsoleLogin(
  req: Request,
  deps: Deps,
): Promise<Response> {
  const { config } = deps;
  if (missingConsoleVars(config).length > 0 || !config.facilitatorSecret)
    return disabled();
  if (!checkOrigin(req, config.publicOrigin) || !checkFetchSite(req))
    return forbidden();
  const address = requestAddress(req);
  if (address === null) return badRequest();
  const blocked = deps.consoleThrottle.blockedForMs(address, THROTTLE_ROLE);
  if (blocked > 0) return throttled(blocked);
  const body = await readJson(req);
  if (
    body === null ||
    typeof body.secret !== "string" ||
    typeof body.name !== "string"
  )
    return badRequest();
  if (!secretsMatch(body.secret, config.facilitatorSecret)) {
    deps.consoleThrottle.fail(address, THROTTLE_ROLE);
    const after = deps.consoleThrottle.blockedForMs(address, THROTTLE_ROLE);
    return after > 0 ? throttled(after) : refuse();
  }
  const name = cleanConsoleName(body.name);
  if (name === null) return refuse();
  const now = deps.now();
  const expiresAt = now + config.cookieMaxAgeHours * HOUR_S * 1000;
  const session: ConsoleSession = {
    name,
    epoch: secretEpoch(config.facilitatorSecret),
    expiresAt,
  };
  return ok(
    { name },
    {
      headers: {
        "Set-Cookie": cookieHeader(
          seal(session, config.cookieKeys, now, "fac"),
          config.cookieMaxAgeHours * HOUR_S,
        ),
      },
    },
  );
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

/** The facilitator session, or the response to send (503 when the console is disabled, 401 otherwise; a cookie that cannot be opened is cleared). */
export function requireConsole(
  req: Request,
  deps: Deps,
): ConsoleSession | Response {
  if (missingConsoleVars(deps.config).length > 0) return disabled();
  const session = readConsoleSession(req, deps.config, deps.now());
  if (session) return session;
  const unauthorized = (headers?: Record<string, string>) =>
    fail(
      401,
      "unauthorized",
      "Sign in to the facilitator console.",
      headers ? { headers } : undefined,
    );
  return unauthorized(
    readConsoleCookie(req) !== undefined ? { "Set-Cookie": CLEAR } : undefined,
  );
}
