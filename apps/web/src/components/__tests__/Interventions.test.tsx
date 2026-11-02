// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { initialState, type SessionState } from "@acr/events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CharactersPanel } from "../console/CharactersPanel";
import { ConsoleControls } from "../console/ConsoleControls";
import type { Labeler } from "../console/Person";
import { audienceText, confirmCopy } from "../../lib/console-confirm";
import { fakeFetch, ok, refused } from "../../lib/__tests__/fakes";
import type { ConsoleStreamUi } from "../../lib/use-console-stream";

afterEach(cleanup);

const SID = "abcd1234efgh5678";
const SCENES = [
  {
    id: "s1",
    title: "Kick-off",
    goal: "Agree the agenda.",
    timeBoxMinutes: 5,
    injects: [
      { id: "i1", to: ["client_sponsor", "account_manager"], content: "The client emails: budget cut.", atMinute: 3 },
      { id: "i2", to: ["account_manager"], content: "A second note." },
      { id: "i3", to: [], content: "Nobody listed." },
    ],
  },
  { id: "s2", title: "Client call", goal: "g", timeBoxMinutes: 10, injects: [] },
];
const CHARS = [
  { roleId: "client_sponsor", goals: ["Protect the budget", "Keep the deadline"], facts: [{ n: 1, released: false }, { n: 2, released: true }] },
];

function stateOf(over: Partial<SessionState> = {}, sceneId: string | null = "s1"): SessionState {
  return {
    ...initialState(),
    status: "running",
    roles: {
      account_manager: { kind: "player" },
      designer: { kind: "player" },
      client_sponsor: { kind: "npc" },
    },
    currentScene: sceneId ? { id: sceneId, enteredAt: 1, participants: ["account_manager", "client_sponsor"], pausedMs: 0 } : null,
    ...over,
  };
}
function uiOf(over: Partial<ConsoleStreamUi> = {}, st: SessionState = stateOf()): ConsoleStreamUi {
  return {
    conn: "live",
    final: null,
    channel: "chan-1",
    scenes: SCENES,
    characters: CHARS,
    view: { state: st, timeline: [], gap: false },
    roster: [{ roleId: "account_manager", name: "Sam", joined: true, consented: true, connected: true }],
    notice: null,
    ...over,
  };
}
const FACTS = { roles: [{ roleId: "client_sponsor", facts: [{ n: 1, text: "SECRET one" }, { n: 2, text: "SECRET two" }] }] };
type Answer = Parameters<typeof fakeFetch>[0];
const defaultAnswer: NonNullable<Answer> = (url) => (url.endsWith("/facts") ? { status: 200, body: ok(FACTS) } : { status: 200, body: ok({ done: true }) });
function mount(ui: ConsoleStreamUi, answer: Answer = defaultAnswer) {
  const f = fakeFetch(answer);
  const r = render(<ConsoleControls sessionId={SID} ui={ui} fetch={f.fetch} />);
  const again = (next: ConsoleStreamUi) => r.rerender(<ConsoleControls sessionId={SID} ui={next} fetch={f.fetch} />);
  return { f, again, container: r.container, unmount: r.unmount };
}
const openFacts = () => {
  const d = screen.getByText(/Hidden facts \(\d+\)/).closest("details")!;
  act(() => {
    d.open = true;
    d.dispatchEvent(new Event("toggle"));
  });
  return d;
};
const closeFacts = (d: HTMLDetailsElement) => {
  act(() => {
    d.open = false;
    d.dispatchEvent(new Event("toggle"));
  });
};
const factCalls = (f: ReturnType<typeof fakeFetch>) => f.calls.filter((c) => c.url.endsWith("/facts"));

describe("Interventions", () => {
  it("firing an inject names its audience and content in the dialog and sends fire_inject with the scene id", async () => {
    const { f } = mount(uiOf());
    expect(screen.getByRole("heading", { name: "Injects" })).toBeTruthy();
    expect(screen.getByText("fires at minute 3", { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Fire inject i1" }));
    const dialog = screen.getByRole("dialog", { name: "Fire inject “i1”?" });
    expect(within(dialog).getByText("It is shown to Client sponsor (AI character) and Sam (Account manager). It cannot be taken back.", { exact: false })).toBeTruthy();
    expect(within(dialog).getByText("The client emails: budget cut.")).toBeTruthy();
    expect(f.calls).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Fire inject" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Inject fired."));
    expect(f.calls[0]!.body).toEqual({ channel: "chan-1", kind: "fire_inject", injectId: "i1", expectSceneId: "s1" });
  });

  it("a fired inject says Fired and its button reads Fire again; no scene says so", () => {
    const { again } = mount(uiOf({}, stateOf({ injectsFired: ["i2"] })));
    expect(screen.getByRole("button", { name: "Fire inject i2 again" }).textContent).toBe("Fire again");
    expect(screen.getByRole("button", { name: "Fire inject i1" }).textContent).toBe("Fire");
    expect(screen.getAllByText("Fired", { exact: false })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Fire inject i2 again" }));
    expect(screen.getByRole("dialog", { name: "Fire inject “i2” again?" })).toBeTruthy();
    again(uiOf({}, stateOf({}, null)));
    expect(screen.getByText("No scene is running.")).toBeTruthy();
  });

  it("an inject with no audience reads 'no listed role' in the dialog, never an empty phrase", () => {
    mount(uiOf());
    fireEvent.click(screen.getByRole("button", { name: "Fire inject i3" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("It is shown to no listed role. It cannot be taken back.")).toBeTruthy();
    expect(confirmCopy({ kind: "fire_inject", injectId: "x", audience: [], again: false }).description).toBe("It is shown to no listed role. It cannot be taken back.");
    expect(audienceText(["A", "B", "C"])).toBe("A, B and C");
  });

  it("whisper recipients are the current scene's players; the dialog names the recipient and shows the text; sends whisper", async () => {
    const { f } = mount(uiOf());
    const to = screen.getByLabelText("To") as HTMLSelectElement;
    expect([...to.options].map((o) => o.textContent)).toEqual(["Sam (Account manager)"]);
    expect(screen.queryByRole("option", { name: /Designer/ })).toBeNull();
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).maxLength).toBe(2000);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Ask about the budget." } });
    fireEvent.click(screen.getByRole("button", { name: "Send whisper" }));
    const dialog = screen.getByRole("dialog", { name: "Whisper to Sam (Account manager)?" });
    expect(within(dialog).getByText("Only Sam (Account manager) sees this message. It cannot be taken back.")).toBeTruthy();
    expect(within(dialog).getByText("Ask about the budget.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Send whisper" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Whisper sent."));
    expect(f.calls[0]!.body).toEqual({ channel: "chan-1", kind: "whisper", roleId: "account_manager", text: "Ask about the budget.", expectSceneId: "s1" });
  });

  it("with no scene running the whisper recipients are every player role", () => {
    mount(uiOf({}, stateOf({}, null)));
    const to = screen.getByLabelText("To") as HTMLSelectElement;
    expect([...to.options].map((o) => o.value)).toEqual(["account_manager", "designer"]);
  });

  it('a suggested fact shows "Suggested by the Game Master" and its Release opens "Release fact 1 of Client sponsor?" without any fact text having been fetched', async () => {
    const { f } = mount(uiOf({}, stateOf({ factsEarned: { client_sponsor: [1] } })));
    expect(screen.getByText("Suggested by the Game Master", { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Release fact 1 of Client sponsor" }));
    const dialog = screen.getByRole("dialog", { name: "Release fact 1 of Client sponsor?" });
    expect(within(dialog).getByText("Client sponsor may now share this fact with everyone in the room. It cannot be taken back.")).toBeTruthy();
    expect(factCalls(f)).toHaveLength(0);
    expect(document.body.textContent).not.toContain("SECRET");
    fireEvent.click(within(dialog).getByRole("button", { name: "Release fact" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Fact released."));
    expect(f.calls[0]!.body).toEqual({ channel: "chan-1", kind: "release_hidden", roleId: "client_sponsor", fact: 1, expectSceneId: "s1" });
  });

  it("a released fact has no Release button", () => {
    mount(uiOf());
    expect(screen.getByText("Fact 2 · Released")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Release fact 2 of Client sponsor" })).toBeNull();
    expect(screen.getByRole("button", { name: "Release fact 1 of Client sponsor" })).toBeTruthy();
  });

  it("the facts list is closed by default and fetches nothing; opening it fetches once and shows the text; closing it removes the text from the DOM; a failed fetch shows the alert and no text; a fetch answered after closing shows nothing", async () => {
    const { f } = mount(uiOf());
    const details = screen.getByText("Hidden facts (2)").closest("details")!;
    expect(details.open).toBe(false);
    expect(factCalls(f)).toHaveLength(0);
    expect(screen.getByText("Fact 1")).toBeTruthy(); // before any fetch: number only
    const d = openFacts();
    await waitFor(() => expect(screen.getByText("Fact 1: SECRET one")).toBeTruthy());
    expect(screen.getByText("Fact 2: SECRET two · Released")).toBeTruthy();
    expect(factCalls(f)).toHaveLength(1);
    expect(factCalls(f)[0]!.body).toEqual({ channel: "chan-1" });
    closeFacts(d);
    expect(document.body.textContent).not.toContain("SECRET");
    expect(screen.getByText("Fact 1")).toBeTruthy();
    // reopening fetches again (the text was not kept)
    openFacts();
    await waitFor(() => expect(screen.getByText("Fact 1: SECRET one")).toBeTruthy());
    expect(factCalls(f)).toHaveLength(2);
  });

  it("a failed facts fetch shows the alert, no text and no automatic retry", async () => {
    const { f } = mount(uiOf(), (url) => (url.endsWith("/facts") ? { status: 409, body: refused("no_channel", "x") } : { status: 200, body: ok({}) }));
    openFacts();
    await waitFor(() => expect(screen.getByText("The facts could not be loaded. Close the list and open it again.")).toBeTruthy());
    expect(screen.getByText("The facts could not be loaded. Close the list and open it again.").getAttribute("role")).toBe("alert");
    expect(document.body.textContent).not.toContain("SECRET");
    expect(factCalls(f)).toHaveLength(1);
  });

  it("shows Loading facts… (status) while the fetch is pending and ignores an answer that arrives after the list closed", async () => {
    const { f } = mount(uiOf());
    f.hold();
    const d = openFacts();
    expect(screen.getByText("Loading facts…").getAttribute("role")).toBe("status");
    closeFacts(d);
    await act(async () => {
      f.release();
    });
    await act(async () => {});
    expect(document.body.textContent).not.toContain("SECRET");
    expect(screen.queryByText("Loading facts…")).toBeNull();
    expect(screen.getByText("Fact 1")).toBeTruthy();
  });

  it("an answer that arrives after the channel changed is ignored, and the open list closes; so does an unmount", async () => {
    const { f, again, unmount } = mount(uiOf());
    f.hold();
    openFacts();
    again(uiOf({ channel: "chan-2" }));
    await act(async () => {
      f.release();
    });
    await act(async () => {});
    expect(document.body.textContent).not.toContain("SECRET");
    expect((screen.getByText("Hidden facts (2)").closest("details") as HTMLDetailsElement).open).toBe(false);
    // text shown, then the channel changes: dropped at once
    openFacts();
    await waitFor(() => expect(screen.getByText("Fact 1: SECRET one")).toBeTruthy());
    again(uiOf({ channel: "chan-3" }));
    expect(document.body.textContent).not.toContain("SECRET");
    // unmount while a fetch is pending: nothing is applied (no state update after unmount)
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    f.hold();
    openFacts();
    unmount();
    await act(async () => {
      f.release();
    });
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });

  it("opening a second list while one is open fetches nothing more, and the text stays until the last list closes", async () => {
    const f = fakeFetch(defaultAnswer);
    const loadFacts = vi.fn(async () => FACTS.roles);
    const chars = [
      { roleId: "a_one", goals: [], facts: [{ n: 1, released: false }] },
      { roleId: "b_two", goals: [], facts: [{ n: 1, released: false }] },
    ];
    const label: Labeler = { names: {}, ai: () => true };
    render(<CharactersPanel characters={chars} factsEarned={{}} label={label} disabled={false} onConfirm={() => {}} onStance={() => {}} loadFacts={loadFacts} />);
    void f;
    const [d1, d2] = screen.getAllByText(/Hidden facts/).map((s) => s.closest("details")!);
    act(() => { d1!.open = true; d1!.dispatchEvent(new Event("toggle")); });
    act(() => { d2!.open = true; d2!.dispatchEvent(new Event("toggle")); });
    expect(loadFacts).toHaveBeenCalledTimes(1);
  });

  it("stance sends set_npc_stance with the edited lines; 11 lines show an inline error and send nothing", async () => {
    const { f } = mount(uiOf());
    const box = screen.getByLabelText("Goals of Client sponsor, one per line") as HTMLTextAreaElement;
    expect(box.value).toBe("Protect the budget\nKeep the deadline");
    fireEvent.change(box, { target: { value: "  Protect the budget \n\nHold the line\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Set stance of Client sponsor" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Stance changed."));
    expect(f.calls[0]!.body).toEqual({ channel: "chan-1", kind: "set_npc_stance", roleId: "client_sponsor", goals: ["Protect the budget", "Hold the line"], expectSceneId: "s1" });

    const n = f.calls.length;
    fireEvent.change(box, { target: { value: Array.from({ length: 11 }, (_, i) => `g${i}`).join("\n") } });
    fireEvent.click(screen.getByRole("button", { name: "Set stance of Client sponsor" }));
    const err = screen.getByText("Enter 1 to 10 goals, one per line, each at most 500 characters.");
    expect(box.getAttribute("aria-describedby")).toBe(err.id);
    expect(f.calls).toHaveLength(n);
    // exactly 10 is allowed; an empty box and a 501-character line are not
    fireEvent.change(box, { target: { value: "x".repeat(501) } });
    fireEvent.click(screen.getByRole("button", { name: "Set stance of Client sponsor" }));
    expect(f.calls).toHaveLength(n);
    fireEvent.change(box, { target: { value: " \n " } });
    fireEvent.click(screen.getByRole("button", { name: "Set stance of Client sponsor" }));
    expect(f.calls).toHaveLength(n);
    fireEvent.change(box, { target: { value: Array.from({ length: 10 }, (_, i) => `g${i}`).join("\n") } });
    fireEvent.click(screen.getByRole("button", { name: "Set stance of Client sponsor" }));
    await waitFor(() => expect(f.calls).toHaveLength(n + 1));
  });

  it("a characters frame arriving during an edit keeps the edit", () => {
    const { again } = mount(uiOf());
    const box = screen.getByLabelText("Goals of Client sponsor, one per line") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "My half-typed goal" } });
    again(uiOf({ characters: [{ ...CHARS[0]!, goals: ["Changed by the server"] }] }));
    expect(box.value).toBe("My half-typed goal");
    expect(screen.getByText("Changed by the server")).toBeTruthy(); // the current goals list still updates
  });

  it("a frame arriving with no edit in progress shows the new goals in the box", () => {
    const { again } = mount(uiOf());
    again(uiOf({ characters: [{ ...CHARS[0]!, goals: ["Newer goal"] }] }));
    expect((screen.getByLabelText("Goals of Client sponsor, one per line") as HTMLTextAreaElement).value).toBe("Newer goal");
  });

  it("markup, U+202E and a tab in inject content, fact text, a goal, a name and whisper text render as literal text with no img, b or script element, names in bdi", async () => {
    const EVIL = "<img src=x onerror=alert(1)><b>bold</b><script>1</script>‮abc\tdef";
    const NAME = "<b>Eve</b>‮";
    const st = stateOf({ factsEarned: {} });
    const { container, f } = mount(
      uiOf(
        {
          scenes: [{ ...SCENES[0]!, injects: [{ id: "i1", to: ["account_manager"], content: EVIL }] }],
          characters: [{ roleId: "client_sponsor", goals: [EVIL], facts: [{ n: 1, released: false }] }],
          roster: [{ roleId: "account_manager", name: NAME, joined: true, consented: true, connected: true }],
        },
        st,
      ),
      (url) => (url.endsWith("/facts") ? { status: 200, body: ok({ roles: [{ roleId: "client_sponsor", facts: [{ n: 1, text: EVIL }] }] }) } : { status: 200, body: ok({}) }),
    );
    void f;
    openFacts();
    await waitFor(() => expect(container.textContent).toContain(`Fact 1: ${EVIL}`));
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: EVIL } });
    fireEvent.click(screen.getByRole("button", { name: "Send whisper" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.querySelector("p.preview")?.textContent).toBe(EVIL);
    for (const root of [container, dialog]) {
      expect(root.querySelector("img, script")).toBeNull();
      expect([...root.querySelectorAll("b")].filter((b) => !b.closest("bdi"))).toEqual([]);
    }
    expect(container.textContent).toContain(EVIL); // inject content as literal text
    const bdis = [...container.querySelectorAll("bdi")].map((b) => b.textContent);
    expect(bdis).toContain(NAME);
    expect(container.innerHTML).not.toContain("<img");
  });

  it("the buttons are really disabled when the console is not live, and aria-disabled (still focusable) while a command is pending", async () => {
    const { f, again } = mount(uiOf({ conn: "reconnecting" }));
    expect((screen.getByRole("button", { name: "Fire inject i1" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Send whisper" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Set stance of Client sponsor" }) as HTMLButtonElement).disabled).toBe(true);
    again(uiOf());
    f.hold();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    const fire = screen.getByRole("button", { name: "Fire inject i1" });
    await waitFor(() => expect(fire.getAttribute("aria-disabled")).toBe("true"));
    fireEvent.click(fire);
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => {
      f.release();
    });
  });
});
