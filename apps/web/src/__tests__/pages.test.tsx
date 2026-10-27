// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import JoinPage from "../app/join/page";
import SessionPage from "../app/session/[id]/page";
import { MESSAGES } from "../lib/messages";

// The pages are async server components: call them, then render what they return.
afterEach(cleanup);

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
