// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceChoice, type VoiceChoiceProps } from "../VoiceChoice";
import { MESSAGES } from "../../lib/messages";
import type { ActionResult } from "../../lib/api";

// US-0071 (A1b Task 14): the participant's voice choice. Native radios in a fieldset with a legend, a native Save button, the state in
// words with an aria-hidden icon; the voice radio is disabled with the reason when the web server has no LiveKit or the page is not a
// secure context. jsdom has no keyboard model for radio groups (Tab, arrows): the keyboard test pins the native semantics that give it
// in a browser, and batch 6b's Playwright run presses the keys for real.

afterEach(cleanup);

const props = (over: Partial<VoiceChoiceProps> = {}): VoiceChoiceProps => ({
  state: "none", voiceTransport: true, secure: true, onChoose: vi.fn(async (): Promise<ActionResult> => ({ ok: true })), ...over,
});
const radio = (name: string) => screen.getByRole("radio", { name }) as HTMLInputElement;

describe("VoiceChoice", () => {
  it("the radios are in a fieldset whose legend is the title", () => {
    render(<VoiceChoice {...props()} />);
    const group = screen.getByRole("group", { name: MESSAGES.voiceChoiceTitle });
    expect(group.tagName).toBe("FIELDSET");
    expect(group.querySelector("legend")!.textContent).toBe(MESSAGES.voiceChoiceTitle);
    expect(within(group).getAllByRole("radio").map((r) => r.getAttribute("aria-label") ?? r.closest("label")!.textContent)).toEqual([MESSAGES.voiceWith, MESSAGES.voiceText]);
  });

  it("the state is in words, the icon is aria-hidden", () => {
    for (const [state, words] of [["none", MESSAGES.voiceStateNone], ["voice", MESSAGES.voiceStateOn], ["text_only", MESSAGES.voiceStateText]] as const) {
      const r = render(<VoiceChoice {...props({ state })} />);
      const p = screen.getByText(words, { exact: false });
      expect(p.textContent!.replace(p.querySelector("[aria-hidden='true']")?.textContent ?? "\u0000", "")).toBe(words);
      expect(p.querySelector("[aria-hidden='true']")).not.toBeNull();
      expect(p.closest("[aria-live], [role='status'], [role='alert']")).toBeNull();
      r.unmount();
    }
  });

  it("the saved state is the checked radio; Save is disabled until a choice is made", () => {
    const r = render(<VoiceChoice {...props({ state: "none" })} />);
    expect(radio(MESSAGES.voiceWith).checked).toBe(false);
    expect(radio(MESSAGES.voiceText).checked).toBe(false);
    expect((screen.getByRole("button", { name: MESSAGES.voiceSave }) as HTMLButtonElement).disabled).toBe(true);
    r.unmount();
    render(<VoiceChoice {...props({ state: "text_only" })} />);
    expect(radio(MESSAGES.voiceText).checked).toBe(true);
  });

  it("voiceTransport false disables the voice option with the not-available sentence", () => {
    render(<VoiceChoice {...props({ voiceTransport: false })} />);
    const v = radio(MESSAGES.voiceWith);
    expect(v.disabled).toBe(true);
    const why = screen.getByText(MESSAGES.voiceNoTransport);
    expect(v.getAttribute("aria-describedby")).toBe(why.id);
    expect(radio(MESSAGES.voiceText).disabled).toBe(false);
  });

  it("insecure context shows the secure-connection sentence; the voice radio is disabled and described by it", () => {
    render(<VoiceChoice {...props({ secure: false })} />);
    const v = radio(MESSAGES.voiceWith);
    expect(v.disabled).toBe(true);
    const why = screen.getByText(MESSAGES.voiceInsecure);
    expect(why.id).not.toBe("");
    expect(v.getAttribute("aria-describedby")).toBe(why.id);
    expect(screen.queryByText(MESSAGES.voiceNoTransport)).toBeNull();
  });

  it("a usable voice option has no description and is enabled", () => {
    render(<VoiceChoice {...props()} />);
    expect(radio(MESSAGES.voiceWith).disabled).toBe(false);
    expect(radio(MESSAGES.voiceWith).hasAttribute("aria-describedby")).toBe(false);
  });

  it("keyboard: the two radios are one native group (one name, no tabindex), so Tab enters it once and arrows move; Save is a native button; Enter submits the form", async () => {
    const onChoose = vi.fn(async (): Promise<ActionResult> => ({ ok: true }));
    const { container } = render(<VoiceChoice {...props({ onChoose })} />);
    const radios = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(radios.every((r) => r.type === "radio" && r.tagName === "INPUT")).toBe(true);
    expect(new Set(radios.map((r) => r.name)).size).toBe(1);
    expect(radios[0]!.name).not.toBe("");
    expect(container.querySelectorAll("[tabindex]")).toHaveLength(0);
    const save = screen.getByRole("button", { name: MESSAGES.voiceSave }) as HTMLButtonElement;
    expect(save.tagName).toBe("BUTTON");
    expect(save.type).toBe("submit");
    expect(save.form).toBe(radios[0]!.form);
    // An arrow key in a browser checks the next radio and fires change: the same as a click on it here.
    fireEvent.click(radios[1]!);
    expect(radios[1]!.checked).toBe(true);
    expect(save.disabled).toBe(false);
    // Enter in a radio (implicit submission) or Enter/Space on the focused button both submit the form.
    await act(async () => { fireEvent.submit(save.form!); });
    expect(onChoose).toHaveBeenCalledWith("text_only");
    fireEvent.click(radios[0]!);
    await act(async () => { fireEvent.click(save); });
    expect(onChoose).toHaveBeenLastCalledWith("voice");
  });

  it("voice_notice_required shows its sentence and the state stays text only", async () => {
    const onChoose = vi.fn(async (): Promise<ActionResult> => ({ ok: false, message: MESSAGES.voiceNoticeRequired }));
    render(<VoiceChoice {...props({ state: "text_only", onChoose })} />);
    fireEvent.click(radio(MESSAGES.voiceWith));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: MESSAGES.voiceSave })); });
    expect(screen.getByRole("alert").textContent).toBe(MESSAGES.voiceNoticeRequired);
    expect(screen.getByText(MESSAGES.voiceStateText, { exact: false })).toBeTruthy();
    // The selection goes back to what is saved: nothing on the page says voice is on.
    expect(radio(MESSAGES.voiceText).checked).toBe(true);
    expect(screen.queryByText(MESSAGES.voiceStateOn, { exact: false })).toBeNull();
  });

  it("a double submit sends one choice; the Save button keeps the focus while it is pending", async () => {
    let release: () => void = () => {};
    const onChoose = vi.fn(() => new Promise<ActionResult>((r) => { release = () => r({ ok: true }); }));
    render(<VoiceChoice {...props({ onChoose })} />);
    fireEvent.click(radio(MESSAGES.voiceText));
    const save = screen.getByRole("button", { name: MESSAGES.voiceSave }) as HTMLButtonElement;
    save.focus();
    await act(async () => { fireEvent.submit(save.form!); fireEvent.submit(save.form!); });
    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(save.disabled).toBe(false);
    expect(save.getAttribute("aria-busy")).toBe("true");
    expect(document.activeElement).toBe(save);
    await act(async () => { release(); });
    expect(save.getAttribute("aria-busy")).toBeNull();
  });
});
