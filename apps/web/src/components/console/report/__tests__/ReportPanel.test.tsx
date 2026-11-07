// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeClock, FakeEventSource, fakeFetch, fakeTimer, ok, readiness, refused } from "../../../../lib/__tests__/fakes";
import type { EventSourceCtor } from "../../../../lib/use-session";
import { SessionConsole } from "../../SessionConsole";
import { ReportPanel } from "../ReportPanel";
import { BASE, SID, inReview, job, overview, row, subjectView } from "./fixtures";

beforeEach(() => {
  try { sessionStorage.clear(); } catch { /* none */ }
});
afterEach(cleanup);

type Answer = (url: string, body: unknown, method: string) => { status: number; body: unknown } | undefined;
function mount(first: unknown, answer: Answer = () => undefined) {
  let current = first;
  const timer = fakeTimer();
  const f = fakeFetch((url, body) => {
    const method = f.calls.at(-1)!.init.method ?? "GET";
    const a = answer(url, body, method);
    if (a) return a;
    if (url === BASE) return { status: 200, body: ok(current) };
    return { status: 404, body: refused("not_found", "x") };
  });
  const r = render(<ReportPanel sessionId={SID} fetch={f.fetch} setTimer={timer.setTimer} />);
  return { ...r, f, timer, set: (o: unknown) => { current = o; } };
}
const reads = (m: ReturnType<typeof mount>) => m.f.calls.filter((c) => c.url === BASE && (c.init.method ?? "GET") === "GET").length;
const typeName = (v: string) => fireEvent.change(screen.getByLabelText("Your name for the review record"), { target: { value: v } });

describe("ReportPanel", () => {
  it("polling runs only while evaluating (injected timer)", async () => {
    const m = mount(overview({ stage: "evaluating", confirm: null, job: job({ state: "running", startedAt: 1, progress: ["evaluating the team"] }) }));
    expect(await screen.findByText("evaluating the team")).toBeTruthy();
    await waitFor(() => expect(m.timer.pending).toBe(1));
    expect(m.timer.delays).toEqual([2000]);
    expect(reads(m)).toBe(1);
    await act(async () => m.timer.fire());
    await waitFor(() => expect(reads(m)).toBe(2));
    await waitFor(() => expect(m.timer.pending).toBe(1));
    m.set(inReview());
    await act(async () => m.timer.fire());
    expect(await screen.findByText(/the review is open/)).toBeTruthy();
    expect(m.timer.pending).toBe(0);
    cleanup();

    // a stage that is not evaluating never schedules a poll
    const n = mount(overview());
    expect(await screen.findByRole("button", { name: "Evaluate…" })).toBeTruthy();
    expect(n.timer.pending).toBe(0);
  });

  it("the confirm dialog sends the bound back unchanged with the typed name, and the status line is polite", async () => {
    const m = mount(overview(), (url, body) => (url === `${BASE}/evaluate` && body !== undefined ? { status: 200, body: ok(job({ state: "running" })) } : undefined));
    const evaluate = (await screen.findByRole("button", { name: "Evaluate…" })) as HTMLButtonElement;
    expect(evaluate.disabled).toBe(true);
    typeName("kamal");
    expect(evaluate.disabled).toBe(false);
    m.set(overview({ stage: "evaluating", confirm: null, job: job({ state: "running", startedAt: 1 }) }));
    fireEvent.click(evaluate);
    fireEvent.click(screen.getByRole("button", { name: "Evaluate" }));
    await waitFor(() => expect(m.f.calls.some((c) => c.url === `${BASE}/evaluate`)).toBe(true));
    expect(m.f.calls.find((c) => c.url === `${BASE}/evaluate`)!.body).toEqual({ confirmedCalls: 8, by: "kamal" });
    const status = screen.getByText("The evaluation has started.");
    expect(status.getAttribute("aria-live")).toBe("polite");
  });

  it("a refusal is the fixed sentence for its code, never the server's text", async () => {
    mount(overview(), (url, body) => (url === `${BASE}/evaluate` && body !== undefined ? { status: 409, body: refused("confirm_mismatch", "SERVER TEXT") } : undefined));
    const evaluate = await screen.findByRole("button", { name: "Evaluate…" });
    typeName("kamal");
    fireEvent.click(evaluate);
    fireEvent.click(screen.getByRole("button", { name: "Evaluate" }));
    expect(await screen.findByText("The number of model calls changed. Reload the panel and confirm the new number.")).toBeTruthy();
    expect(screen.queryByText("SERVER TEXT")).toBeNull();
  });

  it("opens a subject from the list and shows its view", async () => {
    mount(inReview(), (url) => (url === `${BASE}/subjects/account_manager` ? { status: 200, body: ok(subjectView()) } : undefined));
    fireEvent.click(await screen.findByRole("button", { name: "Review Account manager" }));
    expect(await screen.findByRole("heading", { name: "Account manager" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Clarity" })).toBeTruthy();
  });

  it("a subject whose evaluation failed opens with the hand-scoring sentence and no Accept on its criteria", async () => {
    const subjects = [row("account_manager", { evaluationOk: false, scoreByHand: ["clarity"] }), row("group")];
    mount(inReview(subjects), (url) => (url === `${BASE}/subjects/account_manager` ? { status: 200, body: ok(subjectView()) } : undefined));
    expect(await screen.findByText("1 open item")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review Account manager" }));
    expect(await screen.findByText("The evaluation failed for this subject: score each criterion by hand.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit Clarity" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept Clarity" })).toBeNull();
  });
});

describe("SessionConsole and the report panel", () => {
  it("is shown above the participant links once the session has ended, and absent while it is live", async () => {
    FakeEventSource.reset();
    const f = fakeFetch((url) => {
      if (url.endsWith("/readiness")) return { status: 200, body: ok(readiness({ launcherStatus: "ended", status: "ended" })) };
      if (url.endsWith("/report-links")) return { status: 200, body: ok({ state: "not_ready", roles: [] }) };
      if (url.endsWith("/report")) return { status: 200, body: ok(overview()) };
      return { status: 200, body: ok({}) };
    });
    render(<SessionConsole sessionId={SID} deps={{ EventSource: FakeEventSource as unknown as EventSourceCtor, fetch: f.fetch, setTimer: fakeTimer().setTimer, clock: new FakeClock(1_000_000) }} />);
    const report = await screen.findByRole("heading", { level: 2, name: "Report" });
    const links = await screen.findByRole("heading", { level: 2, name: "Participant reports" });
    expect(report.compareDocumentPosition(links) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    cleanup();

    const g = fakeFetch((url) => (url.endsWith("/readiness") ? { status: 200, body: ok(readiness({ status: "running" })) } : { status: 200, body: ok({}) }));
    render(<SessionConsole sessionId={SID} deps={{ EventSource: FakeEventSource as unknown as EventSourceCtor, fetch: g.fetch, setTimer: fakeTimer().setTimer, clock: new FakeClock(1_000_000) }} />);
    await screen.findByText(/Model:/);
    expect(screen.queryByRole("heading", { name: "Report" })).toBeNull();
    expect(g.calls.some((c) => c.url.endsWith("/report"))).toBe(false);
  });
});

describe("ReportPanel: polling through a failed read, and progress announced", () => {
  it("a failed poll while evaluating keeps polling, and the next one recovers", async () => {
    let fail = false;
    const running = overview({ stage: "evaluating", confirm: null, job: job({ state: "running", startedAt: 1, progress: ["evaluating the team"] }) });
    const m = mount(running, (url, body) => (url === BASE && body === undefined && fail ? { status: 503, body: refused("unavailable", "x") } : undefined));
    expect(await screen.findByText("evaluating the team")).toBeTruthy();
    await waitFor(() => expect(m.timer.pending).toBe(1));
    fail = true;
    await act(async () => m.timer.fire());
    await waitFor(() => expect(reads(m)).toBe(2));
    expect(await screen.findByText("The report is unavailable. Try again.")).toBeTruthy();
    await waitFor(() => expect(m.timer.pending).toBe(1));
    fail = false;
    m.set(inReview());
    await act(async () => m.timer.fire());
    expect(await screen.findByText(/the review is open/)).toBeTruthy();
    expect(m.timer.pending).toBe(0);
  });

  it("the progress list is a polite live region that announces additions", async () => {
    mount(overview({ stage: "evaluating", confirm: null, job: job({ state: "running", startedAt: 1, progress: ["evaluating the team"] }) }));
    const list = (await screen.findByText("evaluating the team")).closest("ol")!;
    expect(list.getAttribute("aria-live")).toBe("polite");
    expect(list.getAttribute("aria-relevant")).toBe("additions");
  });
});

describe("ReportPanel: evaluationOk fails closed", () => {
  it("when the selected subject's row is missing from the overview, its view is scored by hand", async () => {
    const m = mount(inReview(), (url, body) => {
      if (url === `${BASE}/subjects/account_manager`) return { status: 200, body: ok(subjectView()) };
      if (url === `${BASE}/subjects/account_manager/accept` && body !== undefined) return { status: 200, body: ok({}) };
      return undefined;
    });
    typeName("kamal");
    fireEvent.click(await screen.findByRole("button", { name: "Review Account manager" }));
    expect(await screen.findByRole("button", { name: "Accept Clarity" })).toBeTruthy();
    // the next overview no longer lists the subject: its row (and its evaluationOk) is gone
    m.set(inReview([row("group")]));
    fireEvent.click(screen.getByRole("button", { name: "Accept the summary" }));
    expect(await screen.findByText("The evaluation failed for this subject: score each criterion by hand.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept Clarity" })).toBeNull();
  });
});
