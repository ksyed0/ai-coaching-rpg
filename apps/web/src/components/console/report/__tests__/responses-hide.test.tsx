// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReportResponse } from "../../../../lib/console-api";
import { REPORT_CONSOLE } from "../../../../lib/messages";
import { AmendDialog } from "../AmendDialog";
import { ResolveDisputePanel } from "../ResolveDisputePanel";
import { ResponsesPanel } from "../ResponsesPanel";
import { WithdrawDialog } from "../WithdrawDialog";

afterEach(cleanup);

const CANARY = "CANARY-secret-words-of-the-participant";
const responses: ReportResponse[] = [
  { seq: 12, role: "account_manager", text: "We start Monday.", criterion: "clarity", dispute: false },
  { seq: 15, role: "account_manager", text: "<b>bold</b> comment", dispute: true },
  { seq: 20, role: "account_manager", hidden: { reason: "Names a colleague", by: "kamal", at: Date.UTC(2026, 10, 17, 9, 30) }, criterion: "clarity", dispute: false },
];
const names = (id: string) => (id === "clarity" ? "Clarity" : id);
const mount = (over: Partial<Parameters<typeof ResponsesPanel>[0]> = {}) => {
  const onHide = vi.fn(async (): Promise<string | null> => null);
  render(<ResponsesPanel responses={responses} canWrite pending={false} criterionName={names} onHide={onHide} {...over} />);
  return onHide;
};

describe("ResponsesPanel", () => {
  it("lists every response with its criterion, text as text, and a numbered Hide button", () => {
    mount();
    expect(screen.getByText("We start Monday.")).toBeTruthy();
    expect(screen.getByText(/Response 12: About Clarity/)).toBeTruthy();
    expect(screen.getByText(/Response 15: About the whole report/)).toBeTruthy();
    expect(screen.getByText("<b>bold</b> comment")).toBeTruthy();
    expect(document.querySelector("b")).toBeNull();
    expect(screen.getByRole("button", { name: "Hide response 12" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hide response 15" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Hide response 20" })).toBeNull();
  });

  it("renders nothing without responses", () => {
    const { container } = render(<ResponsesPanel responses={[]} canWrite pending={false} criterionName={names} onHide={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows a hidden response in words with reason, who and when, and never its text", () => {
    const withText = [{ ...responses[2]!, text: CANARY } as ReportResponse];
    mount({ responses: withText });
    expect(document.body.textContent).not.toContain(CANARY);
    cleanup();
    mount();
    const row = screen.getAllByRole("listitem").find((li) => li.textContent?.includes("Hidden by facilitator"))!;
    expect(within(row).getByText("Hidden by facilitator")).toBeTruthy();
    expect(row.textContent).toContain("Names a colleague");
    expect(row.textContent).toContain("kamal");
    expect(row.querySelector("time")?.getAttribute("datetime")).toBe(new Date(Date.UTC(2026, 10, 17, 9, 30)).toISOString());
  });

  it("disables Hide with the cannot-write sentence when canWrite is false", () => {
    mount({ canWrite: false });
    expect((screen.getByRole("button", { name: "Hide response 12" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(REPORT_CONSOLE.nameNeeded)).toBeTruthy();
  });

  it("opens a dialog showing the response text, requires a reason, and confirms once", () => {
    const onHide = mount();
    fireEvent.click(screen.getByRole("button", { name: "Hide response 12" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("We start Monday.")).toBeTruthy();
    expect(dialog.textContent).toContain("cannot be undone");
    const hide = within(dialog).getByRole("button", { name: "Hide" }) as HTMLButtonElement;
    expect(hide.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "Names a colleague" } });
    expect(hide.disabled).toBe(false);
    fireEvent.click(hide);
    expect(onHide).toHaveBeenCalledTimes(1);
    expect(onHide).toHaveBeenCalledWith(12, "Names a colleague");
  });

  it("keeps the dialog and the typed reason on a refusal and shows the sentence", async () => {
    mount({ onHide: vi.fn(async () => "The report is busy. Try again in a moment.") });
    fireEvent.click(screen.getByRole("button", { name: "Hide response 12" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Typed reason" } });
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    await waitFor(() => expect(screen.getByText("The report is busy. Try again in a moment.")).toBeTruthy());
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Typed reason");
  });

  it("closes on success", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Hide response 12" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "r" } });
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("returns focus to the Hide button on cancel", () => {
    mount();
    const btn = screen.getByRole("button", { name: "Hide response 12" });
    btn.focus();
    fireEvent.click(btn);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(btn);
  });

  it("counts the reason live, 0 of 500, and cannot take 501 characters", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Hide response 12" }));
    const counter = screen.getByText("0 of 500");
    expect(counter.getAttribute("aria-live")).toBe("polite");
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(box.maxLength).toBe(500);
    fireEvent.change(box, { target: { value: "abc" } });
    expect(screen.getByText("3 of 500")).toBeTruthy();
  });
});

describe("the counter is only for dialogs that ask for it", () => {
  const base = { name: "kamal", pending: false, opener: null, error: "", onConfirm: () => {}, onCancel: () => {} };
  const subject = { id: "account_manager", audience: ["The facilitator"] };
  it("Amend and Withdraw render no counter and no maxLength", () => {
    render(<AmendDialog {...base} subject={subject} />);
    expect(screen.queryByText(/ of 500$/)).toBeNull();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).maxLength).toBe(-1);
    cleanup();
    render(<WithdrawDialog {...base} subject={subject} />);
    expect(screen.queryByText(/ of 500$/)).toBeNull();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).maxLength).toBe(-1);
  });
});

describe("open disputes", () => {
  it("leave out a hidden response", () => {
    const hidden = { seq: 9, role: "a", dispute: true, hidden: { reason: "r", by: "k", at: 1 } } as ReportResponse;
    const { container } = render(<ResolveDisputePanel responses={[hidden]} versions={[]} canWrite pending={false} criterionName={names} onResolve={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });
});
