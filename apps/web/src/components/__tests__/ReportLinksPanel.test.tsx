// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseReportLinks } from "../../lib/console-api";
import { ReportLinksPanel } from "../console/ReportLinksPanel";
import { SessionConsole } from "../console/SessionConsole";
import { FakeClock, FakeEventSource, fakeFetch, fakeTimer, ok, readiness, refused } from "../../lib/__tests__/fakes";
import type { EventSourceCtor } from "../../lib/use-session";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SID = "abcd1234efgh5678";
const BASE = `/api/v1/console/sessions/${SID}/report-links`;
const NOT_READY = "No reports are ready for this session yet. Run evaluate and moderate open, from the terminal (see the guide).";
const TOKEN = "AbCdEfGh.SECRETsecretSECRETsecret";
const LINK = `${window.location.origin}/report/enter#${TOKEN}`;

const cred = (over: Record<string, unknown> = {}) => ({
  role: "x", createdAt: 1_700_000_000_000, expiresAt: 4_000_000_000_000, active: true, revoked: false, ...over,
});
const view = (state: string, roles: unknown[]) => ({ state, roles });
const READY = view("ready", [
  { role: "delivery_lead", credential: null },
  { role: "account_manager", credential: cred({ lastUsedAt: 1_700_000_500_000 }) },
  { role: "sales_lead", credential: cred() },
]);

type Route = (body: unknown) => { status: number; body: unknown };
function mount(list: unknown, routes: Record<string, Route> = {}) {
  const f = fakeFetch((url, body) => {
    const r = routes[`${url}`];
    if (r && body !== undefined) return r(body);
    if (url === BASE) return { status: 200, body: ok(list) };
    return { status: 404, body: refused("not_found", "x") };
  });
  const r = render(<ReportLinksPanel sessionId={SID} fetch={f.fetch} />);
  return { ...r, f };
}
const posts = (m: ReturnType<typeof mount>) => m.f.calls.filter((c) => c.init.method === "POST");

describe("ReportLinksPanel", () => {
  it("is a labelled section with an h2 and shows each role's status and last use", async () => {
    mount(READY);
    await screen.findAllByText("Link active until", { exact: false });
    const h = screen.getByRole("heading", { level: 2, name: "Participant reports" });
    expect(h.closest("section")?.getAttribute("aria-labelledby")).toBe(h.id);
    expect(screen.getByText("No link")).toBeTruthy();
    expect(screen.getByText(/^Last opened /)).toBeTruthy();
    expect(screen.getByText("Not opened yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Issue link for Delivery lead" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reissue link for Account manager" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Revoke link for Account manager" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Issue link for Account manager" })).toBeNull();
  });

  it("shows a revoked link as Revoked with an Issue button", async () => {
    mount(view("ready", [{ role: "delivery_lead", credential: cred({ active: false, revoked: true }) }]));
    expect(await screen.findByText("Revoked")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Issue link for Delivery lead" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Revoke link/ })).toBeNull();
  });

  it("issues a link, shows it once as origin/report/enter#token in a read-only input, and copies it", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const m = mount(READY, { [BASE]: () => ({ status: 200, body: ok({ role: "delivery_lead", token: TOKEN, credential: cred() }) }) });
    fireEvent.click(await screen.findByRole("button", { name: "Issue link for Delivery lead" }));
    const input = (await screen.findByLabelText(/link for Delivery lead/i, { selector: "input" })) as HTMLInputElement;
    expect(input.readOnly).toBe(true);
    expect(input.value).toBe(LINK);
    expect(screen.getByText("This link is shown only once. Anyone who has it can read this participant's report.")).toBeTruthy();
    expect(posts(m)[0]!.body).toEqual({ role: "delivery_lead" });
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(LINK));
    expect((await screen.findAllByText("Copied.")).length).toBeGreaterThan(0);
  });

  it("drops a shown link when the page is hidden for good (pagehide), so a restored page does not show it again", async () => {
    mount(READY, { [BASE]: () => ({ status: 200, body: ok({ role: "delivery_lead", token: TOKEN, credential: cred() }) }) });
    fireEvent.click(await screen.findByRole("button", { name: "Issue link for Delivery lead" }));
    await screen.findByLabelText(/link for Delivery lead/i, { selector: "input" });
    act(() => { window.dispatchEvent(new Event("pagehide")); });
    expect(screen.queryByLabelText(/link for Delivery lead/i, { selector: "input" })).toBeNull();
    expect(document.body.textContent).not.toContain(TOKEN);
  });

  it("falls back to selecting the text when the clipboard is unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    mount(READY, { [BASE]: () => ({ status: 200, body: ok({ role: "delivery_lead", token: TOKEN, credential: cred() }) }) });
    fireEvent.click(await screen.findByRole("button", { name: "Issue link for Delivery lead" }));
    await screen.findByLabelText(/link for Delivery lead/i, { selector: "input" });
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    expect(await screen.findByText(/Press Ctrl\/Cmd\+C/)).toBeTruthy();
  });

  it("removes the link from the DOM after dismissal and never writes it to storage, the URL or the console", async () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const log = vi.spyOn(console, "log");
    const err = vi.spyOn(console, "error");
    const warn = vi.spyOn(console, "warn");
    const before = window.location.href;
    const m = mount(READY, { [BASE]: () => ({ status: 200, body: ok({ role: "delivery_lead", token: TOKEN, credential: cred() }) }) });
    fireEvent.click(await screen.findByRole("button", { name: "Issue link for Delivery lead" }));
    await screen.findByLabelText(/link for Delivery lead/i, { selector: "input" });
    expect(document.body.innerHTML).toContain("SECRETsecret");
    fireEvent.click(screen.getByRole("button", { name: "I have copied the link" }));
    expect(document.body.innerHTML).not.toContain("SECRETsecret");
    expect(setItem).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(JSON.stringify({ ...localStorage })).not.toContain("SECRET");
    expect(JSON.stringify({ ...sessionStorage })).not.toContain("SECRET");
    expect(window.location.href).toBe(before);
    expect(m.f.calls.every((c) => !c.url.includes("SECRET"))).toBe(true);
  });

  it("reissue asks first, does nothing on Cancel, and on confirm shows the new link", async () => {
    const m = mount(READY, { [`${BASE}/account_manager`]: () => ({ status: 200, body: ok({ role: "account_manager", token: TOKEN, credential: cred() }) }) });
    const btn = await screen.findByRole("button", { name: "Reissue link for Account manager" });
    fireEvent.click(btn);
    const dlg = await screen.findByRole("dialog");
    expect(dlg.textContent).toMatch(/old link stops working at once/i);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(posts(m)).toHaveLength(0);
    await waitFor(() => expect(document.activeElement).toBe(btn));
    fireEvent.click(btn);
    fireEvent.click(await screen.findByRole("button", { name: "Reissue link" }));
    const input = (await screen.findByLabelText(/link for Account manager/i, { selector: "input" })) as HTMLInputElement;
    expect(input.value).toBe(LINK);
    expect(posts(m)).toHaveLength(1);
    expect(posts(m)[0]!.url).toBe(`${BASE}/account_manager`);
    expect(posts(m)[0]!.body).toEqual({ action: "reissue" });
  });

  it("revoke asks first, does nothing on Cancel, and on confirm posts revoke and says so", async () => {
    const m = mount(READY, { [`${BASE}/account_manager`]: () => ({ status: 200, body: ok({ role: "account_manager", revoked: true }) }) });
    const btn = await screen.findByRole("button", { name: "Revoke link for Account manager" });
    fireEvent.click(btn);
    expect((await screen.findByRole("dialog")).textContent).toMatch(/loses access to their report at once/i);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(posts(m)).toHaveLength(0);
    fireEvent.click(btn);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke link" }));
    await waitFor(() => expect(posts(m)).toHaveLength(1));
    expect(posts(m)[0]!.body).toEqual({ action: "revoke" });
    expect(await screen.findByText("The link for Account manager was revoked.")).toBeTruthy();
  });

  it("not_ready shows the exact sentence and only Revoke for an existing link (withdrawn report)", async () => {
    mount(view("not_ready", [{ role: "account_manager", credential: cred() }]));
    expect(await screen.findByText(NOT_READY)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Revoke link for Account manager" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^(Issue|Reissue) link/ })).toBeNull();
  });

  it("not_ready with no roles shows the sentence and no buttons", async () => {
    mount(view("not_ready", []));
    expect(await screen.findByText(NOT_READY)).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("unavailable shows the exact sentence and Try again reloads", async () => {
    const answers = [view("unavailable", []), READY];
    const f = fakeFetch(() => ({ status: 200, body: ok(answers.shift() ?? READY) }));
    render(<ReportLinksPanel sessionId={SID} fetch={f.fetch} />);
    expect(await screen.findByText("The reports for this session cannot be read. Check them with moderate status.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Issue link for Delivery lead" })).toBeTruthy();
  });

  it("an issue 409 shows the passed-through sentence inline and no link", async () => {
    mount(READY, { [BASE]: () => ({ status: 409, body: refused("conflict", "A link is already active for this role.") }) });
    fireEvent.click(await screen.findByRole("button", { name: "Issue link for Delivery lead" }));
    expect(await screen.findByText("A link is already active for this role.")).toBeTruthy();
    expect(document.querySelector("input[readonly]")).toBeNull();
  });

  it("a failed list call says the session service cannot be reached", async () => {
    const f = fakeFetch(() => ({ status: 503, body: refused("unavailable", "x") }));
    render(<ReportLinksPanel sessionId={SID} fetch={f.fetch} />);
    expect(await screen.findByText(/not reachable/i)).toBeTruthy();
  });

  it("ignores any extra fields in the DTO (no credential id is needed or shown)", async () => {
    mount(view("ready", [{ role: "delivery_lead", credential: cred({ id: "SHOULD-NOT-SHOW" }) }]));
    await screen.findByText("Link active until", { exact: false });
    expect(document.body.textContent).not.toContain("SHOULD-NOT-SHOW");
  });

  it("unavailable still lists live links with Revoke (confirmed) and no Issue or Reissue", async () => {
    const m = mount(view("unavailable", [{ role: "account_manager", credential: cred() }, { role: "delivery_lead", credential: null }]), {
      [`${BASE}/account_manager`]: () => ({ status: 200, body: ok({ role: "account_manager", revoked: true }) }),
    });
    expect(await screen.findByText("The reports for this session cannot be read. Check them with moderate status.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^(Issue|Reissue) link/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Revoke link for Account manager" }));
    expect(posts(m)).toHaveLength(0);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke link" }));
    await waitFor(() => expect(posts(m)).toHaveLength(1));
    expect(posts(m)[0]!.body).toEqual({ action: "revoke" });
  });

  it("while a link is shown every action is disabled with a hint; dismissal enables them and returns focus", async () => {
    mount(READY, { [BASE]: () => ({ status: 200, body: ok({ role: "delivery_lead", token: TOKEN, credential: cred() }) }) });
    fireEvent.click(await screen.findByRole("button", { name: "Issue link for Delivery lead" }));
    await screen.findByLabelText(/link for Delivery lead/i, { selector: "input" });
    expect(await screen.findByText("Link for Delivery lead created. Copy it now.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Copy link" })));
    expect(screen.getByText("Copy or dismiss the link above first.")).toBeTruthy();
    const actions = () => screen.getAllByRole("button", { name: /^(Issue|Reissue|Revoke) link for/ }) as HTMLButtonElement[];
    expect(actions().length).toBeGreaterThan(2);
    expect(actions().every((b) => b.disabled)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "I have copied the link" }));
    expect(actions().every((b) => !b.disabled)).toBe(true);
    expect(screen.queryByText("Copy or dismiss the link above first.")).toBeNull();
    const row = screen.getByRole("heading", { name: "Delivery lead" }).closest("li")!;
    expect(row.contains(document.activeElement)).toBe(true);
  });

  it("the shown link input is not autofilled or spell-checked", async () => {
    mount(READY, { [BASE]: () => ({ status: 200, body: ok({ role: "delivery_lead", token: TOKEN, credential: cred() }) }) });
    fireEvent.click(await screen.findByRole("button", { name: "Issue link for Delivery lead" }));
    const input = await screen.findByLabelText(/link for Delivery lead/i, { selector: "input" });
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect(input.getAttribute("spellcheck")).toBe("false");
  });
});

describe("SessionConsole and the report links panel", () => {
  const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
  function mountConsole(r: unknown) {
    FakeEventSource.reset();
    const f = fakeFetch((url) => {
      if (url.endsWith("/readiness")) return { status: 200, body: ok(r) };
      if (url.endsWith("/report-links")) return { status: 200, body: ok(READY) };
      return { status: 200, body: ok({}) };
    });
    render(
      <SessionConsole sessionId={SID} deps={{ EventSource: FakeEventSource as unknown as EventSourceCtor, fetch: f.fetch, setTimer: fakeTimer().setTimer, clock: new FakeClock(1_000_000) }} />,
    );
    return f;
  }

  it("is absent while the session is live", async () => {
    const f = mountConsole(readiness({ status: "running" }));
    await screen.findByText(/Model:/);
    await flush();
    expect(screen.queryByRole("heading", { name: "Participant reports" })).toBeNull();
    expect(f.calls.some((c) => c.url.endsWith("/report-links"))).toBe(false);
  });

  it("is shown once the session has ended", async () => {
    mountConsole(readiness({ launcherStatus: "ended", status: "ended" }));
    expect(await screen.findByRole("heading", { name: "Participant reports" })).toBeTruthy();
  });
});

describe("ReportLinksPanel: who has rated", () => {
  const WARN = "Releasing a report closes self-rating for that player. Check that everyone has rated first.";
  const ALLOWS = "Before release the link lets the player rate themselves. After release it shows their report and lets them respond.";
  const RESOLVE = "A facilitator's reason for resolving a dispute is shown to the participant.";
  const DRAFTS = { state: "ready", players: { rated: 1, total: 2 }, roles: [
    { role: "delivery_lead", credential: null, selfRated: { rated: 3, total: 5 } },
    { role: "account_manager", credential: cred(), selfRated: { rated: 0, total: 5 } },
    { role: "sales_lead", credential: cred({ lastUsedAt: 1_700_000_500_000 }), selfRated: null },
  ] };

  it('draft roles are listed with "Rated k of n criteria"; the header shows "x of y players have rated"', async () => {
    mount(DRAFTS);
    expect(await screen.findByText("Rated 3 of 5 criteria")).toBeTruthy();
    expect(screen.getByText("Rated 0 of 5 criteria")).toBeTruthy();
    expect(screen.getByText("1 of 2 players have rated")).toBeTruthy();
    expect(screen.getByText(/^Last opened /)).toBeTruthy();
  });

  it('selfRated:null with unreadable progress shows "Rating progress not available"; readable progress leaves released roles alone', async () => {
    const { unmount } = mount({ state: "ready", players: null, roles: [{ role: "delivery_lead", credential: null, selfRated: null }] });
    expect(await screen.findByText("Rating progress not available")).toBeTruthy();
    expect(screen.queryByText(/players have rated/)).toBeNull();
    unmount();
    mount({ state: "ready", players: { rated: 0, total: 0 }, roles: [{ role: "delivery_lead", credential: null, selfRated: null }] });
    await screen.findByText("Delivery lead");
    expect(screen.queryByText("Rating progress not available")).toBeNull();
  });

  it("a warning says releasing closes self-rating, shown only while any role is a draft", async () => {
    const { unmount } = mount(DRAFTS);
    expect(await screen.findByText(WARN)).toBeTruthy();
    unmount();
    mount({ state: "ready", players: { rated: 0, total: 0 }, roles: [{ role: "delivery_lead", credential: null, selfRated: null }] });
    await screen.findByText("Delivery lead");
    expect(screen.queryByText(WARN)).toBeNull();
  });

  it("copy says the link works for rating before release and for responses after; the resolve reason is shown to the participant", async () => {
    mount(DRAFTS);
    expect(await screen.findByText(ALLOWS)).toBeTruthy();
    expect(screen.getByText(RESOLVE)).toBeTruthy();
  });

  it("issue on a draft role still shows the token once", async () => {
    mount(DRAFTS, { [BASE]: () => ({ status: 200, body: ok({ role: "delivery_lead", token: TOKEN, credential: cred() }) }) });
    fireEvent.click(await screen.findByRole("button", { name: "Issue link for Delivery lead" }));
    const input = (await screen.findByLabelText(/link for Delivery lead/i, { selector: "input" })) as HTMLInputElement;
    expect(input.value).toBe(LINK);
    fireEvent.click(screen.getByRole("button", { name: "I have copied the link" }));
    expect(document.body.innerHTML).not.toContain("SECRETsecret");
  });
});

describe("parseReportLinks: rating progress", () => {
  const base = (over: Record<string, unknown>) => ({ state: "ready", roles: [{ role: "a", credential: null, selfRated: { rated: 1, total: 2 } }], ...over });
  it("carries well-formed selfRated and players", () => {
    const v = parseReportLinks(base({ players: { rated: 1, total: 3 } }));
    expect(v?.players).toEqual({ rated: 1, total: 3 });
    expect(v?.roles[0]?.selfRated).toEqual({ rated: 1, total: 2 });
  });
  it.each([
    [{ rated: -1, total: 2 }], [{ rated: 1.5, total: 2 }], [{ rated: 3, total: 2 }], [{ rated: "1", total: 2 }], [{ rated: 1 }], ["x"], [[]], [NaN],
  ])("treats malformed %j as null without throwing", (bad) => {
    const v = parseReportLinks({ state: "ready", players: bad, roles: [{ role: "a", credential: null, selfRated: bad }] });
    expect(v?.players).toBeNull();
    expect(v?.roles[0]?.selfRated).toBeNull();
  });
  it("treats absent fields as null", () => {
    const v = parseReportLinks({ state: "ready", roles: [{ role: "a", credential: null }] });
    expect(v?.players).toBeNull();
    expect(v?.roles[0]?.selfRated).toBeNull();
  });
});
