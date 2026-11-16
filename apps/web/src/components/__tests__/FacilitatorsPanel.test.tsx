// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FacilitatorsPanel } from "../console/admin/FacilitatorsPanel";
import { ConsoleShell } from "../console/ConsoleShell";
import { fakeFetch, ok, refused } from "../../lib/__tests__/fakes";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const acc = (id: string, name: string, status: string, role = "facilitator") => ({
  id, login: `${id}@example.com`, name, role, status, mustChange: status === "invited",
});
const ACCOUNTS = [
  acc("inv", "Ines Invited", "invited"),
  acc("act", "Aria Active", "active"),
  acc("rev", "Rex Revoked", "revoked"),
  acc("adm", "Ann Admin", "active", "admin"),
];
const PW = "Tmp-Pass-9xQ2-zebra";

type Answer = { status: number; body: unknown };
function mount(over: (url: string, body: unknown) => Answer | null = () => null) {
  const f = fakeFetch((url, body) => {
    const o = over(url, body);
    if (o) return o;
    if (/\/(resend|reset|reinstate|admin\/accounts)$/.test(url) && body !== undefined)
      return { status: 200, body: ok({ account: ACCOUNTS[0], temporaryPassword: PW }) };
    if (url.endsWith("/revoke")) return { status: 200, body: ok({}) };
    return { status: 200, body: ok({ accounts: ACCOUNTS }) };
  });
  return { f, ...render(<FacilitatorsPanel fetch={f.fetch} />) };
}
const row = (name: string) => screen.getByRole("row", { name: new RegExp(name) });
const rowButton = (who: string, label: string) => within(row(who)).getByRole("button", { name: `${label} ${who}` });
const actionNames = (name: string) => within(row(name)).queryAllByRole("button").map((b) => b.textContent);

describe("FacilitatorsPanel", () => {
  it("panel_shows_only_the_actions_allowed_for_each_status", async () => {
    mount();
    await screen.findByText("Ines Invited");
    expect(actionNames("Ines Invited")).toEqual(["Resend", "Revoke"]);
    expect(actionNames("Aria Active")).toEqual(["Reset password", "Revoke"]);
    expect(actionNames("Rex Revoked")).toEqual(["Reinstate"]);
    const r = row("Ines Invited");
    expect(within(r).getByText("ines@example.com".replace("ines", "inv"))).toBeTruthy();
    expect(within(r).getByText("Facilitator")).toBeTruthy();
    expect(within(r).getByText("Invited")).toBeTruthy();
    expect(within(row("Ann Admin")).getByText("Admin")).toBeTruthy();
  });

  it("revoke_asks_for_confirmation (and says running sessions keep running, reachable by the admin only)", async () => {
    const m = mount();
    await screen.findByText("Aria Active");
    fireEvent.click(rowButton("Aria Active", "Revoke"));
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toMatch(/running sessions keep running/);
    expect(dialog.textContent).toMatch(/only by an admin/);
    expect(m.f.calls.some((c) => c.url.endsWith("/revoke"))).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(m.f.calls.some((c) => c.url.endsWith("/revoke"))).toBe(false);
    fireEvent.click(rowButton("Aria Active", "Revoke"));
    const before = m.f.calls.filter((c) => c.init.method === "GET").length;
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(m.f.calls.some((c) => c.url.endsWith("/admin/accounts/act/revoke"))).toBe(true));
    await waitFor(() => expect(m.f.calls.filter((c) => c.init.method === "GET").length).toBe(before + 1));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("resend, reset and reinstate each confirm first and then show the new credentials once", async () => {
    const m = mount();
    await screen.findByText("Ines Invited");
    for (const [who, label, path] of [
      ["Ines Invited", "Resend", "/admin/accounts/inv/resend"],
      ["Aria Active", "Reset password", "/admin/accounts/act/reset"],
      ["Rex Revoked", "Reinstate", "/admin/accounts/rev/reinstate"],
    ] as const) {
      fireEvent.click(rowButton(who, label));
      expect(m.f.calls.some((c) => c.url.endsWith(path))).toBe(false);
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: label }));
      await waitFor(() => expect(m.f.calls.some((c) => c.url.endsWith(path))).toBe(true));
      await screen.findByText(PW);
      fireEvent.click(screen.getByRole("button", { name: "I have shared these" }));
      expect(document.body.textContent).not.toContain(PW);
    }
  });

  it("create_shows_credentials_once_then_clears_on_dismiss", async () => {
    const m = mount();
    await screen.findByText("Aria Active");
    expect((screen.getByLabelText("Role") as HTMLSelectElement).value).toBe("facilitator");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Dana Cook" } });
    fireEvent.change(screen.getByLabelText("Email (their login)"), { target: { value: "dana@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Create facilitator" }));
    await screen.findByText(PW);
    const post = m.f.calls.find((c) => c.init.method === "POST" && c.url.endsWith("/admin/accounts"))!;
    expect(post.body).toEqual({ login: "dana@example.com", name: "Dana Cook", role: "facilitator" });
    expect(document.body.textContent).toContain("Share these with Ines Invited. Shown once.");
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "I have shared these" }));
    expect(document.body.textContent).not.toContain(PW);
    expect(JSON.stringify({ ...localStorage, ...sessionStorage })).not.toContain(PW);
  });

  it("can create an Admin, needs a name and an email, and sends nothing when they are missing", async () => {
    const m = mount();
    await screen.findByText("Aria Active");
    fireEvent.click(screen.getByRole("button", { name: "Create facilitator" }));
    expect(screen.getByText(/Enter a name and an email/)).toBeTruthy();
    expect(m.f.calls.some((c) => c.init.method === "POST")).toBe(false);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Zed" } });
    fireEvent.change(screen.getByLabelText("Email (their login)"), { target: { value: "zed@example.com" } });
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "admin" } });
    fireEvent.click(screen.getByRole("button", { name: "Create facilitator" }));
    await waitFor(() => expect(m.f.calls.find((c) => c.init.method === "POST")?.body).toEqual({ login: "zed@example.com", name: "Zed", role: "admin" }));
  });

  it("says plainly what went wrong for a conflict, a closed session and an unreachable service, and keeps no password", async () => {
    const m = mount((url, body) =>
      url.endsWith("/admin/accounts") && body !== undefined
        ? { status: 409, body: refused("conflict", "An account with that login already exists.") }
        : url.endsWith("/act/revoke")
          ? { status: 409, body: refused("conflict", "That account cannot be revoked: it is the last active admin.") }
          : url.endsWith("/inv/resend")
            ? { status: 502, body: refused("launcher_unavailable", "x") }
            : null,
    );
    await screen.findByText("Aria Active");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Dup" } });
    fireEvent.change(screen.getByLabelText("Email (their login)"), { target: { value: "dup@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Create facilitator" }));
    await screen.findByText("An account with that login already exists.");
    fireEvent.click(rowButton("Aria Active", "Revoke"));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Revoke" }));
    await screen.findByText(/last active admin/);
    fireEvent.click(rowButton("Ines Invited", "Resend"));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Resend" }));
    await screen.findByText(/not reachable/);
    expect(screen.queryByText(PW)).toBeNull();
    expect(m.f.calls.length).toBeGreaterThan(0);
  });

  it("disables the buttons while an action is pending", async () => {
    const m = mount();
    await screen.findByText("Aria Active");
    m.f.hold();
    fireEvent.click(rowButton("Aria Active", "Reset password"));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Reset password" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "Create facilitator" }) as HTMLButtonElement).disabled).toBe(true));
    m.f.release();
    await screen.findByText(PW);
  });

  it("a load failure says so and offers Try again", async () => {
    let fail = true;
    const f = fakeFetch(() => (fail ? { status: 502, body: refused("launcher_unavailable", "x") } : { status: 200, body: ok({ accounts: ACCOUNTS }) }));
    render(<FacilitatorsPanel fetch={f.fetch} />);
    await screen.findByText(/not reachable/);
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Aria Active");
  });
});

describe("console header", () => {
  const shell = (role: "admin" | "facilitator", legacy = false) => {
    const f = fakeFetch(() => ({ status: 200, body: ok([]) }));
    return render(<ConsoleShell name="Ann" role={role} legacy={legacy} fetch={f.fetch} />);
  };
  it("non_admin_never_sees_the_admin_link_or_page", async () => {
    shell("admin");
    expect(screen.getByRole("link", { name: "Admin" }).getAttribute("href")).toBe("/console/admin");
    cleanup();
    shell("facilitator");
    expect(screen.queryByRole("link", { name: "Admin" })).toBeNull();
    cleanup();
    shell("admin", true); // a legacy shared-secret sign-in: the admin routes refuse it, so no link
    expect(screen.queryByRole("link", { name: "Admin" })).toBeNull();
  });
});
