import { describe, expect, it, vi } from "vitest";
import type { Config } from "../config";
import { loadConfig } from "../config";
import {
  handleConsoleLogin,
  handleConsoleLogout,
  requireConsole,
} from "../console-handlers";
import {
  CONSOLE_COOKIE,
  consoleSessionFromToken,
  readConsoleSession,
  secretEpoch,
} from "../console-session";
import { COOKIE_NAME, type Deps } from "../handlers";
import { seal } from "../seal";
import { JoinThrottle } from "../throttle";

const ORIGIN = "https://play.example.org";
const KEYS: Config["cookieKeys"] = [{ id: "k1", key: Buffer.alloc(32, 7) }];
const SECRET = "correct horse battery staple";
const T0 = 1_900_000_000_000;
let clock = T0;

const baseConfig = (o: Partial<Config> = {}): Config => ({
  runtimeUrl: "ws://127.0.0.1:1",
  publicOrigin: ORIGIN,
  cookieKeys: KEYS,
  cookieMaxAgeHours: 12,
  maxStreams: 10,
  maxStreamsPerSession: 10,
  maxStreamsPerAddress: 10,
  facilitatorSecret: SECRET,
  launcherUrl: "http://127.0.0.1:4000",
  launcherToken: "t".repeat(32),
  ...o,
});
function makeDeps(
  o: Partial<Config> = {},
  throttle: Partial<ConstructorParameters<typeof JoinThrottle>[0]> = {},
) {
  clock = T0;
  const consoleThrottle = new JoinThrottle({
    max: 5,
    windowMs: 60_000,
    blockMs: 60_000,
    now: () => clock,
    ...throttle,
  });
  const consoleGlobalThrottle = new JoinThrottle({ max: 20, windowMs: 600_000, blockMs: 300_000, now: () => clock });
  return {
    consoleThrottle,
    consoleGlobalThrottle,
    deps: {
      config: baseConfig(o),
      now: () => clock,
      consoleThrottle,
      consoleGlobalThrottle,
    } as unknown as Deps,
  };
}
const guarded = {
  Origin: ORIGIN,
  "X-Requested-With": "scenecoach",
  "Content-Type": "application/json",
  "X-Forwarded-For": "198.51.100.7",
};
const login = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/api/v1/console/login`, {
    method: "POST",
    headers: { ...guarded, ...headers },
    body: JSON.stringify(body),
  });
const cookieValue = (res: Response) =>
  /^[^=]+=([^;]*)/.exec(res.headers.get("Set-Cookie") ?? "")?.[1] ?? "";
const withCookie = (value: string, name = CONSOLE_COOKIE) =>
  new Request(`${ORIGIN}/api/v1/console/x`, {
    headers: { Cookie: `${name}=${value}` },
  });
const NEUTRAL =
  "That did not work. Check the secret and the name and try again.";

describe("console login", () => {
  it("login with the right secret sets __Host-scenecoach-fac (HttpOnly, Secure, SameSite=Strict, Path=/) and returns the cleaned name", async () => {
    const { deps } = makeDeps();
    const res = await handleConsoleLogin(
      login({ secret: SECRET, name: "  Ann\u0007 Lee  " }),
      deps,
    );
    expect(res.status).toBe(200);
    const sc = res.headers.get("Set-Cookie")!;
    expect(sc.startsWith("__Host-scenecoach-fac=")).toBe(true);
    for (const a of [
      "HttpOnly",
      "Secure",
      "SameSite=Strict",
      "Path=/",
      `Max-Age=${12 * 3600}`,
    ])
      expect(sc).toContain(a);
    expect(sc).not.toContain("Domain");
    expect((await res.json()).data).toEqual({ name: "Ann Lee" });
    const session = readConsoleSession(
      withCookie(cookieValue(res)),
      deps.config,
      clock,
    );
    expect(session).toMatchObject({
      name: "Ann Lee",
      epoch: secretEpoch(SECRET),
    });
  });

  it("login with a wrong secret returns the neutral refusal and no cookie", async () => {
    const { deps } = makeDeps();
    const res = await handleConsoleLogin(
      login({ secret: "nope nope nope nope", name: "Ann" }),
      deps,
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    const text = await res.text();
    expect(JSON.parse(text).error.message).toBe(NEUTRAL);
    expect(text).not.toContain("nope");
    // a name problem is the very same answer, so it never says which field was wrong
    const bad = await handleConsoleLogin(
      login({ secret: SECRET, name: "​ \n" }),
      deps,
    );
    expect(bad.status).toBe(401);
    expect((await bad.json()).error.message).toBe(NEUTRAL);
    expect(bad.headers.get("Set-Cookie")).toBeNull();
  });

  it("login with a foreign Origin is refused before the secret is compared", async () => {
    const { deps, consoleThrottle } = makeDeps();
    const fail = vi.spyOn(consoleThrottle, "fail");
    const res = await handleConsoleLogin(
      login(
        { secret: SECRET, name: "Ann" },
        { Origin: "https://evil.example" },
      ),
      deps,
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    const wrong = await handleConsoleLogin(
      login(
        { secret: "wrong wrong wrong!!", name: "Ann" },
        { Origin: "https://evil.example" },
      ),
      deps,
    );
    expect(wrong.status).toBe(403);
    expect(fail).not.toHaveBeenCalled();
  });

  it("rotating X-Forwarded-For does not dodge the login throttle: the 21st wrong secret from any addresses blocks every login", async () => {
    const { deps } = makeDeps();
    const from = (i: number, secret: string) =>
      handleConsoleLogin(login({ secret, name: "Ann" }, { "X-Forwarded-For": `203.0.113.${i + 1}` }), deps);
    for (let i = 0; i < 20; i++) expect((await from(i, `wrong secret ${i}!!!`)).status).toBe(401);
    expect((await from(20, "wrong secret 20!!!")).status).toBe(429);
    // a fresh address with the RIGHT secret is refused while the global block lasts, and works once it has passed
    expect((await from(21, SECRET)).status).toBe(429);
    clock += 300_001;
    expect((await from(21, SECRET)).status).toBe(200);
  });

  it("the sixth wrong secret from one address is throttled and a saturated throttle fails closed", async () => {
    const { deps } = makeDeps();
    for (let i = 0; i < 5; i++)
      expect(
        (
          await handleConsoleLogin(
            login({ secret: `wrong secret ${i}!!!`, name: "Ann" }),
            deps,
          )
        ).status,
      ).toBe(401);
    const sixth = await handleConsoleLogin(
      login({ secret: "wrong secret six!!", name: "Ann" }),
      deps,
    );
    expect(sixth.status).toBe(429);
    // blocked even with the right secret, and another address is unaffected
    expect(
      (await handleConsoleLogin(login({ secret: SECRET, name: "Ann" }), deps))
        .status,
    ).toBe(429);
    expect(
      (
        await handleConsoleLogin(
          login(
            { secret: SECRET, name: "Ann" },
            { "X-Forwarded-For": "198.51.100.8" },
          ),
          deps,
        )
      ).status,
    ).toBe(200);

    const sat = makeDeps({}, { maxKeys: 1 });
    await handleConsoleLogin(
      login(
        { secret: "wrong secret 0!!!!", name: "A" },
        { "X-Forwarded-For": "198.51.100.1" },
      ),
      sat.deps,
    );
    for (let i = 0; i < 5; i++)
      await handleConsoleLogin(
        login(
          { secret: "wrong secret x!!!!", name: "A" },
          { "X-Forwarded-For": "198.51.100.1" },
        ),
        sat.deps,
      );
    // every slot now holds a block: a new address's wrong guess cannot be tracked, so the table fails closed for new addresses
    expect(
      (
        await handleConsoleLogin(
          login(
            { secret: "wrong secret y!!!!", name: "A" },
            { "X-Forwarded-For": "198.51.100.50" },
          ),
          sat.deps,
        )
      ).status,
    ).toBe(429);
    const other = await handleConsoleLogin(
      login(
        { secret: SECRET, name: "Ann" },
        { "X-Forwarded-For": "198.51.100.99" },
      ),
      sat.deps,
    );
    expect(other.status).toBe(429);
    expect(other.headers.get("Set-Cookie")).toBeNull();
  });

  it("a 61-code-point name is cut to 60 and control characters are removed", async () => {
    const { deps } = makeDeps();
    const res = await handleConsoleLogin(
      login({
        secret: SECRET,
        name: `Be\u0000\u001b[31m${"\u{1F600}".repeat(61)}`,
      }),
      deps,
    );
    const name = (await res.json()).data.name as string;
    expect([...name].length).toBe(60);
    expect(name).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(name.startsWith("Be[31m")).toBe(true);
  });

  it("a cookie sealed under an old secret's epoch is treated as signed out after FACILITATOR_SECRET changes", async () => {
    const { deps } = makeDeps();
    const value = cookieValue(
      await handleConsoleLogin(login({ secret: SECRET, name: "Ann" }), deps),
    );
    expect(requireConsole(withCookie(value), deps)).toMatchObject({
      name: "Ann",
    });
    const rotated = {
      ...deps,
      config: baseConfig({ facilitatorSecret: "a brand new secret value" }),
    } as Deps;
    const res = requireConsole(withCookie(value), rotated);
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(401);
    expect(consoleSessionFromToken(value, rotated.config, clock)).toBeNull();
  });

  it("login is disabled with a generic message when FACILITATOR_SECRET, LAUNCHER_URL or LAUNCHER_TOKEN is unset", async () => {
    for (const o of [
      { facilitatorSecret: undefined },
      { launcherUrl: undefined },
      { launcherToken: undefined },
    ]) {
      const { deps } = makeDeps(o);
      const res = await handleConsoleLogin(
        login({ secret: SECRET, name: "Ann" }),
        deps,
      );
      expect(res.status).toBe(503);
      expect(res.headers.get("Set-Cookie")).toBeNull();
      const msg = (await res.json()).error.message as string;
      expect(msg).toBe("The console is not set up on this server.");
      for (const name of ["FACILITATOR_SECRET", "LAUNCHER_URL", "LAUNCHER_TOKEN"])
        expect(msg).not.toContain(name);
      expect(msg).not.toContain(SECRET);
      const req = requireConsole(withCookie("x"), deps);
      expect((req as Response).status).toBe(503);
    }
  });

  it("a player cookie is rejected by requireConsole", () => {
    const { deps } = makeDeps();
    const player = seal(
      {
        sessionId: "s1",
        roleId: "r",
        participantId: "p",
        credential: "c",
        logIdentity: "l",
        expiresAt: clock + 60_000,
      },
      KEYS,
      clock,
    );
    for (const req of [withCookie(player), withCookie(player, COOKIE_NAME)]) {
      const res = requireConsole(req, deps);
      expect((res as Response).status).toBe(401);
    }
    // a facilitator-purpose cookie with the epoch missing is also refused
    const noEpoch = seal(
      { name: "Ann", expiresAt: clock + 60_000 },
      KEYS,
      clock,
      "fac",
    );
    expect((requireConsole(withCookie(noEpoch), deps) as Response).status).toBe(
      401,
    );
  });

  it("logout clears the cookie and checks Origin", async () => {
    const { deps } = makeDeps();
    const out = await handleConsoleLogout(login({}, {}), deps);
    expect(out.status).toBe(200);
    expect(out.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect(
      (
        await handleConsoleLogout(
          login({}, { Origin: "https://evil.example" }),
          deps,
        )
      ).status,
    ).toBe(403);
  });
});

describe("console configuration", () => {
  const base = () => ({
    PUBLIC_ORIGIN: ORIGIN,
    COOKIE_KEYS: `k1:${Buffer.alloc(32, 1).toString("base64")}`,
  });
  it("a player-only deployment with only RUNTIME_URL set still loads its configuration", () => {
    const c = loadConfig({
      ...base(),
      RUNTIME_URL: "wss://runtime.internal:8443",
    });
    expect(c.facilitatorSecret).toBeUndefined();
    expect(c.launcherUrl).toBeUndefined();
    expect(c.launcherToken).toBeUndefined();
  });
  it("reads the console variables and does not require RUNTIME_URL when LAUNCHER_URL is set", () => {
    const c = loadConfig({
      ...base(),
      FACILITATOR_SECRET: SECRET,
      LAUNCHER_URL: "http://localhost:4000",
      LAUNCHER_TOKEN: "t".repeat(32),
    });
    expect([c.facilitatorSecret, c.launcherUrl, c.launcherToken]).toEqual([
      SECRET,
      "http://localhost:4000",
      "t".repeat(32),
    ]);
  });
  it.each([
    ["FACILITATOR_SECRET", "short"],
    ["LAUNCHER_URL", "https://127.0.0.1:4000"],
    ["LAUNCHER_URL", "http://example.org:4000"],
    ["LAUNCHER_URL", "http://127.0.0.1/"],
    ["LAUNCHER_URL", "http://u:p@127.0.0.1:4000"],
    ["LAUNCHER_TOKEN", "short"],
  ])(
    "an invalid %s is a configuration error naming the variable and not the value",
    (name, value) => {
      const env: Record<string, string> = {
        ...base(),
        RUNTIME_URL: "wss://r:1",
        FACILITATOR_SECRET: SECRET,
        LAUNCHER_URL: "http://127.0.0.1:4000",
        LAUNCHER_TOKEN: "t".repeat(32),
        [name]: value,
      };
      let message = "";
      try {
        loadConfig(env);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain(name);
      expect(message).not.toContain(value);
    },
  );
});
