// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeFetch, ok, refused } from "../../../../lib/__tests__/fakes";
import { REPORT_CONSOLE, REPORT_REFUSALS } from "../../../../lib/messages";
import { SummaryEditor } from "../SummaryEditor";
import { BASE, SID } from "./fixtures";

afterEach(cleanup);

const URL_ = `${BASE}/subjects/account_manager/edit-summary`;
type Summary = { strengths: string[]; developments: string[]; actions: { lo: string; text: string }[] };
const CURRENT: Summary = { strengths: ["Clear plan", "Kept calm"], developments: ["Ask about budget"], actions: [{ lo: "LO-1", text: "Name the next step: today" }] };

function mount(o: { summary?: Summary; author?: string | null; editable?: boolean; answer?: () => { status: number; body: unknown } } = {}) {
  const f = fakeFetch(o.answer ?? (() => ({ status: 200, body: ok({}) })));
  const onChanged = vi.fn();
  render(
    <SummaryEditor
      sessionId={SID} subject="account_manager" author={o.author === undefined ? "kamal" : o.author} summary={o.summary ?? CURRENT}
      editable={o.editable ?? true} fetch={f.fetch} onChanged={onChanged}
    />,
  );
  return { f, onChanged };
}
const open = () => fireEvent.click(screen.getByRole("button", { name: REPORT_CONSOLE.summaryEdit }));
const box = (label: string) => screen.getByLabelText(label) as HTMLTextAreaElement;
const type = (label: string, value: string) => fireEvent.change(box(label), { target: { value } });
const save = () => screen.getByRole("button", { name: "Save the summary" }) as HTMLButtonElement;
const alertText = () => screen.getByRole("alert").textContent;

describe("SummaryEditor", () => {
  it("SummaryEditor is not rendered when the subject is not editable", () => {
    const { container } = render(<SummaryEditor sessionId={SID} subject="account_manager" author="kamal" summary={CURRENT} editable={false} />);
    expect(container.innerHTML).toBe("");
    expect(screen.queryByRole("button", { name: REPORT_CONSOLE.summaryEdit })).toBeNull();
  });

  it("all three boxes are pre-filled from the current summary", () => {
    mount();
    open();
    expect(box(REPORT_CONSOLE.strengthsLabel).value).toBe("Clear plan\nKept calm");
    expect(box(REPORT_CONSOLE.developmentsLabel).value).toBe("Ask about budget");
    expect(box(REPORT_CONSOLE.actionsLabel).value).toBe("LO-1: Name the next step: today");
    expect(box(REPORT_CONSOLE.summaryReasonLabel).value).toBe("");
  });

  it("saving with only a new reason re-posts the existing entries unchanged", async () => {
    const { f, onChanged } = mount();
    open();
    type(REPORT_CONSOLE.summaryReasonLabel, "Reworded nothing.");
    fireEvent.click(save());
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe(URL_);
    expect(f.calls[0]!.body).toEqual({ reason: "Reworded nothing.", ...CURRENT, by: "kamal" });
  });

  it("Save is disabled without a valid author name and without a reason", () => {
    // without a name the opener itself is disabled (as CriterionRow's Edit), so nothing can be saved
    mount({ author: null });
    expect((screen.getByRole("button", { name: REPORT_CONSOLE.summaryEdit }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Save the summary" })).toBeNull();
    cleanup();
    mount();
    open();
    expect(save().disabled).toBe(true);
    type(REPORT_CONSOLE.summaryReasonLabel, "   ");
    expect(save().disabled).toBe(true);
    type(REPORT_CONSOLE.summaryReasonLabel, "A reason.");
    expect(save().disabled).toBe(false);
  });

  it('one entry per line: blank lines dropped; an actions line "LO-1: Do the thing: now" posts {lo: "LO-1", text: "Do the thing: now"} (split on the first colon)', async () => {
    const { f } = mount();
    open();
    type(REPORT_CONSOLE.strengthsLabel, "First\n\n   \nSecond\n");
    type(REPORT_CONSOLE.developmentsLabel, "");
    type(REPORT_CONSOLE.actionsLabel, "\nLO-1: Do the thing: now\n\nLO-2:Then this\n");
    type(REPORT_CONSOLE.summaryReasonLabel, "Rewrote it.");
    fireEvent.click(save());
    await waitFor(() => expect(f.calls).toHaveLength(1));
    expect(f.calls[0]!.body).toEqual({
      reason: "Rewrote it.", strengths: ["First", "Second"], developments: [],
      actions: [{ lo: "LO-1", text: "Do the thing: now" }, { lo: "LO-2", text: "Then this" }], by: "kamal",
    });
  });

  it("an actions line with no LO-ID: prefix is refused before sending with a fixed sentence", () => {
    for (const line of ["Do the thing", ": no id", "LO-1:", "LO-1:    "]) {
      const { f } = mount();
      open();
      type(REPORT_CONSOLE.actionsLabel, `LO-1: Fine\n${line}`);
      type(REPORT_CONSOLE.summaryReasonLabel, "Why.");
      fireEvent.click(save());
      expect(alertText()).toBe(REPORT_CONSOLE.summaryActionLine);
      expect(f.calls).toHaveLength(0);
      expect(box(REPORT_CONSOLE.actionsLabel).value).toBe(`LO-1: Fine\n${line}`);
      cleanup();
    }
  });

  it("all lists empty is refused before sending with a fixed sentence", () => {
    const { f, onChanged } = mount();
    open();
    type(REPORT_CONSOLE.strengthsLabel, "\n  \n");
    type(REPORT_CONSOLE.developmentsLabel, "");
    type(REPORT_CONSOLE.actionsLabel, "");
    type(REPORT_CONSOLE.summaryReasonLabel, "Clearing it.");
    fireEvent.click(save());
    expect(alertText()).toBe(REPORT_CONSOLE.summaryEmpty);
    expect(f.calls).toHaveLength(0);
    expect(onChanged).not.toHaveBeenCalled();
    expect(box(REPORT_CONSOLE.summaryReasonLabel).value).toBe("Clearing it.");
  });

  it("more than 50 items in a list, an item over 400 characters, or a JSON body over 16 KB (UTF-8 bytes via TextEncoder) is refused before sending", () => {
    const cases: [string, string, string][] = [
      [REPORT_CONSOLE.developmentsLabel, Array.from({ length: 51 }, (_, i) => `Point ${i}`).join("\n"), REPORT_CONSOLE.summaryTooMany],
      [REPORT_CONSOLE.actionsLabel, Array.from({ length: 51 }, (_, i) => `LO-1: Act ${i}`).join("\n"), REPORT_CONSOLE.summaryTooMany],
      [REPORT_CONSOLE.strengthsLabel, "x".repeat(401), REPORT_CONSOLE.summaryTooLong],
      [REPORT_CONSOLE.actionsLabel, `LO-1: ${"y".repeat(401)}`, REPORT_CONSOLE.summaryTooLong],
      // 46 entries of 120 three-byte characters: under 50 items and 400 characters each, but about 16.6 KB as UTF-8 (only ~5.5 K UTF-16 units)
      [REPORT_CONSOLE.strengthsLabel, Array.from({ length: 46 }, () => "€".repeat(120)).join("\n"), REPORT_CONSOLE.summaryTooLarge],
    ];
    for (const [label, value, sentence] of cases) {
      const { f } = mount();
      open();
      type(label, value);
      type(REPORT_CONSOLE.summaryReasonLabel, "Why.");
      fireEvent.click(save());
      expect(alertText()).toBe(sentence);
      expect(f.calls).toHaveLength(0);
      expect(box(label).value).toBe(value);
      cleanup();
    }
    // 400 characters exactly (counted as characters, so an emoji is one) is allowed
    const { f } = mount();
    open();
    type(REPORT_CONSOLE.strengthsLabel, "😀".repeat(400));
    type(REPORT_CONSOLE.summaryReasonLabel, "Why.");
    fireEvent.click(save());
    expect(f.calls).toHaveLength(1);
  });

  it("a server refusal keeps what was typed and shows one fixed sentence", async () => {
    const { f, onChanged } = mount({ answer: () => ({ status: 400, body: refused("invalid", "--action needs the id of LO-9 <b>x</b>") }) });
    open();
    type(REPORT_CONSOLE.actionsLabel, "LO-9: Unknown objective");
    type(REPORT_CONSOLE.summaryReasonLabel, "Why.");
    fireEvent.click(save());
    await waitFor(() => expect(alertText()).toBe(REPORT_REFUSALS.invalid));
    expect(f.calls).toHaveLength(1);
    expect(screen.queryByText(/--action needs/)).toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
    expect(box(REPORT_CONSOLE.actionsLabel).value).toBe("LO-9: Unknown objective");
    expect(box(REPORT_CONSOLE.strengthsLabel).value).toBe("Clear plan\nKept calm");
    expect(box(REPORT_CONSOLE.summaryReasonLabel).value).toBe("Why.");
  });

  it("every string renders as text", () => {
    const evil = '<img src=x onerror="alert(1)">';
    mount({ summary: { strengths: [evil], developments: [], actions: [{ lo: "LO-1", text: evil }] } });
    open();
    expect(box(REPORT_CONSOLE.strengthsLabel).value).toBe(evil);
    expect(box(REPORT_CONSOLE.actionsLabel).value).toBe(`LO-1: ${evil}`);
    expect(document.querySelector("img")).toBeNull();
  });

  it("labels and the error line have accessible names and are keyboard reachable", () => {
    mount();
    const opener = screen.getByRole("button", { name: REPORT_CONSOLE.summaryEdit });
    opener.focus();
    expect(document.activeElement).toBe(opener);
    open();
    for (const label of [REPORT_CONSOLE.strengthsLabel, REPORT_CONSOLE.developmentsLabel, REPORT_CONSOLE.actionsLabel, REPORT_CONSOLE.summaryReasonLabel]) {
      const el = screen.getByRole("textbox", { name: label });
      expect(el.tabIndex).toBeGreaterThanOrEqual(0);
      el.focus();
      expect(document.activeElement).toBe(el);
    }
    type(REPORT_CONSOLE.summaryReasonLabel, "Why.");
    for (const name of ["Save the summary", "Cancel"]) {
      const b = screen.getByRole("button", { name });
      expect(b.tagName).toBe("BUTTON");
      b.focus();
      expect(document.activeElement).toBe(b);
    }
    type(REPORT_CONSOLE.strengthsLabel, "");
    type(REPORT_CONSOLE.developmentsLabel, "");
    type(REPORT_CONSOLE.actionsLabel, "");
    fireEvent.click(save());
    expect(screen.getByRole("alert").textContent).toBe(REPORT_CONSOLE.summaryEmpty);
    // Cancel closes the form and nothing is sent
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("textbox", { name: REPORT_CONSOLE.strengthsLabel })).toBeNull();
  });
  it("an entry with a line break in any list makes the editor unavailable, with a fixed sentence and no Save", () => {
    const withBreak: Summary[] = [
      { ...CURRENT, strengths: ["Clear plan", "Two\nlines"] },
      { ...CURRENT, developments: ["Ask\nabout budget"] },
      { ...CURRENT, actions: [{ lo: "LO-1", text: "Do it\nNote: later" }] },
    ];
    for (const summary of withBreak) {
      const { f } = mount({ summary });
      expect(screen.getByText(REPORT_CONSOLE.summaryMultiline)).toBeTruthy();
      expect(screen.queryByRole("button", { name: REPORT_CONSOLE.summaryEdit })).toBeNull();
      expect(screen.queryByRole("button", { name: "Save the summary" })).toBeNull();
      expect(screen.queryByRole("textbox")).toBeNull();
      expect(f.calls).toHaveLength(0);
      cleanup();
    }
    // entries without a line break still open the editor
    mount();
    open();
    expect(box(REPORT_CONSOLE.strengthsLabel).value).toBe("Clear plan\nKept calm");
  });

  it("while a save is pending every box is disabled, so nothing typed after Save is lost", async () => {
    const { f, onChanged } = mount();
    f.hold();
    open();
    type(REPORT_CONSOLE.summaryReasonLabel, "Why.");
    fireEvent.click(save());
    await waitFor(() => expect(f.calls).toHaveLength(1));
    for (const label of [REPORT_CONSOLE.strengthsLabel, REPORT_CONSOLE.developmentsLabel, REPORT_CONSOLE.actionsLabel, REPORT_CONSOLE.summaryReasonLabel]) {
      expect(box(label).disabled).toBe(true);
    }
    expect(save().disabled).toBe(true);
    f.release();
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("a reason of 500 characters is sent and one of 501 is refused before sending", () => {
    const { f } = mount();
    open();
    type(REPORT_CONSOLE.summaryReasonLabel, "r".repeat(501));
    fireEvent.click(save());
    expect(alertText()).toBe(REPORT_CONSOLE.summaryReasonTooLong);
    expect(f.calls).toHaveLength(0);
    expect(box(REPORT_CONSOLE.summaryReasonLabel).value).toBe("r".repeat(501));
    type(REPORT_CONSOLE.summaryReasonLabel, "😀".repeat(500));
    fireEvent.click(save());
    expect(f.calls).toHaveLength(1);
  });

  it("exactly 50 entries in a list are sent", () => {
    const { f } = mount();
    open();
    type(REPORT_CONSOLE.developmentsLabel, Array.from({ length: 50 }, (_, i) => `Point ${i}`).join("\n"));
    type(REPORT_CONSOLE.actionsLabel, Array.from({ length: 50 }, (_, i) => `LO-1: Act ${i}`).join("\n"));
    type(REPORT_CONSOLE.summaryReasonLabel, "Why.");
    fireEvent.click(save());
    expect(f.calls).toHaveLength(1);
    expect((f.calls[0]!.body as Summary).developments).toHaveLength(50);
    expect((f.calls[0]!.body as Summary).actions).toHaveLength(50);
  });

  it("a body of exactly 16384 UTF-8 bytes is sent and one of 16385 is refused", () => {
    const bytes = (strengths: string[]) =>
      new TextEncoder().encode(JSON.stringify({ reason: "Why.", strengths, developments: [], actions: [], by: "kamal" })).length;
    const full = Array.from({ length: 41 }, () => "€".repeat(130));
    const pad = 16384 - bytes([...full, ""]);
    expect(pad).toBeGreaterThan(0);
    expect(pad).toBeLessThanOrEqual(400);
    const exact = [...full, "a".repeat(pad)];
    expect(bytes(exact)).toBe(16384);
    for (const [strengths, sent] of [[exact, true], [[...full, "a".repeat(pad + 1)], false]] as const) {
      const { f } = mount();
      open();
      type(REPORT_CONSOLE.strengthsLabel, strengths.join("\n"));
      type(REPORT_CONSOLE.developmentsLabel, "");
      type(REPORT_CONSOLE.actionsLabel, "");
      type(REPORT_CONSOLE.summaryReasonLabel, "Why.");
      fireEvent.click(save());
      if (sent) {
        expect(f.calls).toHaveLength(1);
        expect(new TextEncoder().encode(String(f.calls[0]!.init.body)).length).toBe(16384);
      } else {
        expect(alertText()).toBe(REPORT_CONSOLE.summaryTooLarge);
        expect(f.calls).toHaveLength(0);
      }
      cleanup();
    }
  });
});
