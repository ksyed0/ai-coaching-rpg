// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseReportOverview } from "../../../../lib/console-api";
import { REPORT_CONSOLE } from "../../../../lib/messages";
import { AuthorName, loadAuthorName } from "../AuthorName";
import { RunSummaryView } from "../RunSummaryView";
import { SubjectList } from "../SubjectList";
import { inReview, row, summary } from "./fixtures";

beforeEach(() => {
  try { sessionStorage.clear(); } catch { /* none */ }
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const RULE = "Use letters, digits, underscore or hyphen, up to 56 characters.";

describe("RunSummaryView", () => {
  it("RunSummaryView shows scenes ended by the Game Master, fallback counts and alerts as text", () => {
    const o = parseReportOverview(inReview())!;
    render(<RunSummaryView summary={o.summary!} />);
    expect(screen.getByText("Scenes ended by the Game Master: 1")).toBeTruthy();
    expect(screen.getByText("Fallback replies: 2 of 10 character replies")).toBeTruthy();
    expect(screen.getByText("Dana: 2 fallback of 6 replies")).toBeTruthy();
    const alert = screen.getByText(/The model did not answer in time/);
    expect(alert.textContent).toBe("Warning, Account manager: The model did not answer in time (a fallback line was used)");
    cleanup();
    render(<RunSummaryView summary={{ ...o.summary!, alerts: [] }} />);
    expect(screen.getByText("No facilitator alerts.")).toBeTruthy();
  });

  it("an alert reason is shown as text, never markup", () => {
    const o = parseReportOverview({ ...inReview(), summary: summary({ alerts: [{ seq: 1, level: "info", role: null, fallback: false, reason: "<img src=x>", replySeq: null }] }) })!;
    const { container } = render(<RunSummaryView summary={o.summary!} />);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("Info: <img src=x>")).toBeTruthy();
  });
});

describe("SubjectList", () => {
  it("SubjectList shows each subject's own state (draft, released, amending, withdrawn) and open-item count, with no global released state", () => {
    const subjects = [
      row("account_manager", { openCriteria: ["clarity", "pace"] }),
      row("delivery_lead", { state: "released", version: 4 }),
      row("sales_lead", { state: "amending", openDisputes: [{ seq: 9, role: "sales_lead", criterion: null }] }),
      row("client", { state: "withdrawn" }),
      row("group", { summaryStale: true }),
    ];
    const o = parseReportOverview(inReview(subjects))!;
    const onSelect = vi.fn();
    render(<SubjectList subjects={o.subjects} selected={null} onSelect={onSelect} />);
    const items = screen.getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      "Account managerDraft2 open itemsReview",
      "Delivery leadReleasedNo open itemsReview",
      "Sales leadAmending1 open itemReview",
      "ClientWithdrawnNo open itemsReview",
      "GroupDraft1 open itemReview",
    ]);
    // one "Released" only: the delivery lead's own row, and no panel-wide released state
    expect(screen.getAllByText(/released/i)).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Review Sales lead" }));
    expect(onSelect).toHaveBeenCalledWith("sales_lead");
  });
});

describe("test_SubjectList_aiRoles (US-0068)", () => {
  const NOT_SCORED = REPORT_CONSOLE.aiNotScored;

  it("one read-only AI row per listed role, after the subject rows (Group included), in the given order", () => {
    const o = parseReportOverview({ ...inReview([row("account_manager"), row("group")]), aiRoles: ["tech_lead", "ai1"] })!;
    const onSelect = vi.fn();
    render(<SubjectList subjects={o.subjects} aiRoles={o.aiRoles} selected={null} onSelect={onSelect} />);
    const items = screen.getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      "Account managerDraftNo open itemsReview",
      "GroupDraftNo open itemsReview",
      `Tech leadAI player${NOT_SCORED}`,
      `Ai1AI player${NOT_SCORED}`,
    ]);
    // the words carry the meaning: the pill says "AI player" in text (pill ai, as elsewhere in the console) and the row says "not scored"
    const pill = screen.getAllByText("AI player", { exact: true })[0]!;
    expect(pill.className).toBe("pill ai");
    expect(NOT_SCORED).toMatch(/^not scored/);
    // no control of any kind on an AI row: not selectable, no Review, Amend, Withdraw, Release or Export
    for (const li of items.slice(2)) {
      expect(li.querySelectorAll("button, a, input, select, [tabindex]")).toHaveLength(0);
    }
    expect(screen.queryByRole("button", { name: "Review Tech lead" })).toBeNull();
    expect(screen.getAllByRole("button")).toHaveLength(2);
  });

  it("the row shows with the post-release actions too, still with no buttons of its own", () => {
    const o = parseReportOverview({ ...inReview([row("account_manager", { state: "released", version: 3 }), row("group")]), aiRoles: ["tech_lead"] })!;
    const on = { onAmend: vi.fn(), onWithdraw: vi.fn(), onExport: vi.fn(), onRelease: vi.fn() };
    render(<SubjectList subjects={o.subjects} aiRoles={o.aiRoles} selected={null} onSelect={() => {}} actions={{ canWrite: true, pending: false, ...on }} />);
    const ai = screen.getAllByRole("listitem").at(-1)!;
    expect(ai.textContent).toBe(`Tech leadAI player${NOT_SCORED}`);
    expect(ai.querySelectorAll("button")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Export Tech lead" })).toBeNull();
  });

  it("a listed role that is also a subject keeps only its subject row", () => {
    const o = parseReportOverview({ ...inReview([row("account_manager"), row("group")]), aiRoles: ["account_manager", "tech_lead"] })!;
    render(<SubjectList subjects={o.subjects} aiRoles={o.aiRoles} selected={null} onSelect={() => {}} />);
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Account managerDraftNo open itemsReview",
      "GroupDraftNo open itemsReview",
      `Tech leadAI player${NOT_SCORED}`,
    ]);
  });

  it("an empty or absent list renders nothing extra", () => {
    const o = parseReportOverview(inReview([row("account_manager"), row("group")]))!;
    render(<SubjectList subjects={o.subjects} aiRoles={[]} selected={null} onSelect={() => {}} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    cleanup();
    render(<SubjectList subjects={o.subjects} selected={null} onSelect={() => {}} />);
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.queryByText("AI player", { exact: true })).toBeNull();
  });
});

describe("SubjectList: a subject release still blocks", () => {
  it("the parser carries evaluationOk and scoreByHand, and refuses a row without them", () => {
    const o = parseReportOverview(inReview([row("account_manager", { evaluationOk: false, scoreByHand: ["clarity", "pace"] })]))!;
    expect(o.subjects[0]).toMatchObject({ evaluationOk: false, scoreByHand: ["clarity", "pace"] });
    const { scoreByHand: _s, ...noHand } = row("group");
    const { evaluationOk: _e, ...noOk } = row("group");
    expect(parseReportOverview(inReview([noHand]))).toBeNull();
    expect(parseReportOverview(inReview([noOk]))).toBeNull();
    expect(parseReportOverview(inReview([row("group", { scoreByHand: [3] })]))).toBeNull();
  });

  it("criteria to score by hand count as open items, once each, so an accepted failed evaluation never reads \"No open items\"", () => {
    const subjects = [
      // the evaluation failed and every criterion was accepted: still three to score by hand
      row("account_manager", { evaluationOk: false, scoreByHand: ["clarity", "pace", "tone"] }),
      // an invalid level that was accepted: one by hand
      row("delivery_lead", { scoreByHand: ["clarity"] }),
      // open for review AND by hand: counted once
      row("sales_lead", { openCriteria: ["clarity", "pace"], scoreByHand: ["clarity"] }),
    ];
    const o = parseReportOverview(inReview(subjects))!;
    render(<SubjectList subjects={o.subjects} selected={null} onSelect={() => {}} />);
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Account managerDraft3 open itemsReview",
      "Delivery leadDraft1 open itemReview",
      "Sales leadDraft2 open itemsReview",
    ]);
  });
});

describe("AuthorName", () => {
  function Harness({ onChange }: { onChange: (v: string) => void }) {
    return <AuthorName value={valueRef.v} onChange={(v) => { valueRef.v = v; onChange(v); }} />;
  }
  const valueRef = { v: "" };

  it("AuthorName rejects \"Kamal Syed\" with the rule sentence and accepts \"kamal\"", () => {
    const seen: string[] = [];
    const { rerender } = render(<Harness onChange={(v) => seen.push(v)} />);
    const input = screen.getByLabelText("Your name for the review record") as HTMLInputElement;
    // the rule is always stated
    expect(screen.getByText(RULE)).toBeTruthy();
    fireEvent.change(input, { target: { value: "Kamal Syed" } });
    rerender(<Harness onChange={(v) => seen.push(v)} />);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toBe(`That name cannot be used. ${RULE}`);
    expect(loadAuthorName()).toBe("");
    fireEvent.change(input, { target: { value: "kamal" } });
    rerender(<Harness onChange={(v) => seen.push(v)} />);
    expect(input.getAttribute("aria-invalid")).toBe("false");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(seen).toEqual(["Kamal Syed", "kamal"]);
    expect(loadAuthorName()).toBe("kamal");
    // 57 characters is over the rule; 56 is within it
    fireEvent.change(input, { target: { value: "a".repeat(57) } });
    rerender(<Harness onChange={(v) => seen.push(v)} />);
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("works when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(loadAuthorName()).toBe("");
    valueRef.v = "";
    render(<Harness onChange={() => {}} />);
    expect(() => fireEvent.change(screen.getByLabelText("Your name for the review record"), { target: { value: "kamal" } })).not.toThrow();
  });
});
