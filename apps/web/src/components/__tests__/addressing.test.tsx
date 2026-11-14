// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlayerView } from "@acr/events";
import { SayBox } from "../SayBox";
import { SceneTalk } from "../SceneTalk";
import { ThinkingLines } from "../ThinkingLines";
import { Transcript } from "../Transcript";
import { WaitingForYou } from "../WaitingForYou";
import { AiTurnState, AI_TURN_LABELS, aiTurnLabel } from "../console/AiTurnState";
import { ConsoleTimeline } from "../console/ConsoleTimeline";
import { ACTIVITY_EXPIRY_MS } from "../../lib/activity";

// US-0082 (AC-0480 to AC-0487, AC-0494 to AC-0497): thinking lines, "Waiting for you", the @ list and the direction of a line.

afterEach(() => { cleanup(); vi.useRealTimers(); });
const ok = async () => ({ ok: true as const });
const cands = [{ roleId: "tech_lead", label: "Tech lead", detail: "AI player" }, { roleId: "client_sponsor", label: "Client sponsor", detail: "AI character" }];

describe("ThinkingLines", () => {
  it("test_thinking_line_names_the_ai_and_expires_by_itself", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const label = (r: string) => ({ name: r === "client_sponsor" ? "Client sponsor" : r, ai: true });
    const { container } = render(<ThinkingLines activity={{ client_sponsor: { state: "thinking", at: 1_000 } }} label={label} />);
    const region = screen.getByTestId("thinking");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("Client sponsorAI is thinking…");
    act(() => { vi.advanceTimersByTime(ACTIVITY_EXPIRY_MS + 5); });
    expect(region.textContent).toBe("");
    expect(container.querySelectorAll("[style]")).toHaveLength(0);
  });
  it("test_thinking_line_shows_nothing_for_idle", () => {
    render(<ThinkingLines activity={{ a: { state: "idle", at: Date.now() } }} label={() => ({ name: "A", ai: true })} />);
    expect(screen.getByTestId("thinking").textContent).toBe("");
  });
});

describe("WaitingForYou", () => {
  it("test_waiting_for_you_is_a_polite_status_with_words", () => {
    const { rerender } = render(<WaitingForYou by="Client sponsor" />);
    expect(screen.getByRole("status").textContent).toContain("Waiting for you");
    expect(screen.getByRole("status").textContent).toContain("Client sponsor addressed you");
    rerender(<WaitingForYou by={null} />);
    expect(screen.getByRole("status").textContent).toBe("");
  });
});

describe("SayBox @ list", () => {
  it("test_say_box_at_opens_the_list_and_choosing_sets_to", async () => {
    const onSay = vi.fn(ok);
    render(<SayBox disabledReason={null} onSay={onSay} candidates={cands} />);
    const input = screen.getByRole("combobox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "@" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Tech lead AI player", "Client sponsor AI character"]);
    expect(input.getAttribute("aria-expanded")).toBe("true");
    fireEvent.change(input, { target: { value: "@cli" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("@Client sponsor ");
    expect(screen.getByText(/everyone in the scene still sees the line/)).toBeTruthy();
    fireEvent.change(input, { target: { value: "@Client sponsor when?" } });
    await act(async () => { fireEvent.submit(input.closest("form")!); });
    expect(onSay).toHaveBeenCalledWith("@Client sponsor when?", "client_sponsor");
    expect(input.value).toBe("");
  });
  it("test_say_box_keyboard_and_dropping_the_mention_clears_to", async () => {
    const onSay = vi.fn(ok);
    render(<SayBox disabledReason={null} onSay={onSay} candidates={cands} />);
    const input = screen.getByRole("combobox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Hi @" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[1]!.id);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input.value).toBe("Hi @Tech lead ");
    fireEvent.change(input, { target: { value: "Hi all" } }); // the mention is gone
    await act(async () => { fireEvent.submit(input.closest("form")!); });
    expect(onSay).toHaveBeenCalledWith("Hi all");
    fireEvent.change(input, { target: { value: "@" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.getAttribute("aria-expanded")).toBe("false");
  });
  it("test_say_box_option_click_and_no_list_without_candidates", () => {
    render(<SayBox disabledReason={null} onSay={ok} candidates={cands} />);
    const input = screen.getByRole("combobox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "@" } });
    fireEvent.mouseDown(screen.getAllByRole("option")[0]!);
    expect(input.value).toBe("@Tech lead ");
    cleanup();
    render(<SayBox disabledReason={null} onSay={ok} />);
    expect(screen.queryByRole("combobox")).toBeNull();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "@" } });
    expect(screen.queryByRole("option")).toBeNull();
  });
});

describe("the direction of a line", () => {
  it("test_transcript_shows_who_a_line_is_for_and_highlights_mine", () => {
    const { container } = render(<Transcript selfRole="me" names={{ peer: "Pat" }} playerRoles={new Set(["me", "peer"])} aiRoles={new Set()}
      lines={[{ seq: 1, ts: 1, roleId: "client_sponsor", text: "Your view?", sceneId: "s1", to: "me" }, { seq: 2, ts: 2, roleId: "me", text: "Pat?", sceneId: "s1", to: "peer" }, { seq: 3, ts: 3, roleId: "peer", text: "plain", sceneId: "s1" }]} />);
    const items = container.querySelectorAll("li");
    expect(items[0]!.className).toContain("to-me");
    expect(items[0]!.textContent).toContain("to you");
    expect(items[1]!.textContent).toContain("to Pat");
    expect(items[1]!.className).not.toContain("to-me");
    expect(items[2]!.textContent).not.toContain(" to ");
  });
  it("test_console_timeline_shows_the_direction", () => {
    render(<ConsoleTimeline names={{ peer: "Pat" }} playerRoles={new Set(["peer", "bot"])} aiPlayers={new Set(["bot"])}
      entries={[{ seq: 1, ts: 1, kind: "line", text: "hi", roleId: "client_sponsor", to: "bot" }, { seq: 2, ts: 2, kind: "line", text: "yo", roleId: "bot", to: "peer" }]} />);
    expect(screen.getByText("AI player (Bot)")).toBeTruthy();
    expect(screen.getByText("Pat")).toBeTruthy();
  });
});

describe("SceneTalk", () => {
  const view = (over: Partial<PlayerView> = {}): PlayerView => ({
    lastSeq: 3, status: "running", paused: false, pausedSince: null, scene: { id: "s1", enteredAt: 0, pausedMs: 0, participants: ["me", "peer", "client_sponsor"] },
    transcript: [{ seq: 3, ts: 3, roleId: "client_sponsor", text: "Your call?", sceneId: "s1", to: "me" }], injects: [], ended: null, aiRoles: [], lastExit: null, ...over,
  });
  it("test_scene_talk_waits_for_the_addressed_player_and_lists_the_others", () => {
    render(<SceneTalk selfRole="me" view={view()} activity={{ client_sponsor: { state: "thinking", at: Date.now() } }} names={{ peer: "Pat" }} playerRoles={new Set(["me", "peer"])} disabledReason={null} onSay={ok} />);
    expect(screen.getByText(/Waiting for you/)).toBeTruthy();
    expect(screen.getByText(/is thinking/).textContent).toContain("Client sponsor");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "@" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Peer Pat", "Client sponsor AI character"]);
  });
});

describe("AiTurnState", () => {
  it("test_ai_turn_state_labels", () => {
    expect(aiTurnLabel(undefined, 0)).toBe(AI_TURN_LABELS.waiting);
    expect(aiTurnLabel({ state: "thinking", at: 0 }, 10)).toBe(AI_TURN_LABELS.thinking);
    expect(aiTurnLabel({ state: "thinking", at: 0 }, ACTIVITY_EXPIRY_MS)).toBe(AI_TURN_LABELS.waiting);
    expect(aiTurnLabel({ state: "idle", at: 0, outcome: "timed_out" }, 1)).toBe("Timed out (turn skipped)");
    expect(aiTurnLabel({ state: "idle", at: 0, outcome: "failed" }, 1)).toBe(AI_TURN_LABELS.failed);
    render(<AiTurnState entry={{ state: "idle", at: 0, outcome: "timed_out" }} />);
    expect(screen.getByLabelText("Turn: Timed out (turn skipped)").className).toContain("warn");
  });
});
