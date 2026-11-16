// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { initialState, type SessionState } from "@acr/events";
import { viewFromReset } from "../../lib/console-view";
import type { ConsoleStreamUi } from "../../lib/use-console-stream";
import { FakeClock } from "../../lib/__tests__/fakes";
import { LiveView } from "../console/LiveView";
import { ConsoleTimeline } from "../console/ConsoleTimeline";
import { WordsSpoken } from "../console/WordsSpoken";
import { consoleStreamReducer, initialConsoleState } from "../../lib/use-console-stream";

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
    conn: "live", final: null, channel: "c1", scenes: [{ ...scene, injects: [] }], characters: [], view: { ...viewFromReset(st), timeline }, notice: null,
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
    expect(within(live).getByText("Objective: Get through")).toBeTruthy();
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

  it("controls render after the status card", () => {
    render(<LiveView ui={ui()} clock={new FakeClock(T)} controls={<p data-testid="ctl">CONTROLS</p>} />);
    const card = screen.getByRole("heading", { name: "Live session" }).closest("section")!;
    const ctl = screen.getByTestId("ctl");
    expect(card.compareDocumentPosition(ctl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.contains(ctl)).toBe(false);
    expect(card.nextElementSibling).toBe(ctl);
  });

  it("without controls nothing extra renders", () => {
    render(<LiveView ui={ui()} clock={new FakeClock(T)} />);
    expect(screen.queryByTestId("ctl")).toBeNull();
  });

  it("Words spoken shows the name in bdi and a muted role label", () => {
    render(<LiveView ui={ui({}, { talk: { a: { words: 1, lines: 1 } } })} clock={new FakeClock(T)} />);
    const row = within(screen.getByRole("table", { name: "Players" })).getAllByRole("row")[1]!;
    expect(row.querySelectorAll("bdi")).toHaveLength(2);
    expect(row.querySelector(".muted")!.textContent).toContain("A");
  });

  // ---- US-0060: AI players are labelled from state.aiRoles, never from a name ----
  const AI_ROLES = { a: { kind: "player" as const }, tech_lead: { kind: "player" as const }, n: { kind: "npc" as const } };
  const aiUi = (timeline: Parameters<typeof ui>[2], over: Partial<ConsoleStreamUi> = {}) =>
    ui({ roster: [
      { roleId: "a", name: "Sam", joined: true, consented: true, connected: true },
      { roleId: "tech_lead", name: "Pat", joined: true, consented: true, connected: true, ai: true },
    ], ...over }, { roles: AI_ROLES, aiRoles: ["tech_lead"], talk: { tech_lead: { words: 4, lines: 2 } } }, timeline);
  const items = () => within(screen.getByRole("list", { name: "Transcript and notices" })).getAllByRole("listitem");

  it("the timeline labels tech_lead's line \"AI player\" with the AI pill and \"Tech lead\" even when names maps tech_lead to \"Pat\"", () => {
    render(<LiveView ui={aiUi([{ seq: 1, ts: 1, kind: "line", text: "I will own it", roleId: "tech_lead" }])} clock={new FakeClock(T)} />);
    const li = items()[0]!;
    expect(within(li).getByText("AI player")).toBeTruthy();
    expect(within(li).getByText("AI")).toBeTruthy();
    expect(within(li).getByText("Tech lead")).toBeTruthy();
    expect(li.textContent).not.toContain("Pat");
  });

  it("the timeline shows AI player even if the console roster holds no ai flag or name for the seat (state.aiRoles alone decides)", () => {
    render(<LiveView ui={aiUi([{ seq: 1, ts: 1, kind: "line", text: "x", roleId: "tech_lead" }], { roster: [] })} clock={new FakeClock(T)} />);
    expect(within(items()[0]!).getByText("AI player")).toBeTruthy();
  });

  it("account_manager's line has no AI pill", () => {
    render(<ConsoleTimeline entries={[{ seq: 1, ts: 1, kind: "line", text: "hi", roleId: "account_manager" }]} names={{ account_manager: "Sam" }} playerRoles={new Set(["account_manager", "tech_lead"])} aiPlayers={new Set(["tech_lead"])} />);
    const li = items()[0]!;
    expect(within(li).queryByText("AI")).toBeNull();
    expect(within(li).getByText("Sam")).toBeTruthy();
  });

  it("an AI character's line keeps its pill and name", () => {
    render(<ConsoleTimeline entries={[{ seq: 1, ts: 1, kind: "line", text: "hm", roleId: "n" }]} names={{ n: "Nia" }} playerRoles={new Set(["a"])} aiPlayers={new Set()} />);
    const li = items()[0]!;
    expect(within(li).getByText("AI")).toBeTruthy();
    expect(within(li).getByText("Nia")).toBeTruthy();
    expect(within(li).queryByText("AI player")).toBeNull();
  });

  it("regression: every timeline line of a role in aiPlayers carries the label, live lines and the reset (history) view alike", () => {
    const names = { tech_lead: "Pat", a: "Sam" };
    const state: SessionState = { ...initialState(), status: "running", lastSeq: 3, roles: AI_ROLES, aiRoles: ["tech_lead"],
      transcript: [
        { seq: 1, ts: 1, roleId: "tech_lead", text: "old line", channel: "text", sceneId: null },
        { seq: 2, ts: 2, roleId: "a", text: "human line", channel: "text", sceneId: null },
      ] };
    // The reset (history) view, then one more live line through the reducer.
    let s = consoleStreamReducer(initialConsoleState, { type: "reset", state });
    s = consoleStreamReducer(s, { type: "event", event: { type: "utterance", seq: 4, ts: 4, roleId: "tech_lead", text: "new line", channel: "text" } as never });
    const entries = s.view!.timeline;
    expect(entries.filter((e) => e.kind === "line" && e.roleId === "tech_lead")).toHaveLength(2);
    render(<ConsoleTimeline entries={entries} names={names} playerRoles={new Set(["a", "tech_lead"])} aiPlayers={new Set(["tech_lead"])} />);
    for (const li of items()) {
      const isAi = /old line|new line/.test(li.textContent ?? "");
      if (isAi) {
        expect(within(li).getByText("AI")).toBeTruthy();
        expect(within(li).getByText("AI player")).toBeTruthy();
        expect(li.textContent).not.toContain("Pat");
      } else if (li.textContent!.includes("human line")) expect(within(li).queryByText("AI")).toBeNull();
    }
  });

  it("the Words spoken row of an AI player reads AI player with the AI pill, not the name", () => {
    render(<WordsSpoken rows={[{ roleId: "tech_lead", kind: "player", words: 4, lines: 2 }]} names={{ tech_lead: "Pat" }} aiPlayers={new Set(["tech_lead"])} />);
    const row = screen.getByRole("row", { name: /Tech lead/ });
    expect(within(row).getByText("AI player")).toBeTruthy();
    expect(within(row).getByText("AI")).toBeTruthy();
    expect(row.textContent).not.toContain("Pat");
  });

  it("the reducer names an AI player's seat in notices by its role, never by its name", () => {
    const state: SessionState = { ...initialState(), status: "running", lastSeq: 1, roles: AI_ROLES, aiRoles: ["tech_lead"] };
    let s = consoleStreamReducer({ ...initialConsoleState, roster: [{ roleId: "tech_lead", name: "Pat", joined: true, consented: true, connected: true, ai: true }] }, { type: "reset", state });
    s = consoleStreamReducer(s, { type: "event", event: { type: "facilitator.command", seq: 2, ts: 2, by: "Sam", command: "whisper", roleId: "tech_lead", text: "hi" } as never });
    const text = s.view!.timeline.map((e) => e.text).join("|");
    expect(text).toContain("AI player");
    expect(text).not.toContain("Pat");
  });

  it("no console screen renders a notice version as agreed (live view and controls with a consent-bearing roster)", async () => {
    const { ConsoleControls } = await import("../console/ConsoleControls");
    const { fakeFetch } = await import("../../lib/__tests__/fakes");
    const u = aiUi([{ seq: 1, ts: 1, kind: "line", text: "hi", roleId: "a" }]);
    const st = { ...u.view!.state, consents: { a: { noticeVersion: "v2", at: 1 } } } as SessionState;
    const withConsent = { ...u, view: { ...u.view!, state: st } };
    const { container } = render(<><LiveView ui={withConsent} clock={new FakeClock(T)} /><ConsoleControls sessionId="abcd1234" ui={withConsent} fetch={fakeFetch().fetch} /></>);
    expect(container.textContent).not.toMatch(/agreed|notice v\d/i);
  });
});
