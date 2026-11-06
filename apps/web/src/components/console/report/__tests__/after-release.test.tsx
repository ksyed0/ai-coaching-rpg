// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeFetch, fakeTimer, ok, refused } from "../../../../lib/__tests__/fakes";
import { parseReportOverview } from "../../../../lib/console-api";
import { AmendDialog } from "../AmendDialog";
import { ExportMenu, saveMarkdown } from "../ExportMenu";
import { ReportPanel } from "../ReportPanel";
import { ResolveDisputePanel } from "../ResolveDisputePanel";
import { SubjectList } from "../SubjectList";
import { SubjectView } from "../SubjectView";
import { WithdrawDialog } from "../WithdrawDialog";
import { BASE, SID, inReview, row, subjectView } from "./fixtures";

beforeEach(() => {
  try { sessionStorage.clear(); } catch { /* none */ }
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const AUDIENCE = ["Account manager (the participant this report is about)", "The facilitator"];
const SUBJECT = { id: "account_manager", audience: AUDIENCE };
const base = { name: "kamal", pending: false, opener: null, error: "", onConfirm: () => {}, onCancel: () => {} };

describe("AmendDialog and WithdrawDialog", () => {
  it("AmendDialog and WithdrawDialog each name the subject and the audience", () => {
    render(<AmendDialog {...base} subject={SUBJECT} />);
    let dialog = screen.getByRole("dialog", { name: "Amend the Account manager report?" });
    for (const a of AUDIENCE) expect(within(dialog).getByText(a)).toBeTruthy();
    cleanup();
    render(<WithdrawDialog {...base} subject={SUBJECT} />);
    dialog = screen.getByRole("dialog", { name: "Withdraw the Account manager report?" });
    for (const a of AUDIENCE) expect(within(dialog).getByText(a)).toBeTruthy();
  });

  it("AmendDialog requires a reason and sends it", () => {
    const onConfirm = vi.fn();
    render(<AmendDialog {...base} subject={SUBJECT} onConfirm={onConfirm} />);
    const amend = screen.getByRole("button", { name: "Amend" }) as HTMLButtonElement;
    expect(amend.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason for the amendment (required)"), { target: { value: "  " } });
    expect(amend.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason for the amendment (required)"), { target: { value: "The pace level was wrong." } });
    expect(amend.disabled).toBe(false);
    fireEvent.click(amend);
    expect(onConfirm).toHaveBeenCalledWith("The pace level was wrong.");
  });

  it("WithdrawDialog says it cannot be undone and requires a reason", () => {
    const onConfirm = vi.fn();
    render(<WithdrawDialog {...base} subject={SUBJECT} onConfirm={onConfirm} />);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Withdrawing cannot be undone.")).toBeTruthy();
    const withdraw = within(dialog).getByRole("button", { name: "Withdraw" }) as HTMLButtonElement;
    expect(withdraw.disabled).toBe(true);
    fireEvent.click(withdraw);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText("Reason for withdrawing (required)"), { target: { value: "Wrong person." } });
    fireEvent.click(withdraw);
    expect(onConfirm).toHaveBeenCalledWith("Wrong person.");
  });
});

function mountPanel(first: unknown, answer: (url: string, body: unknown) => { status: number; body: unknown } | undefined) {
  const f = fakeFetch((url, body) => {
    const a = body === undefined ? undefined : answer(url, body);
    if (a) return a;
    if (url === BASE) return { status: 200, body: ok(first) };
    if (url === `${BASE}/subjects/account_manager`) return { status: 200, body: ok(subjectView({ state: "released", versions: [4] })) };
    return { status: 404, body: refused("not_found", "x") };
  });
  render(<ReportPanel sessionId={SID} fetch={f.fetch} setTimer={fakeTimer().setTimer} />);
  fireEvent.change(screen.getByLabelText("Your name for the review record"), { target: { value: "kamal" } });
  return f;
}

describe("the typed reason survives a refusal", () => {
  it("after a stale or busy refusal the typed reason stays", async () => {
    let answer = { status: 409, body: refused("stale", "SERVER TEXT") };
    const f = mountPanel(inReview([row("account_manager", { state: "released", version: 4 }), row("group")]), (url) =>
      url.endsWith("/amend") || url.endsWith("/withdraw") ? answer : undefined);
    fireEvent.click(await screen.findByRole("button", { name: "Amend Account manager" }));
    fireEvent.change(screen.getByLabelText("Reason for the amendment (required)"), { target: { value: "The pace level was wrong." } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Amend" }));
    expect(await within(screen.getByRole("dialog")).findByText("Someone changed this. Reload the level and try again.")).toBeTruthy();
    expect((screen.getByLabelText("Reason for the amendment (required)") as HTMLTextAreaElement).value).toBe("The pace level was wrong.");
    expect(f.calls.filter((c) => c.url.endsWith("/amend"))[0]!.body).toEqual({ reason: "The pace level was wrong.", by: "kamal" });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));

    answer = { status: 503, body: refused("busy", "SERVER TEXT") };
    fireEvent.click(screen.getByRole("button", { name: "Withdraw Account manager" }));
    fireEvent.change(screen.getByLabelText("Reason for withdrawing (required)"), { target: { value: "Wrong person." } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Withdraw" }));
    expect(await within(screen.getByRole("dialog")).findByText("The report is busy. Try again in a moment.")).toBeTruthy();
    expect((screen.getByLabelText("Reason for withdrawing (required)") as HTMLTextAreaElement).value).toBe("Wrong person.");

    answer = { status: 400, body: refused("invalid", "SERVER TEXT") };
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Withdraw" }));
    expect(await within(screen.getByRole("dialog")).findByText("That could not be saved. Check what you entered.")).toBeTruthy();
    expect((screen.getByLabelText("Reason for withdrawing (required)") as HTMLTextAreaElement).value).toBe("Wrong person.");
    expect(screen.queryByText("SERVER TEXT")).toBeNull();
  });

  it("a successful amend closes the dialog and says so", async () => {
    const f = mountPanel(inReview([row("account_manager", { state: "released", version: 4 }), row("group")]), (url) =>
      url.endsWith("/amend") ? { status: 200, body: ok({}) } : undefined);
    fireEvent.click(await screen.findByRole("button", { name: "Amend Account manager" }));
    fireEvent.change(screen.getByLabelText("Reason for the amendment (required)"), { target: { value: "Pace." } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Amend" }));
    expect(await screen.findByText("The report is open for amendment. Change it, then release it again.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(f.calls.filter((c) => c.url === `${BASE}/subjects/account_manager/amend`)).toHaveLength(1);
  });
});

describe("SubjectList after release", () => {
  it("offers Amend, Withdraw and Export on a released subject, Release on an amending one, and nothing on a withdrawn one", () => {
    const o = parseReportOverview(inReview([
      row("account_manager", { state: "released", version: 4 }),
      row("sales_lead", { state: "amending", version: 5 }),
      row("client", { state: "withdrawn", version: 2 }),
      row("group"),
    ]))!;
    const on = { onAmend: vi.fn(), onWithdraw: vi.fn(), onExport: vi.fn(), onRelease: vi.fn() };
    render(<SubjectList subjects={o.subjects} selected={null} onSelect={() => {}} actions={{ canWrite: true, pending: false, ...on }} />);
    const names = (li: HTMLElement) => within(li).getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    const [am, sl, cl, gr] = screen.getAllByRole("listitem");
    expect(names(am!)).toEqual(["Review Account manager", "Amend Account manager", "Withdraw Account manager", "Export Account manager"]);
    expect(names(sl!)).toEqual(["Review Sales lead", "Release Sales lead"]);
    expect(names(cl!)).toEqual(["Review Client"]);
    expect(names(gr!)).toEqual(["Review Group"]);
    fireEvent.click(screen.getByRole("button", { name: "Export Account manager" }));
    expect(on.onExport).toHaveBeenCalledWith("account_manager");
    fireEvent.click(screen.getByRole("button", { name: "Release Sales lead" }));
    expect(on.onRelease.mock.calls[0]![0]).toBe("sales_lead");
    cleanup();
    render(<SubjectList subjects={o.subjects} selected={null} onSelect={() => {}} actions={{ canWrite: false, pending: false, ...on }} />);
    expect((screen.getByRole("button", { name: "Amend Account manager" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Export Account manager" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

const dispute = (over: Record<string, unknown> = {}) => ({ seq: 7, role: "account_manager", text: "I did <b>ask</b> about the budget.", dispute: true, ...over });

describe("ResolveDisputePanel", () => {
  it("ResolveDisputePanel offers amended only after an amend", () => {
    const props = { canWrite: true, pending: false, criterionName: (c: string) => (c === "clarity" ? "Clarity" : c), onResolve: async () => null };
    // released at seq 4, disputed at 7, not amended since: upheld or declined only
    const { rerender, container } = render(<ResolveDisputePanel {...props} responses={[dispute({ criterion: "clarity" })]} versions={[4]} />);
    expect(screen.getByText("I did <b>ask</b> about the budget.")).toBeTruthy();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByText("Clarity", { exact: false })).toBeTruthy();
    const options = () => [...(screen.getByLabelText("Outcome") as HTMLSelectElement).options].map((o) => o.value);
    expect(options()).toEqual(["", "upheld", "declined"]);
    expect(screen.getByText("To resolve it as amended, amend the report and release the new version first.")).toBeTruthy();
    // amended and released again at seq 9: amended is offered
    rerender(<ResolveDisputePanel {...props} responses={[dispute({ criterion: "clarity" })]} versions={[4, 9]} />);
    expect(options()).toEqual(["", "upheld", "amended", "declined"]);
    // a resolved response, or one that is not a dispute, is not listed
    rerender(<ResolveDisputePanel {...props} responses={[dispute({ resolution: { outcome: "upheld", reason: "x" } }), dispute({ seq: 8, dispute: false })]} versions={[4]} />);
    expect(screen.queryByLabelText("Outcome")).toBeNull();
  });

  it("requires an outcome and a reason, and sends both from the subject view", async () => {
    const f = fakeFetch((url, body) => {
      if (body !== undefined) return url === `${BASE}/resolve` ? { status: 200, body: ok({}) } : { status: 404, body: refused("not_found", "x") };
      return url === `${BASE}/subjects/account_manager` ? { status: 200, body: ok(subjectView({ state: "released", versions: [4], responses: [dispute()] })) } : { status: 404, body: refused("not_found", "x") };
    });
    render(<SubjectView sessionId={SID} subject="account_manager" author="kamal" evaluationOk fetch={f.fetch} />);
    const resolve = (await screen.findByRole("button", { name: "Resolve" })) as HTMLButtonElement;
    expect(resolve.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Outcome"), { target: { value: "declined" } });
    expect(resolve.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason shown to the participant (required)"), { target: { value: "The quote is from scene 2." } });
    expect(resolve.disabled).toBe(false);
    fireEvent.click(resolve);
    await waitFor(() => expect(f.calls.filter((c) => c.url === `${BASE}/resolve`)).toHaveLength(1));
    expect(f.calls.find((c) => c.url === `${BASE}/resolve`)!.body).toEqual({ seq: 7, outcome: "declined", reason: "The quote is from scene 2.", by: "kamal" });
  });

  it("a refused resolve keeps the typed reason", async () => {
    const f = fakeFetch((url, body) => {
      if (body !== undefined) return { status: 409, body: refused("needs_amend", "x") };
      return url === `${BASE}/subjects/account_manager` ? { status: 200, body: ok(subjectView({ state: "released", versions: [4, 9], responses: [dispute()] })) } : { status: 404, body: refused("not_found", "x") };
    });
    render(<SubjectView sessionId={SID} subject="account_manager" author="kamal" evaluationOk fetch={f.fetch} />);
    fireEvent.change(await screen.findByLabelText("Outcome"), { target: { value: "amended" } });
    fireEvent.change(screen.getByLabelText("Reason shown to the participant (required)"), { target: { value: "Changed to level 3." } });
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }));
    expect(await screen.findByText("This released report must be amended before it can change.")).toBeTruthy();
    expect((screen.getByLabelText("Reason shown to the participant (required)") as HTMLTextAreaElement).value).toBe("Changed to level 3.");
  });
});

describe("ExportMenu", () => {
  const subjects = () => parseReportOverview(inReview([row("account_manager", { state: "released", version: 4 }), row("sales_lead", { state: "amending", version: 5 }), row("group", { state: "released", version: 4 })]))!.subjects;
  const markdown = (status: number, body: string, headers: Record<string, string>) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      calls.push({ url: String(input), init });
      return new Response(body, { status, headers });
    }) as typeof fetch;
    return { fetchImpl, calls };
  };

  it("ExportMenu posts, saves the returned text, and shows the fixed sentence on a refusal", async () => {
    const save = vi.fn();
    const ok200 = markdown(200, "# Report\n<script>x</script>", { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": 'attachment; filename="report-account_manager.md"' });
    render(<ExportMenu sessionId={SID} subjects={subjects()} author="kamal" fetch={ok200.fetchImpl} save={save} />);
    const subject = screen.getByLabelText("Report to export") as HTMLSelectElement;
    // released subjects and the index; an amending subject is not exported from the facilitator view
    expect([...subject.options].map((o) => o.value)).toEqual(["account_manager", "group", "index"]);
    const audience = () => [...(screen.getByLabelText("View") as HTMLSelectElement).options].map((o) => o.value);
    expect(audience()).toEqual(["facilitator", "participant:account_manager"]);
    fireEvent.change(screen.getByLabelText("View"), { target: { value: "participant:account_manager" } });
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith("# Report\n<script>x</script>", "report-account_manager.md");
    expect(ok200.calls[0]!.url).toBe(`${BASE}/export`);
    expect(ok200.calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(ok200.calls[0]!.init.body as string)).toEqual({ subject: "account_manager", audience: "participant:account_manager", by: "kamal" });
    expect(await screen.findByText("Downloaded report-account_manager.md.")).toBeTruthy();
    // the group and the index offer the facilitator view only
    fireEvent.change(subject, { target: { value: "group" } });
    expect(audience()).toEqual(["facilitator"]);
    cleanup();

    const save2 = vi.fn();
    const refusal = markdown(409, JSON.stringify(refused("not_released", "SERVER TEXT")), { "Content-Type": "application/json" });
    render(<ExportMenu sessionId={SID} subjects={subjects()} author="kamal" fetch={refusal.fetchImpl} save={save2} />);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(await screen.findByText("That report has not been released.")).toBeTruthy();
    expect(save2).not.toHaveBeenCalled();
    expect(screen.queryByText("SERVER TEXT")).toBeNull();
  });

  it("a missing or odd file name falls back to report.md, a non-Markdown answer saves nothing, and no name disables it", async () => {
    const save = vi.fn();
    const odd = markdown(200, "# R", { "Content-Type": "text/markdown", "Content-Disposition": 'attachment; filename="../etc/passwd"' });
    render(<ExportMenu sessionId={SID} subjects={subjects()} author="kamal" fetch={odd.fetchImpl} save={save} />);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(save).toHaveBeenCalledWith("# R", "report.md"));
    cleanup();

    const html = markdown(200, "<html></html>", { "Content-Type": "text/html" });
    const save2 = vi.fn();
    render(<ExportMenu sessionId={SID} subjects={subjects()} author="kamal" fetch={html.fetchImpl} save={save2} />);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(await screen.findByText("That action is not possible right now.")).toBeTruthy();
    expect(save2).not.toHaveBeenCalled();
    cleanup();

    render(<ExportMenu sessionId={SID} subjects={subjects()} author={null} fetch={html.fetchImpl} save={save2} />);
    expect((screen.getByRole("button", { name: "Download" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("saveMarkdown", () => {
  it("saves the text through a Blob link with the file name, then removes the link and revokes the URL", async () => {
    const blobs: Blob[] = [];
    const create = vi.fn((b: Blob) => { blobs.push(b); return "blob:x"; });
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { clicked.push(this); });
    const later: (() => void)[] = [];
    saveMarkdown("# R <b>x</b>", "report-group.md", (fn) => { later.push(fn); });
    expect(clicked).toHaveLength(1);
    expect(clicked[0]!.download).toBe("report-group.md");
    expect(clicked[0]!.getAttribute("href")).toBe("blob:x");
    expect(clicked[0]!.isConnected).toBe(false);
    expect(blobs[0]!.type).toBe("text/markdown;charset=utf-8");
    expect(await blobs[0]!.text()).toBe("# R <b>x</b>");
    expect(revoke).not.toHaveBeenCalled();
    later.forEach((fn) => fn());
    expect(revoke).toHaveBeenCalledWith("blob:x");
  });
});

describe("fix wave G2: the object URL outlives the download", () => {
  it("is not revoked at 0 ms, only after 30 s", () => {
    vi.useFakeTimers();
    try {
      const revoke = vi.fn();
      Object.assign(URL, { createObjectURL: () => "blob:y", revokeObjectURL: revoke });
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
      saveMarkdown("# R", "report-group.md");
      vi.advanceTimersByTime(0);
      expect(revoke).not.toHaveBeenCalled();
      vi.advanceTimersByTime(29_999);
      expect(revoke).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(revoke).toHaveBeenCalledWith("blob:y");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the injected timer with a 30 s delay", () => {
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: () => "blob:z", revokeObjectURL: revoke });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const later: { fn: () => void; ms: number }[] = [];
    saveMarkdown("# R", "report-group.md", (fn, ms) => { later.push({ fn, ms }); });
    expect(later.map((l) => l.ms)).toEqual([30_000]);
    expect(revoke).not.toHaveBeenCalled();
    later[0]!.fn();
    expect(revoke).toHaveBeenCalledWith("blob:z");
  });
});

describe("fix round 1: carried disputes and read-only released views", () => {
  it("a dispute carried from a superseded review (seq below the first release) is not offered amended", () => {
    const props = { canWrite: true, pending: false, criterionName: (c: string) => c, onResolve: async () => null };
    render(<ResolveDisputePanel {...props} responses={[dispute({ seq: 2 })]} versions={[4]} />);
    expect([...(screen.getByLabelText("Outcome") as HTMLSelectElement).options].map((o) => o.value)).toEqual(["", "upheld", "declined"]);
  });

  it("a released and a withdrawn subject show no Edit or Accept; an amending and a draft subject do; comment and resolve stay", async () => {
    for (const state of ["released", "withdrawn", "amending", "draft"] as const) {
      const f = fakeFetch((url) => (url === `${BASE}/subjects/account_manager` ? { status: 200, body: ok(subjectView({ state, versions: [4, 9], responses: [dispute()] })) } : { status: 404, body: refused("not_found", "x") }));
      render(<SubjectView sessionId={SID} subject="account_manager" author="kamal" evaluationOk fetch={f.fetch} />);
      await screen.findByRole("heading", { name: "Clarity" });
      const writable = state === "draft" || state === "amending";
      expect(screen.queryByRole("button", { name: "Edit Clarity" }) !== null, state).toBe(writable);
      expect(screen.queryByRole("button", { name: "Accept Clarity" }) !== null, state).toBe(writable);
      expect(screen.queryByRole("button", { name: "Accept the summary" }) !== null, state).toBe(writable);
      expect(screen.queryByText("Amend the report to change it.") !== null, state).toBe(!writable);
      expect(screen.getByRole("button", { name: "Add comment" }), state).toBeTruthy();
      expect(screen.getByRole("button", { name: "Resolve" }), state).toBeTruthy();
      cleanup();
    }
  });
});

describe("fix wave G1: the open subject view follows a panel release, amend or withdraw", () => {
  /** A panel whose overview and subject view the test changes as the server would; `answer` answers the writes. */
  function live(first: { overview: unknown; view: unknown }, answer: (url: string, body: unknown) => { status: number; body: unknown } | undefined) {
    const state = { ...first };
    const f = fakeFetch((url, body) => {
      const a = body === undefined ? undefined : answer(url, body);
      if (a) return a;
      if (url === BASE) return { status: 200, body: ok(state.overview) };
      if (url === `${BASE}/subjects/account_manager`) return { status: 200, body: ok(state.view) };
      return { status: 404, body: refused("not_found", "x") };
    });
    render(<ReportPanel sessionId={SID} fetch={f.fetch} setTimer={fakeTimer().setTimer} />);
    fireEvent.change(screen.getByLabelText("Your name for the review record"), { target: { value: "kamal" } });
    return { f, state };
  }

  it("after a release from the bar, the open view of that subject shows no Edit or Accept", async () => {
    const m = live({ overview: inReview([row("account_manager"), row("group")]), view: subjectView() }, (url) => {
      if (url !== `${BASE}/release`) return undefined;
      m.state.overview = inReview([row("account_manager", { state: "released", version: 4 }), row("group", { state: "released", version: 4 })]);
      m.state.view = subjectView({ state: "released", versions: [4] });
      return { status: 200, body: ok({ released: ["account_manager", "group"], groupTableStale: false }) };
    });
    fireEvent.click(await screen.findByRole("button", { name: "Review Account manager" }));
    expect(await screen.findByRole("button", { name: "Edit Clarity" })).toBeTruthy();
    fireEvent.click(within(screen.getByRole("region", { name: "Release" })).getByRole("button", { name: "Release everything…" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Release" }));
    expect(await screen.findByText("Amend the report to change it.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Edit Clarity" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Accept Clarity" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Accept the summary" })).toBeNull();
  });

  it("after Amend, the open view shows the edit tools; after the re-release Amended is offered for an earlier dispute", async () => {
    const released = { overview: inReview([row("account_manager", { state: "released", version: 4 }), row("group", { state: "released", version: 4 })]), view: subjectView({ state: "released", versions: [4], responses: [dispute()] }) };
    const m = live(released, (url) => {
      if (url === `${BASE}/subjects/account_manager/amend`) {
        m.state.overview = inReview([row("account_manager", { state: "amending", version: 4 }), row("group", { state: "released", version: 4 })]);
        m.state.view = subjectView({ state: "amending", versions: [4], responses: [dispute()] });
        return { status: 200, body: ok({}) };
      }
      if (url === `${BASE}/release`) {
        m.state.overview = inReview([row("account_manager", { state: "released", version: 9 }), row("group", { state: "released", version: 4 })]);
        m.state.view = subjectView({ state: "released", versions: [4, 9], responses: [dispute()] });
        return { status: 200, body: ok({ released: ["account_manager"], groupTableStale: false }) };
      }
      return undefined;
    });
    fireEvent.click(await screen.findByRole("button", { name: "Review Account manager" }));
    expect(await screen.findByText("Amend the report to change it.")).toBeTruthy();
    const outcomes = () => [...(screen.getByLabelText("Outcome") as HTMLSelectElement).options].map((o) => o.value);
    expect(outcomes()).toEqual(["", "upheld", "declined"]);

    fireEvent.click(screen.getByRole("button", { name: "Amend Account manager" }));
    fireEvent.change(screen.getByLabelText("Reason for the amendment (required)"), { target: { value: "Pace." } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Amend" }));
    expect(await screen.findByRole("button", { name: "Edit Clarity" })).toBeTruthy();
    expect(screen.queryByText("Amend the report to change it.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Release Account manager" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Release" }));
    await waitFor(() => expect(outcomes()).toEqual(["", "upheld", "amended", "declined"]));
    expect(screen.queryByRole("button", { name: "Edit Clarity" })).toBeNull();
  });

  it("a refused panel action does not reload the open view (a typed comment stays)", async () => {
    const m = live({ overview: inReview([row("account_manager", { state: "released", version: 4 }), row("group")]), view: subjectView({ state: "released", versions: [4] }) }, (url) =>
      url.endsWith("/amend") ? { status: 409, body: refused("stale", "x") } : undefined);
    fireEvent.click(await screen.findByRole("button", { name: "Review Account manager" }));
    await screen.findByText("Amend the report to change it.");
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Keep me." } });
    const viewReads = () => m.f.calls.filter((c) => c.url === `${BASE}/subjects/account_manager`).length;
    const before = viewReads();
    fireEvent.click(screen.getByRole("button", { name: "Amend Account manager" }));
    fireEvent.change(screen.getByLabelText("Reason for the amendment (required)"), { target: { value: "Pace." } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Amend" }));
    await waitFor(() => expect(m.f.calls.filter((c) => c.url === BASE).length).toBeGreaterThanOrEqual(2));
    expect(viewReads()).toBe(before);
    expect((screen.getByLabelText("Comment") as HTMLTextAreaElement).value).toBe("Keep me.");
  });
});

describe("fix wave G3: the group-table banner follows the group row", () => {
  it("release group, release one player (banner on), release another (answer false): the banner stays while the group row is stale", async () => {
    const players = (am: string, sl: string) => [row("account_manager", { state: am, version: am === "released" ? 5 : null }), row("sales_lead", { state: sl, version: sl === "released" ? 6 : null })];
    let current = inReview([...players("draft", "draft"), row("group", { state: "released", version: 3 })]);
    let answer = { released: ["account_manager"], groupTableStale: true };
    const f = fakeFetch((url, body) => {
      if (body !== undefined && url === `${BASE}/release`) {
        const r = (body as { subjects: string[] }).subjects;
        current = inReview([...players("released", r.includes("sales_lead") ? "released" : "draft"), row("group", { state: "released", version: 3, tableStale: true })]);
        return { status: 200, body: ok({ ...answer, released: r }) };
      }
      if (url === BASE) return { status: 200, body: ok(current) };
      return { status: 404, body: refused("not_found", "x") };
    });
    render(<ReportPanel sessionId={SID} fetch={f.fetch} setTimer={fakeTimer().setTimer} />);
    fireEvent.change(screen.getByLabelText("Your name for the review record"), { target: { value: "kamal" } });
    const HINT = "The group's per-role table is now out of date; amend and re-release the group to refresh it.";
    const bar = await screen.findByRole("region", { name: "Release" });
    expect(screen.queryByText(HINT)).toBeNull();
    fireEvent.click(within(bar).getByLabelText("Account manager"));
    fireEvent.click(within(bar).getByRole("button", { name: "Release selected…" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Release" }));
    expect(await screen.findByText(HINT)).toBeTruthy();
    answer = { released: ["sales_lead"], groupTableStale: false };
    fireEvent.click(within(bar).getByLabelText("Sales lead"));
    fireEvent.click(within(bar).getByRole("button", { name: "Release selected…" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Release" }));
    await waitFor(() => expect(f.calls.filter((c) => c.url === `${BASE}/release`)).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText(HINT)).toBeTruthy();
  });

  it("the banner shows on load for a released, stale group and not for an amending one", async () => {
    for (const [state, shown] of [["released", true], ["amending", false]] as const) {
      const f = fakeFetch((url) => (url === BASE ? { status: 200, body: ok(inReview([row("account_manager"), row("group", { state, version: 3, tableStale: true })])) } : { status: 404, body: refused("not_found", "x") }));
      render(<ReportPanel sessionId={SID} fetch={f.fetch} setTimer={fakeTimer().setTimer} />);
      await screen.findByRole("region", { name: "Release" });
      expect(screen.queryByText("The group's per-role table is now out of date; amend and re-release the group to refresh it.") !== null, state).toBe(shown);
      cleanup();
    }
  });
});

describe("fix wave G4: an unknown subject says the report, not the session, was not found", () => {
  it("a 404 unknown_subject shows the report sentence; a plain 404 keeps the session sentence", async () => {
    for (const [code, text] of [["unknown_subject", "That report was not found. Reload the page."], ["not_found", "That session was not found."]] as const) {
      mountPanel(inReview([row("account_manager", { state: "released", version: 4 }), row("group")]), (url) =>
        url.endsWith("/amend") ? { status: 404, body: refused(code, "SERVER TEXT") } : undefined);
      fireEvent.click(await screen.findByRole("button", { name: "Amend Account manager" }));
      fireEvent.change(screen.getByLabelText("Reason for the amendment (required)"), { target: { value: "Pace." } });
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Amend" }));
      expect(await within(screen.getByRole("dialog")).findByText(text)).toBeTruthy();
      expect(screen.queryByText("SERVER TEXT")).toBeNull();
      cleanup();
    }
  });
});
