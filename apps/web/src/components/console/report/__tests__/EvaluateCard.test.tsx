// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseReportOverview } from "../../../../lib/console-api";
import { EvaluateCard } from "../EvaluateCard";
import { EvaluateConfirmDialog } from "../EvaluateConfirmDialog";
import { job, overview } from "./fixtures";

afterEach(cleanup);

const ORPHAN = "A report folder for this session is damaged. See the rollback notes to remove it, then evaluate again.";

function card(o: Record<string, unknown>, canWrite = true) {
  const parsed = parseReportOverview(o);
  if (parsed === null) throw new Error("fixture did not parse");
  const on = { onEvaluate: vi.fn(), onCancel: vi.fn(), onOpen: vi.fn() };
  render(<EvaluateCard overview={parsed} canWrite={canWrite} pending={false} {...on} />);
  return on;
}

describe("EvaluateCard", () => {
  it("EvaluateCard shows not_ended, ready, running (progress lines, Cancel), failed (a fixed sentence per reason), ready_to_open (Open button), orphan (fixed sentence naming the ROLLBACK step) and done", () => {
    card(overview({ stage: "not_ended", confirm: null }));
    expect(screen.getByText("The session has not ended yet. Evaluate it after it ends.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    cleanup();

    const ready = card(overview());
    fireEvent.click(screen.getByRole("button", { name: "Evaluate…" }));
    expect(ready.onEvaluate).toHaveBeenCalledTimes(1);
    cleanup();

    // without a valid typed name, no write is enabled
    card(overview(), false);
    expect((screen.getByRole("button", { name: "Evaluate…" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    const running = card(overview({ stage: "evaluating", confirm: null, job: job({ state: "running", startedAt: 1, progress: ["evaluating account_manager", "evaluating the team"] }) }));
    expect(screen.getByText("evaluating account_manager")).toBeTruthy();
    expect(screen.getByText("evaluating the team")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Evaluate…" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel evaluation" }));
    expect(running.onCancel).toHaveBeenCalledTimes(1);
    cleanup();

    const reasons: [string | undefined, string][] = [
      ["interrupted", "The evaluation stopped because the control service restarted. Evaluate again."],
      ["timeout", "The evaluation took too long and was stopped. Evaluate again."],
      ["cancelled", "The evaluation was cancelled. Money already spent on model calls is not refunded."],
      ["error", "The evaluation failed. Evaluate again."],
      [undefined, "The evaluation failed. Evaluate again."],
    ];
    for (const [reason, sentence] of reasons) {
      card(overview({ stage: "failed", job: job({ state: "failed", ...(reason ? { reason } : {}) }) }));
      expect(screen.getByText(sentence)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Evaluate…" })).toBeTruthy();
      cleanup();
    }

    const toOpen = card(overview({ stage: "ready_to_open", confirm: null, job: job({ state: "done", modelCalls: 6 }) }));
    fireEvent.click(screen.getByRole("button", { name: "Open the review" }));
    expect(toOpen.onOpen).toHaveBeenCalledTimes(1);
    cleanup();

    card(overview({ stage: "not_evaluated", confirm: null, orphan: true }));
    expect(screen.getByText(ORPHAN)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Evaluate…" })).toBeNull();
    cleanup();

    card(overview({ stage: "in_review", confirm: null, job: job({ state: "done", modelCalls: 6 }) }));
    expect(screen.getByText("The reports are drafted and the review is open. The evaluation made 6 model calls.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("while evaluating, the polite progress list is in the page before its first line, so that line is announced", () => {
    const { rerender } = render(<EvaluateCard overview={parseReportOverview(overview({ stage: "evaluating", confirm: null, job: job({ state: "running", startedAt: 1 }) }))!} canWrite pending={false} onEvaluate={vi.fn()} onCancel={vi.fn()} onOpen={vi.fn()} />);
    const list = screen.getByRole("list", { name: "Evaluation progress" });
    expect(list.getAttribute("aria-live")).toBe("polite");
    expect(list.getAttribute("aria-relevant")).toBe("additions");
    expect(list.children).toHaveLength(0);
    rerender(<EvaluateCard overview={parseReportOverview(overview({ stage: "evaluating", confirm: null, job: job({ state: "running", startedAt: 1, progress: ["evaluating the team"] }) }))!} canWrite pending={false} onEvaluate={vi.fn()} onCancel={vi.fn()} onOpen={vi.fn()} />);
    // the same element, now with its first line
    expect(screen.getByRole("list", { name: "Evaluation progress" })).toBe(list);
    expect(list.textContent).toBe("evaluating the team");
    cleanup();
    render(<EvaluateCard overview={parseReportOverview(overview())!} canWrite pending={false} onEvaluate={vi.fn()} onCancel={vi.fn()} onOpen={vi.fn()} />);
    expect(screen.queryByRole("list", { name: "Evaluation progress" })).toBeNull();
  });

  it("the confirm dialog shows \"up to N calls\" from overview.confirm.upTo, says money already spent is not refunded on Cancel, and sends N back unchanged with the typed name", () => {
    const onConfirm = vi.fn();
    render(<EvaluateConfirmDialog upTo={8} name="kamal" pending={false} opener={null} onConfirm={onConfirm} onCancel={() => {}} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("up to 8 model calls");
    expect(dialog.textContent).toContain("Cancelling a running evaluation does not refund money already spent on model calls.");
    expect(dialog.textContent).toContain("kamal");
    fireEvent.click(screen.getByRole("button", { name: "Evaluate" }));
    expect(onConfirm).toHaveBeenCalledWith(8);
  });
});
