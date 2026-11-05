// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { initialState, type SessionState } from "@acr/events";
import { afterEach, describe, expect, it } from "vitest";
import { ConsoleControls } from "../console/ConsoleControls";
import { fakeFetch, refused } from "../../lib/__tests__/fakes";
import type { ConsoleStreamUi } from "../../lib/use-console-stream";

afterEach(cleanup);

const SID = "abcd1234efgh5678";
const SCENES = [
  { id: "s1", title: "Kick-off", goal: "Agree the agenda.", timeBoxMinutes: 5, injects: [] },
  { id: "s2", title: "Client call", goal: "Agree the module.", timeBoxMinutes: 10, injects: [] },
];

function stateOf(over: Partial<SessionState> = {}, sceneId: string | null = "s1"): SessionState {
  return {
    ...initialState(),
    status: "running",
    currentScene: sceneId ? { id: sceneId, enteredAt: 1, participants: [], pausedMs: 0 } : null,
    ...over,
  };
}
function uiOf(over: Partial<ConsoleStreamUi> = {}, st: SessionState = stateOf()): ConsoleStreamUi {
  return {
    conn: "live",
    final: null,
    channel: "chan-1",
    scenes: SCENES,
    characters: [],
    view: { state: st, timeline: [], gap: false },
    roster: [],
    notice: null,
    ...over,
  };
}
function mount(ui: ConsoleStreamUi, answer?: Parameters<typeof fakeFetch>[0]) {
  const f = fakeFetch(answer);
  const r = render(<ConsoleControls sessionId={SID} ui={ui} fetch={f.fetch} />);
  const again = (next: ConsoleStreamUi) => r.rerender(<ConsoleControls sessionId={SID} ui={next} fetch={f.fetch} />);
  return { f, again };
}
const STALE = "The scene changed. Review the live view and try again.";

describe("SessionControls", () => {
  it("Pause sends pause without a dialog and announces Paused.", async () => {
    const { f } = mount(uiOf());
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Paused."));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe(`/api/v1/console/sessions/${SID}/command`);
    expect(f.calls[0]!.body).toEqual({ channel: "chan-1", kind: "pause" });
  });

  it("the same button reads Resume when paused and keeps focus after it is pressed", async () => {
    const { f, again } = mount(uiOf({}, stateOf({ paused: true })));
    const btn = screen.getByRole("button", { name: "Resume" });
    btn.focus();
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Resumed."));
    expect(f.calls[0]!.body).toEqual({ channel: "chan-1", kind: "resume" });
    expect(document.activeElement).toBe(btn);
    again(uiOf({}, stateOf({ paused: false })));
    const after = screen.getByRole("button", { name: "Pause" });
    expect(after).toBe(btn);
    expect(document.activeElement).toBe(btn);
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  });

  it("Move on opens the dialog with the scene title and sends advance with the scene id captured when it opened, even if the scene changed before confirming", async () => {
    const { f, again } = mount(uiOf());
    fireEvent.click(screen.getByRole("button", { name: "Move on" }));
    const dialog = screen.getByRole("dialog", { name: "Move on from “Kick-off”?" });
    expect(f.calls).toHaveLength(0);
    again(uiOf({}, stateOf({}, "s2"))); // the scene changes while the dialog is open
    fireEvent.click(within(dialog).getByRole("button", { name: "Move on" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Moving on to the next scene."));
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.body).toEqual({ channel: "chan-1", kind: "advance", expectSceneId: "s1" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it('a stale answer closes the dialog, returns focus to Move on and shows "The scene changed. Review the live view and try again." in the alert', async () => {
    mount(uiOf(), () => ({ status: 409, body: refused("stale_scene", STALE) }));
    const opener = screen.getByRole("button", { name: "Move on" });
    fireEvent.click(opener); // not focused first: focus must return to the opener that was passed, not to whatever had it
    const dialog = screen.getByRole("dialog");
    expect(document.activeElement).not.toBe(opener);
    fireEvent.click(within(dialog).getByRole("button", { name: "Move on" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(STALE));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("End session sends end_now with the trimmed message, or none when empty, and announces nothing itself", async () => {
    const first = mount(uiOf());
    fireEvent.click(screen.getByRole("button", { name: "End session" }));
    const dialog = screen.getByRole("dialog", { name: "End the session now?" });
    const field = within(dialog).getByLabelText("Closing message to participants (optional)") as HTMLTextAreaElement;
    expect(field.tagName).toBe("TEXTAREA");
    expect(field.maxLength).toBe(300);
    const hint = document.getElementById(field.getAttribute("aria-describedby") ?? "none");
    expect(hint?.textContent).toBe("Shown to participants who are connected at the end. At most 300 characters.");
    fireEvent.change(field, { target: { value: "  Thanks, all.  " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "End session" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(first.f.calls[0]!.body).toEqual({ channel: "chan-1", kind: "end_now", message: "Thanks, all." });
    expect(screen.getByRole("status").textContent).toBe("");
    expect(screen.getByRole("alert").textContent).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "End session" }));
    const again = screen.getByRole("dialog");
    expect((within(again).getByLabelText("Closing message to participants (optional)") as HTMLTextAreaElement).value).toBe("");
    fireEvent.change(within(again).getByLabelText("Closing message to participants (optional)"), { target: { value: "   " } });
    fireEvent.click(within(again).getByRole("button", { name: "End session" }));
    await waitFor(() => expect(first.f.calls).toHaveLength(2));
    expect(first.f.calls[1]!.body).toEqual({ channel: "chan-1", kind: "end_now" });
  });

  it("a double click on Pause sends one command", async () => {
    const { f } = mount(uiOf());
    f.hold();
    const btn = screen.getByRole("button", { name: "Pause" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    f.release();
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Paused."));
    expect(f.calls).toHaveLength(1);
  });

  it("controls are disabled while reconnecting and once ended, and aria-disabled (ignoring activation) while a command is pending", async () => {
    const live = mount(uiOf({ conn: "reconnecting" }));
    for (const name of ["Pause", "Move on", "End session"]) expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    live.again(uiOf({}, stateOf({ status: "ended" }, null)));
    for (const name of ["Pause", "Move on", "End session"]) expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    const { f } = mount(uiOf());
    f.hold();
    const pause = screen.getByRole("button", { name: "Pause" });
    pause.focus();
    fireEvent.click(pause);
    await waitFor(() => expect(pause.getAttribute("aria-disabled")).toBe("true"));
    for (const name of ["Pause", "Move on", "End session"]) {
      const b = screen.getByRole("button", { name });
      expect(b.getAttribute("aria-disabled")).toBe("true");
      expect((b as HTMLButtonElement).disabled).toBe(false);
    }
    fireEvent.click(screen.getByRole("button", { name: "End session" }));
    fireEvent.click(screen.getByRole("button", { name: "Move on" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(pause);
    f.release();
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Paused."));
    expect(f.calls).toHaveLength(1);
    expect(pause.getAttribute("aria-disabled")).toBeNull();
  });

  it("Move on keeps rendering as Moving on… and aria-disabled once the advance was requested", () => {
    mount(uiOf({}, stateOf({ advanceRequested: true })));
    const b = screen.getByRole("button", { name: "Moving on…" });
    expect(b.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(b);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Move on without a current scene reads Move on and is aria-disabled; Moving on… only once advance was requested", () => {
    mount(uiOf({}, stateOf({}, null)));
    const b = screen.getByRole("button", { name: "Move on" });
    expect(b.getAttribute("aria-disabled")).toBe("true");
    expect((b as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(b);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Moving on…" })).toBeNull();
  });

  it("the advance and end_now confirmations use the danger button", () => {
    mount(uiOf());
    fireEvent.click(screen.getByRole("button", { name: "Move on" }));
    let d = screen.getByRole("dialog");
    expect(within(d).getByRole("button", { name: "Move on" }).className).toContain("danger");
    fireEvent.keyDown(d, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "End session" }));
    d = screen.getByRole("dialog");
    expect(within(d).getByRole("button", { name: "End session" }).className).toContain("danger");
  });

  it("the alert and the status are written only after the dialog has lifted inert from the page", async () => {
    const stale = mount(uiOf(), () => ({ status: 409, body: refused("stale_scene", STALE) }));
    const log: string[] = [];
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "attributes" && r.attributeName === "inert" && !(r.target as Element).hasAttribute("inert")) log.push("inert-removed");
        if (r.type === "childList" && r.addedNodes.length > 0 && (r.target as Element).closest('[role="alert"], [role="status"]')) log.push(`text:${(r.target as Element).closest("[role]")?.getAttribute("role")}`);
      }
    });
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["inert"] });
    fireEvent.click(screen.getByRole("button", { name: "Move on" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Move on" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(STALE));
    await new Promise((r) => setTimeout(r, 0));
    expect(log.indexOf("inert-removed")).toBeGreaterThanOrEqual(0);
    expect(log.indexOf("text:alert")).toBeGreaterThan(log.indexOf("inert-removed"));
    mo.disconnect();
    void stale;
    cleanup();

    // The same for a success status.
    mount(uiOf());
    const log2: string[] = [];
    const mo2 = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "attributes" && r.attributeName === "inert" && !(r.target as Element).hasAttribute("inert")) log2.push("inert-removed");
        if (r.type === "childList" && r.addedNodes.length > 0 && (r.target as Element).closest('[role="status"]')) log2.push("text:status");
      }
    });
    mo2.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["inert"] });
    fireEvent.click(screen.getByRole("button", { name: "Move on" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Move on" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Moving on to the next scene."));
    await new Promise((r) => setTimeout(r, 0));
    expect(log2.indexOf("text:status")).toBeGreaterThan(log2.indexOf("inert-removed"));
    mo2.disconnect();
  });

  it("Escape closes the dialog and focus returns to its opener", () => {
    const { f } = mount(uiOf());
    const opener = screen.getByRole("button", { name: "End session" });
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(f.calls).toHaveLength(0);
  });
});
