// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import JoinPage from "../app/join/page";
import SessionPage from "../app/session/[id]/page";
import { MESSAGES } from "../lib/messages";
import { COOKIE_NAME } from "../server/handlers";
import { seal } from "../server/seal";

// The pages read the request's cookies (next/headers) and may redirect (next/navigation): both are stood in for here. The BFF's shared
// dependencies are built from this test's environment, so the /join page opens the cookie with the real seal and config code.
const jar = vi.hoisted(() => ({ cookie: undefined as string | undefined }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => (name === "__Host-scenecoach" && jar.cookie !== undefined ? { name, value: jar.cookie } : undefined) }) }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`REDIRECT ${url}`); } }));
const KEY = Buffer.alloc(32, 5);
process.env.RUNTIME_URL = "ws://127.0.0.1:4999";
process.env.PUBLIC_ORIGIN = "http://localhost:3000";
process.env.COOKIE_KEYS = `k1:${KEY.toString("base64")}`;
delete (globalThis as Record<symbol, unknown>)[Symbol.for("scenecoach.web.deps")];

// The pages are async server components: call them, then render what they return.
afterEach(() => { cleanup(); jar.cookie = undefined; });

const join = async (q: Record<string, string | undefined>) => render(await JoinPage({ searchParams: Promise.resolve(q) }));
const session = async (id: string) => render(await SessionPage({ params: Promise.resolve({ id }) }));

describe("pages validate the ids in the link", () => {
  it("/join with a well-formed session and role shows the form", async () => {
    await join({ session: "web-smoke", role: "account_manager" });
    expect(screen.getByLabelText("Your join code")).toBeTruthy();
  });

  it("/join with a missing or malformed session or role shows the bad-link message and no form", async () => {
    for (const q of [{}, { session: "web-smoke" }, { session: "a b", role: "account_manager" }, { session: "web-smoke", role: "Account Manager" }, { session: "web-smoke", role: "x".repeat(200) }, { session: "../etc", role: "am" }]) {
      const r = await join(q);
      expect(screen.getByText(MESSAGES.badLink)).toBeTruthy();
      expect(screen.queryByLabelText("Your join code")).toBeNull();
      r.unmount();
    }
  });

  it("/session/<id> with a malformed id shows the bad-link message and opens no stream", async () => {
    const opened: string[] = [];
    const g = globalThis as { EventSource?: unknown };
    const before = g.EventSource;
    g.EventSource = class { constructor(url: string) { opened.push(url); } addEventListener() {} close() {} readyState = 0; onerror = null; };
    try {
      const r = await session("a b/..");
      expect(screen.getByText(MESSAGES.badLink)).toBeTruthy();
      expect(opened).toEqual([]);
      r.unmount();
      await session("web-smoke");
      expect(opened).toEqual(["/api/v1/stream?session=web-smoke"]);
    } finally {
      g.EventSource = before;
    }
  });
});

describe("/join for a player who already holds a seat", () => {
  const cookieFor = (sessionId: string, o: { key?: Buffer; expiresAt?: number } = {}) =>
    seal({ sessionId, roleId: "account_manager", participantId: "p-1", credential: "0123456789abcdef0123456789abcdef", logIdentity: "0123456789abcdef0123456789abcdef", expiresAt: o.expiresAt ?? Date.now() + 3_600_000 }, [{ id: "k1", key: o.key ?? KEY }], Date.now());

  it("redirects to the session page instead of asking again for a code that no longer works", async () => {
    expect(COOKIE_NAME).toBe("__Host-scenecoach");
    jar.cookie = cookieFor("web-smoke");
    await expect(join({ session: "web-smoke", role: "account_manager" })).rejects.toThrow("REDIRECT /session/web-smoke");
  });

  it("shows the form for a cookie of another session, a cookie sealed with another key or a malformed one", async () => {
    for (const c of [cookieFor("other-session"), cookieFor("web-smoke", { key: Buffer.alloc(32, 6) }), "not-a-cookie"]) {
      jar.cookie = c;
      const r = await join({ session: "web-smoke", role: "account_manager" });
      expect(screen.getByLabelText("Your join code")).toBeTruthy();
      r.unmount();
    }
  });
});
