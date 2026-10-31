import { describe, expect, it, vi } from "vitest";
import type { Config } from "../config";
import type { Deps } from "../handlers";
import { LauncherError, type LauncherClient } from "../launcher-client";
import { resolveRuntimeUrl } from "../runtime-lookup";

const LAUNCHER_URL = "http://127.0.0.1:47123";
const config: Config = {
  runtimeUrl: "wss://runtime.internal:8443",
  publicOrigin: "https://play.example.org",
  cookieKeys: [],
  cookieMaxAgeHours: 12,
  maxStreams: 1,
  maxStreamsPerSession: 1,
  maxStreamsPerAddress: 1,
};
const depsWith = (
  launcher?: Partial<LauncherClient>,
  c: Config = config,
): Deps =>
  ({
    config: c,
    ...(launcher && { launcher: launcher as LauncherClient }),
  }) as Deps;
const info = (o: object) => ({
  sessionId: "s-1",
  scenarioId: "x",
  status: "running",
  ...o,
});

describe("resolveRuntimeUrl", () => {
  it("single mode returns RUNTIME_URL for any session id", async () => {
    const d = depsWith();
    for (const id of ["s-1", "anything", "not even valid"])
      expect(await resolveRuntimeUrl(d, id)).toBe(
        "wss://runtime.internal:8443",
      );
  });

  it("launcher mode returns the loopback URL of a running session", async () => {
    const session = vi.fn().mockResolvedValue(info({ port: 40123 }));
    expect(await resolveRuntimeUrl(depsWith({ session }), "s-1")).toBe(
      "ws://127.0.0.1:40123",
    );
    expect(session).toHaveBeenCalledWith("s-1");
  });

  it("launcher mode ignores RUNTIME_URL entirely", async () => {
    const session = vi.fn().mockResolvedValue(info({ port: 40123 }));
    expect(
      await resolveRuntimeUrl(
        depsWith({ session }, { ...config, runtimeUrl: "" }),
        "s-1",
      ),
    ).toBe("ws://127.0.0.1:40123");
  });

  it("launcher mode returns null for stopped and ended sessions", async () => {
    for (const status of ["stopped", "ended"]) {
      expect(
        await resolveRuntimeUrl(
          depsWith({
            session: vi.fn().mockResolvedValue(info({ status, port: 40123 })),
          }),
          "s-1",
        ),
        status,
      ).toBeNull();
    }
  });

  it("launcher mode returns null for a running session without a port, and for an answer about another session", async () => {
    expect(
      await resolveRuntimeUrl(
        depsWith({ session: vi.fn().mockResolvedValue(info({})) }),
        "s-1",
      ),
    ).toBeNull();
    expect(
      await resolveRuntimeUrl(
        depsWith({
          session: vi
            .fn()
            .mockResolvedValue(info({ sessionId: "s-other", port: 40123 })),
        }),
        "s-1",
      ),
    ).toBeNull();
  });

  it("launcher mode returns null when the launcher does not know the session", async () => {
    expect(
      await resolveRuntimeUrl(
        depsWith({
          session: vi.fn().mockRejectedValue(new LauncherError("not_found")),
        }),
        "s-1",
      ),
    ).toBeNull();
  });

  it("other launcher failures propagate so the caller answers unavailable", async () => {
    for (const reason of [
      "unavailable",
      "timeout",
      "unauthorized",
      "failed",
      "capacity",
    ] as const) {
      await expect(
        resolveRuntimeUrl(
          depsWith({
            session: vi.fn().mockRejectedValue(new LauncherError(reason)),
          }),
          "s-1",
        ),
      ).rejects.toMatchObject({ reason });
    }
  });

  it("a launcher failure never carries the launcher URL", async () => {
    const e = new LauncherError("unavailable");
    expect(`${e.message} ${e.name} ${e.stack}`).not.toContain(LAUNCHER_URL);
    expect(`${e.message}`).not.toContain("47123");
  });
});
