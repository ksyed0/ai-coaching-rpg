// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionScreen } from "../SessionScreen";
import { MESSAGES } from "../../lib/messages";
import { SCENE_COPY } from "../../lib/scene-copy";
import { FakeClock, FakeEventSource, ev, fakeFetch, joinedFrame, snapshot } from "../../lib/__tests__/fakes";

// US-0080: the inform-only scene-ended dialog on the participant page, driven only by the live stream.
afterEach(cleanup);
beforeEach(() => FakeEventSource.reset());

const SCENES = [
  { id: "s1", title: "Kick-off", goal: "Agree the agenda.", timeBoxMinutes: 5, endsWhen: "the team agrees one position" },
  { id: "s2", title: "Client call", goal: "Agree what happens to the module.", timeBoxMinutes: 10, endsWhen: "you and Priya agree a next step" },
];
const T = 10_000_000 - 60_000;

function mount(scenes: unknown[] = SCENES, state = snapshot({ status: "running", lastSeq: 5, currentScene: { id: "s1", enteredAt: T, participants: [], pausedMs: 0 }, sceneHistory: [{ id: "s1", participants: ["account_manager"] }] })) {
  const f = fakeFetch();
  const clock = new FakeClock(10_000_000);
  const r = render(<SessionScreen sessionId="sess-1" deps={{ EventSource: FakeEventSource, fetch: f.fetch, clock }} />);
  const es = FakeEventSource.last();
  const emit = (type: string, data: unknown) => act(() => es.emit(type, data));
  emit("joined", joinedFrame({ scenes, state, consent: { noticeVersion: "v1", notice: "n", given: true } }));
  return { ...r, emit, f };
}
const exited = (seq: number, sceneId: string, reason: string) => ev(seq, "scene.exited", { sceneId, reason } as never, T + seq * 1_000);
const entered = (seq: number, sceneId: string) => ev(seq, "scene.entered", { sceneId, participants: ["account_manager"] }, T + seq * 1_000);
const dialog = () => screen.queryByRole("dialog");
const sayBox = () => screen.getByLabelText("Say something") as HTMLInputElement;

describe("SceneEndedDialog on the session page", () => {
  it("test_dialog_names_why_the_scene_ended_and_the_next_scene_with_its_objective_and_rule", () => {
    const m = mount();
    expect(dialog()).toBeNull();
    m.emit("event", exited(6, "s1", "gm_detects"));
    m.emit("event", entered(7, "s2"));
    const d = screen.getByRole("dialog", { name: "Scene 1 of 2 has ended: Kick-off" });
    expect(d.getAttribute("aria-modal")).toBe("false");
    const t = within(d);
    expect(t.getByText("The Game Master judged this scene's goal was met: the team agrees one position.")).toBeTruthy();
    expect(t.getByRole("heading", { name: "Next for you: Scene 2 of 2: Client call" })).toBeTruthy();
    expect(t.getByText("Objective: Agree what happens to the module.")).toBeTruthy();
    expect(t.getByText("Ends when: you and Priya agree a next step, at 10 min, or when your facilitator moves on")).toBeTruthy();
    expect(t.getByText(SCENE_COPY.nextStarted)).toBeTruthy();
    // The polite announcement holds the title and the reason.
    expect(screen.getAllByRole("status").some((s) => s.textContent === "Scene 1 of 2 has ended: Kick-off. The Game Master judged this scene's goal was met: the team agrees one position.")).toBe(true);
    // Inform-only: the next scene runs underneath; its lines arrive while the dialog is open and the say box works.
    m.emit("event", ev(8, "utterance", { roleId: "delivery_lead", text: "Priya is on the line.", channel: "text" }, T + 8_000));
    expect(screen.getByText("Priya is on the line.")).toBeTruthy();
    expect(sayBox().disabled).toBe(false);
    expect(screen.getByText(/Scene 2 of 2: Client call/, { selector: "b" })).toBeTruthy();
    fireEvent.click(t.getByRole("button", { name: "Continue" }));
    expect(dialog()).toBeNull();
    expect(m.container.querySelectorAll("[style]")).toHaveLength(0);
  });

  it("test_dialog_keeps_the_typed_draft_and_the_focus_and_Escape_closes_it", () => {
    const m = mount();
    const box = sayBox();
    box.focus();
    fireEvent.change(box, { target: { value: "I was about to say" } });
    m.emit("event", exited(6, "s1", "facilitator_advance"));
    m.emit("event", entered(7, "s2"));
    expect(within(dialog()!).getByText("Your facilitator moved the session on.")).toBeTruthy();
    expect(document.activeElement).toBe(box); // not stolen
    expect(box.value).toBe("I was about to say");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(box);
    expect(box.value).toBe("I was about to say");
  });

  it("test_dialog_with_a_draft_but_the_focus_dropped_does_not_take_the_focus", () => {
    const m = mount();
    fireEvent.change(sayBox(), { target: { value: "half a sentence" } });
    (document.activeElement as HTMLElement | null)?.blur();
    m.emit("event", exited(6, "s1", "time_box_elapsed"));
    expect(document.activeElement).toBe(document.body);
    m.emit("event", entered(7, "s2"));
    fireEvent.click(within(dialog()!).getByRole("button", { name: "Continue" }));
    // Back to the say box with the draft.
    expect(document.activeElement).toBe(sayBox());
    expect(sayBox().value).toBe("half a sentence");
  });

  it("test_dialog_takes_the_focus_when_nothing_holds_it_and_gives_it_to_the_say_box_on_Continue", () => {
    const m = mount();
    m.emit("event", exited(6, "s1", "time_box_elapsed"));
    m.emit("event", entered(7, "s2"));
    const d = dialog()!;
    expect(within(d).getByText("Time ran out (5 min).")).toBeTruthy();
    expect(document.activeElement).toBe(within(d).getByRole("button", { name: "Continue" }));
    fireEvent.click(within(d).getByRole("button", { name: "Continue" }));
    expect(document.activeElement).toBe(sayBox());
  });

  it("test_dialog_a_next_scene_the_player_is_not_yet_in_is_named_as_waiting", () => {
    const m = mount();
    m.emit("event", exited(6, "s1", "gm_detects")); // the scene that runs next does not include this player: no scene.entered comes
    const d = within(dialog()!);
    expect(d.getByRole("heading", { name: "Next for you: Scene 2 of 2: Client call" })).toBeTruthy();
    expect(d.getByText(SCENE_COPY.nextWaiting)).toBeTruthy();
  });

  it("test_dialog_after_the_players_last_scene_while_the_session_goes_on_says_so", () => {
    const m = mount(SCENES, snapshot({ status: "running", lastSeq: 5, currentScene: { id: "s2", enteredAt: T, participants: [], pausedMs: 0 } }));
    m.emit("event", exited(6, "s2", "gm_detects"));
    expect(within(dialog()!).getByText(SCENE_COPY.noMoreScenes)).toBeTruthy();
  });

  it("test_dialog_final_scene_shows_the_session_complete_variant", () => {
    const m = mount(SCENES, snapshot({ status: "running", lastSeq: 5, currentScene: { id: "s2", enteredAt: T, participants: [], pausedMs: 0 } }));
    m.emit("event", exited(6, "s2", "time_box_elapsed"));
    m.emit("event", ev(7, "session.ended", { reason: "script_complete" }, T + 7_000));
    const d = within(screen.getByRole("dialog", { name: "Scene 2 of 2 has ended: Client call" }));
    expect(d.getByText("Time ran out (10 min).")).toBeTruthy();
    expect(d.getByRole("heading", { name: "Session complete" })).toBeTruthy();
    expect(d.getByText("All scenes are done. The facilitator can now run the evaluation.")).toBeTruthy();
    expect(d.queryByText(/Next for you/)).toBeNull();
    expect(screen.getByText(MESSAGES.sessionEnded)).toBeTruthy(); // the end banner stays underneath
  });

  it("test_dialog_a_closed_dialog_stays_closed_through_the_end_of_the_session", () => {
    const m = mount();
    m.emit("event", exited(6, "s1", "gm_detects")); // this player is not in the scenes that follow
    fireEvent.click(within(dialog()!).getByRole("button", { name: "Continue" }));
    m.emit("event", ev(7, "session.ended", { reason: "script_complete" }, T + 7_000));
    expect(dialog()).toBeNull();
    m.emit("ended", {}); // the stream's final frame: the page swaps to its end layout
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("The session has ended");
    expect(dialog()).toBeNull();
  });

  it("test_dialog_never_opens_for_End_session", () => {
    const m = mount();
    m.emit("event", exited(6, "s1", "facilitator_end"));
    expect(dialog()).toBeNull(); // not even for the moment before session.ended arrives
    expect(screen.getAllByRole("status").some((s) => /has ended/.test(s.textContent ?? ""))).toBe(false);
    m.emit("event", ev(7, "session.ended", { reason: "facilitator_end", message: "Thanks all" }, T + 7_000));
    expect(dialog()).toBeNull();
    expect(screen.getByText(MESSAGES.sessionEnded)).toBeTruthy();
  });

  it("test_dialog_an_earlier_exit_closes_when_the_facilitator_ends_the_session", () => {
    const m = mount();
    m.emit("event", exited(6, "s1", "gm_detects")); // the player is not in the scene that runs next, so the End session exit never reaches it
    expect(dialog()).not.toBeNull();
    m.emit("event", ev(7, "session.ended", { reason: "facilitator_end" }, T + 7_000));
    expect(dialog()).toBeNull();
  });

  it("test_dialog_is_not_shown_after_a_reload_or_a_late_join", () => {
    // The page opens after scene 1 ended: only the join snapshot, which has no exit in it.
    mount(SCENES, snapshot({ status: "running", lastSeq: 9, currentScene: { id: "s2", enteredAt: T, participants: [], pausedMs: 0 }, sceneHistory: [{ id: "s1", participants: ["account_manager"] }, { id: "s2", participants: ["account_manager"] }] }));
    expect(dialog()).toBeNull();
    expect(screen.getByText(/Scene 2 of 2: Client call/)).toBeTruthy();
  });

  it("test_dialog_a_second_exit_reopens_it_with_the_new_scene_and_an_older_runtime_without_rules_still_reads", () => {
    const bare = SCENES.map(({ endsWhen: _drop, ...s }) => s);
    const m = mount(bare);
    m.emit("event", exited(6, "s1", "gm_detects"));
    m.emit("event", entered(7, "s2"));
    const d = within(dialog()!);
    expect(d.getByText("The Game Master judged this scene's goal was met.")).toBeTruthy();
    expect(d.getByText("Ends when: at 10 min, or when your facilitator moves on")).toBeTruthy();
    fireEvent.click(d.getByRole("button", { name: "Continue" }));
    expect(dialog()).toBeNull();
    m.emit("event", exited(8, "s2", "facilitator_advance"));
    expect(screen.getByRole("dialog", { name: "Scene 2 of 2 has ended: Client call" })).toBeTruthy();
  });
});
