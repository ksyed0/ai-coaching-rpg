// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SessionList } from "../console/SessionList";
import { fakeFetch, ok, refused } from "../../lib/__tests__/fakes";

afterEach(cleanup);

const ACCOUNTS = [
  { id: "acc_ann", login: "ann@example.com", name: "Ann Lee", role: "admin", status: "active", mustChange: false },
  { id: "acc_dana", login: "dana@example.com", name: "Dana Cook", role: "facilitator", status: "active", mustChange: false },
  { id: "acc_new", login: "new@example.com", name: "Nia Invited", role: "facilitator", status: "invited", mustChange: true },
  { id: "acc_old", login: "old@example.com", name: "Oli Revoked", role: "facilitator", status: "revoked", mustChange: false },
];
const SESSIONS = [
  { sessionId: "aaaaaaaa11111111", scenarioId: "launch_day", status: "running", owner: "acc_dana" },
  { sessionId: "bbbbbbbb22222222", scenarioId: "launch_day", status: "stopped" },
];

function mount(
  role: "admin" | "facilitator",
  ownerAnswer: { status: number; body: unknown } = { status: 200, body: ok({}) },
  sessions: unknown = SESSIONS,
  legacy = false,
) {
  const f = fakeFetch((url) => {
    if (url.endsWith("/owner")) return ownerAnswer;
    if (url.endsWith("/admin/accounts")) return { status: 200, body: ok({ accounts: ACCOUNTS }) };
    return { status: 200, body: ok(sessions) };
  });
  return { f, ...render(<SessionList fetch={f.fetch} role={role} legacy={legacy} />) };
}

describe("SessionList owners", () => {
  it("session_list_shows_owner_and_assign_for_admin_only", async () => {
    mount("admin");
    await screen.findByText("aaaaaaaa");
    expect(screen.getByRole("columnheader", { name: "Owner" })).toBeTruthy();
    const rows = screen.getAllByRole("row").slice(1);
    await waitFor(() => expect(rows[0]!.querySelector("td bdi")?.textContent).toBe("Dana Cook"));
    expect(rows[1]!.querySelector("td bdi")?.textContent).toBe("Unassigned");
    expect(screen.getAllByRole("button", { name: /^Assign session/ })).toHaveLength(2);
    cleanup();

    const f = mount("facilitator");
    await screen.findByText("aaaaaaaa");
    expect(screen.queryByRole("columnheader", { name: "Owner" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Assign/ })).toBeNull();
    expect(document.body.textContent).not.toContain("Dana Cook");
    expect(f.f.calls.some((c) => c.url.includes("/admin/accounts"))).toBe(false);
  });

  it("offers only active accounts and Unassigned, and posts the chosen owner then refreshes", async () => {
    const m = mount("admin");
    await screen.findByText("aaaaaaaa");
    const select = (await screen.findByLabelText("Owner of session bbbbbbbb")) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(3));
    expect([...select.options].map((o) => o.textContent)).toEqual(["Unassigned", "Ann Lee", "Dana Cook"]);
    fireEvent.change(select, { target: { value: "acc_ann" } });
    const before = m.f.calls.filter((c) => c.url.endsWith("/sessions")).length;
    fireEvent.click(screen.getByRole("button", { name: "Assign session bbbbbbbb" }));
    await waitFor(() => expect(m.f.calls.some((c) => c.url.endsWith("/sessions/bbbbbbbb22222222/owner"))).toBe(true));
    const post = m.f.calls.find((c) => c.url.endsWith("/owner"))!;
    expect(post.body).toEqual({ owner: "acc_ann" });
    await waitFor(() => expect(m.f.calls.filter((c) => c.url.endsWith("/sessions")).length).toBe(before + 1));
  });

  it("Unassigned sends owner null; a refusal is said plainly", async () => {
    const m = mount("admin", { status: 400, body: refused("invalid", "That account cannot own sessions.") });
    await screen.findByText("aaaaaaaa");
    const select = (await screen.findByLabelText("Owner of session aaaaaaaa")) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(3));
    fireEvent.change(select, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Assign session aaaaaaaa" }));
    await screen.findByText(/cannot own sessions|Something went wrong/);
    expect(m.f.calls.find((c) => c.url.endsWith("/owner"))!.body).toEqual({ owner: null });
  });

  for (const [status, label, owner] of [
    ["revoked", "Oli Revoked (revoked)", "acc_old"],
    ["invited", "Nia Invited (invited)", "acc_new"],
  ] as const) {
    it(`a session owned by a ${status} account shows that owner and can be unassigned or given to an active account`, async () => {
      const m = mount("admin", undefined, [{ sessionId: "dddddddd44444444", scenarioId: "x", status: "running", owner }]);
      const select = (await screen.findByLabelText("Owner of session dddddddd")) as HTMLSelectElement;
      await waitFor(() => expect(select.options.length).toBe(4));
      expect(select.options[select.selectedIndex]!.textContent).toBe(label);
      fireEvent.change(select, { target: { value: "" } });
      fireEvent.click(screen.getByRole("button", { name: "Assign session dddddddd" }));
      await waitFor(() => expect(m.f.calls.filter((c) => c.url.endsWith("/owner")).length).toBe(1));
      expect(m.f.calls.find((c) => c.url.endsWith("/owner"))!.body).toEqual({ owner: null });
      await waitFor(() => expect((screen.getByRole("button", { name: "Assign session dddddddd" }) as HTMLButtonElement).disabled).toBe(false));
      fireEvent.change(select, { target: { value: "acc_ann" } });
      fireEvent.click(screen.getByRole("button", { name: "Assign session dddddddd" }));
      await waitFor(() => expect(m.f.calls.filter((c) => c.url.endsWith("/owner")).length).toBe(2));
      expect(m.f.calls.filter((c) => c.url.endsWith("/owner"))[1]!.body).toEqual({ owner: "acc_ann" });
    });
  }

  it("an owner the accounts list does not know is shown as Unknown account", async () => {
    mount("admin", undefined, [{ sessionId: "eeeeeeee55555555", scenarioId: "x", status: "running", owner: "acc_gone" }]);
    const select = (await screen.findByLabelText("Owner of session eeeeeeee")) as HTMLSelectElement;
    await waitFor(() => expect(select.options[select.selectedIndex]!.textContent).toBe("Unknown account"));
  });

  it("a shared-secret (legacy) admin sees no Owner column, no Assign, makes no accounts call and gets no alert", async () => {
    const m = mount("admin", undefined, SESSIONS, true);
    await screen.findByText("aaaaaaaa");
    expect(screen.queryByRole("columnheader", { name: "Owner" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Assign/ })).toBeNull();
    expect(m.f.calls.some((c) => c.url.includes("/admin/accounts"))).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
