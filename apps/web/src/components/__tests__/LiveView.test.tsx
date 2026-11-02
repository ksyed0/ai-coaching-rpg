// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { initialState, type SessionState } from "@acr/events";
import { viewFromReset } from "../../lib/console-view";
import type { ConsoleStreamUi } from "../../lib/use-console-stream";
import { FakeClock } from "../../lib/__tests__/fakes";
import { LiveView } from "../console/LiveView";

afterEach(cleanup);

const EVIL = "<img src=x onerror=alert(1)>, <b>bold</b>, ‮evil\tend";
const scene = { id: "s1", title: "The Gate", goal: "Get through", timeBoxMinutes: 5 };
const T = 1_000_000;

function ui(over: Partial<ConsoleStreamUi> = {}, state: Partial<SessionState> = {}, timeline: ConsoleStreamUi["view"] extends infer V ? (V extends { timeline: infer T2 } ? T2 : never) : never = []): ConsoleStreamUi {
  const st: SessionState = {
    ...initialState(), status: "running", lastSeq: 9, roles: { a: { kind: "player" }, n: { kind: "npc" } },
    currentScene: { id: "s1", enteredAt: T, participants: ["a"], pausedMs: 0 }, ...state,
  };
  return {
    conn: "live", final: null, channel: "c1", scenes: [scene], view: { ...viewFromReset(st), timeline }, notice: null,
    roster: [{ roleId: "a", name: EVIL, joined: true, consented: true, connected: true }], ...over,
  };
}

describe("LiveView", () => {
  it("renders <img src=x onerror=alert(1)>, <b>, U+202E and a tab in a line, a name, by, an alert, a Game Master condition and a closing message as literal text, with no img, b or script element", () => {
    const timeline = [
      { seq: 1, ts: 1, kind: "line" as const, text: EVIL, roleId: "a" },
      { seq: 2, ts: 2, kind: "notice" as const, text: `Paused by ${EVIL}` },
      { seq: 3, ts: 3, kind: "alert" as const, text: EVIL, level: "warning" as const },
      { seq: 4, ts: 4, kind: "notice" as const, text: `Game Master: “${EVIL}” is met` },
      { seq: 5, ts: 5, kind: "notice" as const, text: `Session ended. Message to participants: ${EVIL}` },
    ];
    const { container } = render(<LiveView ui={ui({ notice: EVIL }, { talk: { a: { words: 3, lines: 1 } } }, timeline)} clock={new FakeClock(T)} />);
    expect(container.querySelector("img, script")).toBeNull();
    expect([...container.querySelectorAll("b")].some((b) => b.textContent === "bold")).toBe(false);
    const list = screen.getByRole("list", { name: "Transcript and notices" });
    // Literal text, whitespace and the override character included: the five entries plus the name in the first one and in the table.
    expect(list.textContent!.split(EVIL).length - 1).toBe(6);
    expect(container.textContent!.split(EVIL).length - 1).toBeGreaterThanOrEqual(8); // plus the table name and the banner notice
  });

  it("a name with U+202E sits in its own bdi", () => {
    const { container } = render(<LiveView ui={ui({}, { talk: { a: { words: 1, lines: 1 } } }, [{ seq: 1, ts: 1, kind: "line", text: "hi", roleId: "a" }])} clock={new FakeClock(T)} />);
    const bdis = [...container.querySelectorAll("bdi")].filter((b) => b.textContent === EVIL);
    expect(bdis.length).toBeGreaterThanOrEqual(2); // in the timeline and in Words spoken
  });

  it("the Words spoken section has its heading and caption and its text never contains \"time\"", () => {
    render(<LiveView ui={ui({}, { talk: { a: { words: 7, lines: 2 } } })} clock={new FakeClock(T)} />);
    const section = screen.getByRole("region", { name: "Words spoken" });
    expect(within(section).getByRole("heading", { level: 2, name: "Words spoken" })).toBeTruthy();
    expect(within(section).getByText("Words and lines typed per role. A count, not a measure of quality.")).toBeTruthy();
    expect(section.textContent!.toLowerCase()).not.toContain("time");
    const heads = within(section).getAllByRole("columnheader").map((h) => [h.textContent, h.getAttribute("scope")]);
    expect(heads.slice(0, 3)).toEqual([["Role", "col"], ["Words", "col"], ["Lines", "col"]]);
    expect(within(section).getByRole("cell", { name: "7" })).toBeTruthy();
  });

  it("the timeline is a polite live region with additions only; an alert is labelled in text", () => {
    render(<LiveView ui={ui({}, {}, [
      { seq: 1, ts: 1, kind: "alert", text: "Code reissued", level: "info" },
      { seq: 2, ts: 2, kind: "alert", text: "Mic problem", level: "warning" },
      { seq: 3, ts: 3, kind: "notice", source: "facilitator", text: "Paused by Sam" },
      { seq: 4, ts: 4, kind: "notice", source: "gm", text: "Game Master: “x” is met" },
      { seq: 5, ts: 5, kind: "notice", source: "session", text: "Session started" },
    ])} clock={new FakeClock(T)} />);
    const list = screen.getByRole("list", { name: "Transcript and notices" });
    expect(list.getAttribute("aria-live")).toBe("polite");
    expect(list.getAttribute("aria-relevant")).toBe("additions");
    expect(list.getAttribute("tabindex")).toBe("0");
    const items = within(list).getAllByRole("listitem");
    expect(items[0]!.textContent).toContain("Alert:");
    expect(items[1]!.textContent).toContain("Warning:");
    expect(items[2]!.textContent).toMatch(/^Facilitator: /);
    expect(items[3]!.textContent).toBe("Game Master: “x” is met");
    expect(items[4]!.textContent).toBe("Session started");
  });

  it("the seq 0 notice has no date and no prefix", () => {
    render(<LiveView ui={ui({}, { lastSeq: 4 }, [{ seq: 0, ts: 0, kind: "notice", text: "Earlier Game Master notices and alerts are not shown after a reconnect." }])} clock={new FakeClock(T)} />);
    const item = within(screen.getByRole("list", { name: "Transcript and notices" })).getByRole("listitem");
    expect(item.textContent).toBe("Earlier Game Master notices and alerts are not shown after a reconnect.");
    expect(item.querySelector("time")).toBeNull();
  });

  it("scene title, goal and timer from scenes and currentScene; Paused shows the pill; no scene shows Between scenes", () => {
    const { rerender } = render(<LiveView ui={ui()} clock={new FakeClock(T + 60_000)} />);
    const live = screen.getByRole("region", { name: "Live session" });
    expect(within(live).queryByText("Running")).toBeNull();
    expect(within(live).getByText("Scene 1 of 1: The Gate")).toBeTruthy();
    expect(within(live).getByText("Goal: Get through")).toBeTruthy();
    expect(within(live).getByRole("timer").textContent).toContain("04:00");
    rerender(<LiveView ui={ui({}, { paused: true, pausedSince: T + 30_000 })} clock={new FakeClock(T + 60_000)} />);
    expect(screen.getAllByText("Paused")).toHaveLength(1); // the scene bar's pill only
    expect(screen.getByRole("timer").textContent).toContain("04:30");
    rerender(<LiveView ui={ui({}, { currentScene: null })} clock={new FakeClock(T)} />);
    expect(screen.getByText("Between scenes")).toBeTruthy();
    rerender(<LiveView ui={ui({ view: null })} clock={new FakeClock(T)} />);
    expect(screen.queryByText("Not started")).toBeNull(); // still connecting: no status word
    rerender(<LiveView ui={ui({}, { status: "idle", currentScene: null })} clock={new FakeClock(T)} />);
    expect(screen.getByText("Not started")).toBeTruthy();
    rerender(<LiveView ui={ui({}, { status: "ended", currentScene: null })} clock={new FakeClock(T)} />);
    expect(screen.getByText("Ended")).toBeTruthy();
  });

  it("an AI character's line has the AI pill and is listed under AI characters (context)", () => {
    render(<LiveView ui={ui({}, { talk: { a: { words: 2, lines: 1 }, n: { words: 9, lines: 4 } } }, [
      { seq: 1, ts: 1, kind: "line", text: "I am the guard", roleId: "n" },
      { seq: 2, ts: 2, kind: "line", text: "hello", roleId: "a" },
    ])} clock={new FakeClock(T)} />);
    const items = within(screen.getByRole("list", { name: "Transcript and notices" })).getAllByRole("listitem");
    expect(within(items[0]!).getByText("AI")).toBeTruthy();
    expect(within(items[1]!).queryByText("AI")).toBeNull();
    const ai = screen.getByRole("table", { name: "AI characters (context)" });
    expect(within(ai).getByText("N")).toBeTruthy();
    expect(within(ai).getByRole("cell", { name: "9" })).toBeTruthy();
    expect(within(screen.getByRole("table", { name: "Players" })).queryByText("N")).toBeNull();
  });

  it("the reconnecting banner and the notice sit in an always-mounted status region; a final message is not shown here", () => {
    const { rerender } = render(<LiveView ui={ui()} clock={new FakeClock(T)} />);
    const region = screen.getByRole("status");
    expect(region.textContent).toBe("");
    rerender(<LiveView ui={ui({ conn: "reconnecting", notice: "Server said hmm", final: { kind: "ended", message: "The session has ended." } })} clock={new FakeClock(T)} />);
    expect(screen.getByRole("status")).toBe(region);
    expect(region.textContent).toContain("Reconnecting");
    expect(region.textContent).toContain("Server said hmm");
    expect(screen.queryByText("The session has ended.")).toBeNull();
  });

  it("Words spoken shows the name in bdi and a muted role label", () => {
    render(<LiveView ui={ui({}, { talk: { a: { words: 1, lines: 1 } } })} clock={new FakeClock(T)} />);
    const row = within(screen.getByRole("table", { name: "Players" })).getAllByRole("row")[1]!;
    expect(row.querySelectorAll("bdi")).toHaveLength(2);
    expect(row.querySelector(".muted")!.textContent).toContain("A");
  });
});
