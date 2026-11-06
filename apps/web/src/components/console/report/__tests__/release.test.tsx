// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeFetch, fakeTimer, ok, refused } from "../../../../lib/__tests__/fakes";
import { ReleaseDialog } from "../ReleaseDialog";
import { ReportPanel } from "../ReportPanel";
import { BASE, SID, inReview, row } from "./fixtures";

beforeEach(() => {
  try { sessionStorage.clear(); } catch { /* none */ }
});
afterEach(cleanup);

type Answer = (url: string, body: unknown) => { status: number; body: unknown } | undefined;
function mount(first: unknown, answer: Answer = () => undefined) {
  let current = first;
  const f = fakeFetch((url, body) => {
    const a = body === undefined ? undefined : answer(url, body);
    if (a) return a;
    if (url === BASE) return { status: 200, body: ok(current) };
    return { status: 404, body: refused("not_found", "x") };
  });
  render(<ReportPanel sessionId={SID} fetch={f.fetch} setTimer={fakeTimer().setTimer} />);
  return { f, set: (o: unknown) => { current = o; } };
}
const typeName = (v: string) => fireEvent.change(screen.getByLabelText("Your name for the review record"), { target: { value: v } });
const posts = (f: ReturnType<typeof fakeFetch>, path: string) => f.calls.filter((c) => c.init.method === "POST" && c.url === path);
const HINT = "The group's per-role table is now out of date; amend and re-release the group to refresh it.";
const AM_AUDIENCE = "Account manager (the participant this report is about)";
const GROUP_AUDIENCE = "Every participant, with the other participants' individual results removed";

describe("ReleaseDialog", () => {
  it("ReleaseDialog names each subject and its audience and lists the open items that block it", () => {
    render(
      <ReleaseDialog
        subjects={[
          { id: "account_manager", audience: [AM_AUDIENCE, "The facilitator"], blockers: ["Needs review: clarity"] },
          { id: "group", audience: [GROUP_AUDIENCE, "The facilitator"], blockers: [] },
        ]}
        name="kamal" pending={false} opener={null} error="" blocked={[]} onConfirm={() => {}} onCancel={() => {}}
      />,
    );
    const dialog = screen.getByRole("dialog");
    const items = within(dialog).getAllByRole("listitem").filter((li) => li.parentElement?.classList.contains("report-release-list"));
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText("Account manager")).toBeTruthy();
    expect(within(items[0]!).getByText(AM_AUDIENCE)).toBeTruthy();
    expect(within(items[0]!).getByText("The facilitator")).toBeTruthy();
    expect(within(items[0]!).getByText("Needs review: clarity")).toBeTruthy();
    expect(within(items[1]!).getByText("Group")).toBeTruthy();
    expect(within(items[1]!).getByText(GROUP_AUDIENCE)).toBeTruthy();
    // the inert audiences are never promised
    expect(dialog.textContent).not.toMatch(/line manager|L&D|\bHR\b|sponsor/i);
    expect(within(dialog).getByText("Recorded as: kamal")).toBeTruthy();
  });

  it("its confirm is disabled while any item blocks", () => {
    const onConfirm = vi.fn();
    const props = { name: "kamal", pending: false, opener: null, error: "", blocked: [], onConfirm, onCancel: () => {} };
    const { rerender } = render(<ReleaseDialog {...props} subjects={[{ id: "group", audience: [], blockers: ["Accept or edit the summary"] }, { id: "client", audience: [], blockers: [] }]} />);
    const confirm = screen.getByRole("button", { name: "Release" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
    rerender(<ReleaseDialog {...props} subjects={[{ id: "group", audience: [], blockers: [] }, { id: "client", audience: [], blockers: [] }]} />);
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("ReleaseBar and the release dialog in the panel", () => {
  const subjects = () => [
    row("account_manager"),
    row("client", { openCriteria: ["pace"] }),
    row("sales_lead", { state: "amending", version: 5 }),
    row("delivery_lead", { state: "released", version: 4 }),
    row("group"),
  ];

  it("release everything sends the full list, never an all flag", async () => {
    const m = mount(inReview(subjects()), (url) => (url === `${BASE}/release` ? { status: 200, body: ok({ released: ["account_manager", "sales_lead", "group"], groupTableStale: false }) } : undefined));
    typeName("kamal");
    const bar = await screen.findByRole("region", { name: "Release" });
    // a subject with open items has no checkbox to tick, and says why
    expect((within(bar).getByLabelText("Client") as HTMLInputElement).disabled).toBe(true);
    expect(within(bar).getByText("Not ready: Needs review: pace")).toBeTruthy();
    // a released subject is not offered again
    expect(within(bar).queryByLabelText("Delivery lead")).toBeNull();
    fireEvent.click(within(bar).getByRole("button", { name: "Release everything…" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Account manager")).toBeTruthy();
    expect(within(dialog).getByText("Sales lead")).toBeTruthy();
    expect(within(dialog).getByText("Group")).toBeTruthy();
    expect(within(dialog).queryByText("Client")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Release" }));
    await waitFor(() => expect(posts(m.f, `${BASE}/release`)).toHaveLength(1));
    const body = posts(m.f, `${BASE}/release`)[0]!.body as Record<string, unknown>;
    expect(body).toEqual({ subjects: ["account_manager", "sales_lead", "group"], by: "kamal" });
    expect(Object.keys(body)).not.toContain("all");
    expect(await screen.findByText("Released: Account manager, Sales lead, Group.")).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("release selected sends only the ticked subjects, and nothing is enabled without a valid name", async () => {
    const m = mount(inReview(subjects()), (url) => (url === `${BASE}/release` ? { status: 200, body: ok({ released: ["group"], groupTableStale: false }) } : undefined));
    const bar = await screen.findByRole("region", { name: "Release" });
    expect((within(bar).getByRole("button", { name: "Release everything…" }) as HTMLButtonElement).disabled).toBe(true);
    typeName("kamal");
    const selected = within(bar).getByRole("button", { name: "Release selected…" }) as HTMLButtonElement;
    expect(selected.disabled).toBe(true);
    fireEvent.click(within(bar).getByLabelText("Group"));
    expect(selected.disabled).toBe(false);
    fireEvent.click(selected);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Release" }));
    await waitFor(() => expect(posts(m.f, `${BASE}/release`)).toHaveLength(1));
    expect(posts(m.f, `${BASE}/release`)[0]!.body).toEqual({ subjects: ["group"], by: "kamal" });
  });

  it("after a blocked refusal the dialog stays open, lists the blocked subjects and the open items, and its confirm is disabled", async () => {
    const m = mount(inReview(subjects()), (url) => (url === `${BASE}/release` ? { status: 409, body: { ...refused("blocked", "SERVER TEXT"), data: { blocked: ["group"] } } } : undefined));
    typeName("kamal");
    const bar = await screen.findByRole("region", { name: "Release" });
    // another tab changed the group meanwhile: the next overview shows its stale summary
    m.set(inReview([row("account_manager"), row("client", { openCriteria: ["pace"] }), row("sales_lead", { state: "amending", version: 5 }), row("delivery_lead", { state: "released", version: 4 }), row("group", { summaryStale: true })]));
    fireEvent.click(within(bar).getByRole("button", { name: "Release everything…" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Release" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Some reports still have open items. Resolve them, then try again.")).toBeTruthy();
    expect(within(dialog).getByText("Blocked: Group")).toBeTruthy();
    expect(await within(dialog).findByText("Accept or edit the summary")).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "Release" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("SERVER TEXT")).toBeNull();
  });

  it("the group-table hint is shown after a release or withdraw leaves the released group's row stale", async () => {
    const m = mount(inReview([row("account_manager"), row("group", { state: "released", version: 3 })]), (url) => {
      if (url !== `${BASE}/release`) return undefined;
      m.set(inReview([row("account_manager", { state: "released", version: 4 }), row("group", { state: "released", version: 3, tableStale: true })]));
      return { status: 200, body: ok({ released: ["account_manager"], groupTableStale: true }) };
    });
    typeName("kamal");
    const bar = await screen.findByRole("region", { name: "Release" });
    expect(screen.queryByText(HINT)).toBeNull();
    fireEvent.click(within(bar).getByRole("button", { name: "Release everything…" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Release" }));
    expect(await screen.findByText(HINT)).toBeTruthy();
    cleanup();

    const n = mount(inReview([row("account_manager", { state: "released", version: 4 }), row("group", { state: "released", version: 3 })]), (url) => {
      if (url !== `${BASE}/subjects/account_manager/withdraw`) return undefined;
      n.set(inReview([row("account_manager", { state: "withdrawn", version: 4 }), row("group", { state: "released", version: 3, tableStale: true })]));
      return { status: 200, body: ok({ groupTableStale: true }) };
    });
    typeName("kamal");
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw Account manager" }));
    fireEvent.change(screen.getByLabelText("Reason for withdrawing (required)"), { target: { value: "Recorded against the wrong person." } });
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Withdraw" }));
    await waitFor(() => expect(posts(n.f, `${BASE}/subjects/account_manager/withdraw`)).toHaveLength(1));
    expect(posts(n.f, `${BASE}/subjects/account_manager/withdraw`)[0]!.body).toEqual({ reason: "Recorded against the wrong person.", by: "kamal" });
    expect(await screen.findByText(HINT)).toBeTruthy();
    expect(screen.getByText("The report was withdrawn.")).toBeTruthy();
  });
});
