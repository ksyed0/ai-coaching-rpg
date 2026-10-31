import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { Config } from "../config";
import {
  FacilitatorSocketError,
  withFacilitatorSocket,
} from "../facilitator-socket";
import type { Deps } from "../handlers";
import { LauncherError, type LauncherClient } from "../launcher-client";
import { RuntimeConnection } from "../runtime-connection";
import { fakeRuntime } from "./fakes";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const SID = "s-0123456789abcdef";
const state = {
  lastSeq: 0,
  status: "lobby",
  paused: false,
  pausedSince: null,
  currentScene: null,
  transcript: [],
};
const ROSTER = [
  { roleId: "tech_lead", joined: true, consented: false, connected: true },
];
const send = (ws: WebSocket, m: unknown) => ws.send(JSON.stringify(m));

/** A runtime that accepts exactly the tokens in `good`; anything else gets the refusal the real one sends (an error frame, then 1008). */
function runtimeScript(good: Set<string>) {
  return (ws: WebSocket, m: any) => {
    if (m.type !== "join_facilitator") return;
    if (!good.has(m.token)) {
      send(ws, {
        type: "error",
        code: "unauthorized",
        message: "unauthorized",
      });
      ws.close(1008, "unauthorized");
      return;
    }
    send(ws, { type: "joined", roleId: "facilitator", state });
    send(ws, { type: "roster", audience: "facilitator", entries: ROSTER });
  };
}

let stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const s of stops) await s();
  stops = [];
});
async function runtime(good: string[]) {
  const rt = await fakeRuntime(runtimeScript(new Set(good)));
  stops.push(rt.stop);
  return { rt, port: Number(new URL(rt.url).port) };
}
function depsWith(
  pairs:
    | { port: number; token: string }[]
    | (() => Promise<{ port: number; token: string }>),
) {
  let i = 0;
  const facilitator = vi.fn(async (_id: string) =>
    typeof pairs === "function"
      ? pairs()
      : pairs[Math.min(i++, pairs.length - 1)]!,
  );
  const connect = vi.fn((url: string, address: string | null) =>
    RuntimeConnection.connect(url, address),
  );
  const deps = {
    config: {} as Config,
    launcher: { facilitator } as unknown as LauncherClient,
    connect: connect as unknown as Deps["connect"],
  } as Deps;
  return { deps, facilitator, connect };
}

describe("withFacilitatorSocket", () => {
  it("fetches port and token together, joins, runs fn with the roster and always closes", async () => {
    const { rt, port } = await runtime(["tok-A"]);
    const { deps, facilitator } = depsWith([{ port, token: "tok-A" }]);
    const seen: unknown[] = [];
    const result = await withFacilitatorSocket(
      deps,
      SID,
      async (conn, joined) => {
        seen.push(joined, conn.isOpen);
        return "done";
      },
    );
    expect(result).toBe("done");
    expect(seen).toEqual([{ roster: ROSTER, status: "lobby" }, true]);
    expect(facilitator).toHaveBeenCalledTimes(1);
    expect(facilitator).toHaveBeenCalledWith(SID);
    expect(rt.received[0]).toEqual({
      type: "join_facilitator",
      sessionId: SID,
      token: "tok-A",
    });
    await rt.closed();
  });

  it("no X-Forwarded-For on facilitator sockets", async () => {
    const { rt, port } = await runtime(["tok-A"]);
    const { deps, connect } = depsWith([{ port, token: "tok-A" }]);
    await withFacilitatorSocket(deps, SID, async () => undefined);
    expect(connect).toHaveBeenCalledWith(`ws://127.0.0.1:${port}`, null);
    expect(rt.headers).toHaveLength(1);
    expect(Object.keys(rt.headers[0]!)).not.toContain("x-forwarded-for");
  });

  it("a player socket still sends X-Forwarded-For (unchanged)", async () => {
    const { rt } = await runtime([]);
    const c = await RuntimeConnection.connect(rt.url, "203.0.113.5");
    c.close();
    expect(rt.headers[0]!["x-forwarded-for"]).toBe("203.0.113.5");
  });

  it("a refused facilitator token is not retried with the same token; one fresh {port, token} is fetched once", async () => {
    const stale = await runtime(["fresh-token"]);
    const { deps, facilitator } = depsWith([
      { port: stale.port, token: "stale-token" },
      { port: stale.port, token: "fresh-token" },
    ]);
    const out = await withFacilitatorSocket(
      deps,
      SID,
      async (_c, j) => j.status,
    );
    expect(out).toBe("lobby");
    expect(facilitator).toHaveBeenCalledTimes(2);
    expect(stale.rt.received.map((m) => m.token)).toEqual([
      "stale-token",
      "fresh-token",
    ]);
  });

  it("when the fresh pair carries the same token it is not sent again", async () => {
    const { rt, port } = await runtime(["other"]);
    const { deps, facilitator } = depsWith([
      { port, token: "stale-token" },
      { port, token: "stale-token" },
    ]);
    await expect(
      withFacilitatorSocket(deps, SID, async () => "x"),
    ).rejects.toMatchObject({
      name: "FacilitatorSocketError",
      reason: "unauthorized",
    });
    expect(facilitator).toHaveBeenCalledTimes(2);
    expect(rt.received).toHaveLength(1);
  });

  it("two refused tokens give up with a plain failure: two fetches, two joins, never a third", async () => {
    const { rt, port } = await runtime(["never"]);
    let n = 0;
    const { deps, facilitator } = depsWith(async () => ({
      port,
      token: `tok-${++n}`,
    }));
    const err = await withFacilitatorSocket(deps, SID, async () => "x").catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(FacilitatorSocketError);
    expect(err.reason).toBe("unauthorized");
    expect(`${err.message}${err.stack}`).not.toMatch(/tok-\d|127\.0\.0\.1/);
    expect(facilitator).toHaveBeenCalledTimes(2);
    expect(rt.received.map((m) => m.token)).toEqual(["tok-1", "tok-2"]);
  });

  it("closes the connection when fn throws, and rethrows", async () => {
    const { rt, port } = await runtime(["tok-A"]);
    const { deps } = depsWith([{ port, token: "tok-A" }]);
    await expect(
      withFacilitatorSocket(deps, SID, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await rt.closed();
  });

  it("a runtime that cannot be reached is unavailable and is not retried", async () => {
    const dead = await fakeRuntime();
    const port = Number(new URL(dead.url).port);
    await dead.stop();
    const { deps, facilitator } = depsWith([{ port, token: "tok-A" }]);
    await expect(
      withFacilitatorSocket(deps, SID, async () => "x"),
    ).rejects.toMatchObject({ reason: "unavailable" });
    expect(facilitator).toHaveBeenCalledTimes(1);
  });

  it("a launcher failure propagates as the LauncherError; a deployment without a launcher is unavailable", async () => {
    const { deps } = depsWith(async () => {
      throw new LauncherError("not_found");
    });
    await expect(
      withFacilitatorSocket(deps, SID, async () => "x"),
    ).rejects.toMatchObject({ name: "LauncherError", reason: "not_found" });
    await expect(
      withFacilitatorSocket(
        { ...deps, launcher: undefined } as Deps,
        SID,
        async () => "x",
      ),
    ).rejects.toMatchObject({ reason: "unavailable" });
  });
});
