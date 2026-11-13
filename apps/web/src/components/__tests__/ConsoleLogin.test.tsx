// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsoleDisabled } from "../console/ConsoleDisabled";
import { ConsoleLogin } from "../console/ConsoleLogin";
import { ConsoleShell } from "../console/ConsoleShell";
import { fakeFetch, ok, refused } from "../../lib/__tests__/fakes";

afterEach(cleanup);

const SECRET = "a-very-secret-facilitator-value";
const fill = (secret: string, name: string) => {
  fireEvent.change(screen.getByLabelText("Facilitator secret"), {
    target: { value: secret },
  });
  fireEvent.change(screen.getByLabelText("Your name"), {
    target: { value: name },
  });
};
const submit = () =>
  fireEvent.click(screen.getByRole("button", { name: "Sign in with the secret" }));
const answering = (status: number, body: unknown) =>
  fakeFetch(() => ({ status, body }));

const PASSWORD = "correct horse battery";
const fillAccount = (login: string, password: string) => {
  fireEvent.change(screen.getByLabelText("Login"), { target: { value: login } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: password } });
};
const signIn = () => fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
const region = (c: HTMLElement) => c.querySelector("[aria-live=polite]")!;

describe("ConsoleLogin (accounts)", () => {
  it("login_form_posts_login_and_password", async () => {
    const f = answering(200, ok({ name: "Ann", role: "facilitator", mustChange: false }));
    const navigate = vi.fn();
    render(<ConsoleLogin legacyAllowed={false} fetch={f.fetch} navigate={navigate} />);
    const pw = screen.getByLabelText("Password") as HTMLInputElement;
    expect(pw.type).toBe("password");
    expect(pw.getAttribute("autocomplete")).toBe("current-password");
    expect(screen.getByLabelText("Login").getAttribute("autocomplete")).toBe("username");
    fillAccount("  ann  ", PASSWORD);
    signIn();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/console"));
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("/api/v1/console/login");
    expect(f.calls[0]!.body).toEqual({ login: "ann", password: PASSWORD });
  });

  it("a mustChange sign-in goes straight to the password page", async () => {
    const f = answering(200, ok({ name: "Ann", role: "facilitator", mustChange: true }));
    const navigate = vi.fn();
    render(<ConsoleLogin legacyAllowed={false} fetch={f.fetch} navigate={navigate} />);
    fillAccount("ann", PASSWORD);
    signIn();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/console/password"));
  });

  it("empty fields send nothing", () => {
    const f = answering(200, ok({}));
    const { container } = render(<ConsoleLogin legacyAllowed={false} fetch={f.fetch} />);
    signIn();
    expect(region(container).textContent).toMatch(/login/i);
    fillAccount("ann", "");
    signIn();
    expect(region(container).textContent).toMatch(/password/i);
    expect(f.calls).toHaveLength(0);
  });

  it("refused_login_shows_the_neutral_message", async () => {
    const f = answering(401, refused("login_refused", "x"));
    const { container } = render(<ConsoleLogin legacyAllowed={false} fetch={f.fetch} />);
    fillAccount("ann", PASSWORD);
    signIn();
    await waitFor(() =>
      expect(region(container).textContent).toBe("That did not work. Check the login and the password and try again."),
    );
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
  });

  it("expired_temporary_password_shows_ask_the_admin_to_resend", async () => {
    const f = answering(401, refused("login_expired", "x"));
    const { container } = render(<ConsoleLogin legacyAllowed={false} fetch={f.fetch} />);
    fillAccount("ann", PASSWORD);
    signIn();
    await waitFor(() =>
      expect(region(container).textContent).toBe("This temporary password has expired. Ask an admin to resend it."),
    );
  });

  it("throttled and unreachable read plainly", async () => {
    const f = answering(429, refused("rate_limited", "x"));
    const { container } = render(<ConsoleLogin legacyAllowed={false} fetch={f.fetch} />);
    fillAccount("ann", PASSWORD);
    signIn();
    await waitFor(() => expect(region(container).textContent).toMatch(/Too many attempts/));
    cleanup();
    const g = answering(502, refused("launcher_unavailable", "x"));
    const second = render(<ConsoleLogin legacyAllowed={false} fetch={g.fetch} />);
    fillAccount("ann", PASSWORD);
    signIn();
    await waitFor(() => expect(region(second.container).textContent).toMatch(/cannot be reached/));
  });

  it("disables submit while pending", async () => {
    const f = answering(200, ok({ mustChange: false }));
    f.hold();
    render(<ConsoleLogin legacyAllowed={false} fetch={f.fetch} navigate={vi.fn()} />);
    fillAccount("ann", PASSWORD);
    signIn();
    await waitFor(() => expect((screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement).disabled).toBe(true));
    f.release();
  });

  it("the shared secret disclosure appears only while legacy sign-in is allowed", () => {
    const on = render(<ConsoleLogin legacyAllowed fetch={answering(200, ok({})).fetch} />);
    expect(screen.getByText("Use the shared secret instead")).toBeTruthy();
    on.unmount();
    render(<ConsoleLogin legacyAllowed={false} fetch={answering(200, ok({})).fetch} />);
    expect(screen.queryByText("Use the shared secret instead")).toBeNull();
    expect(screen.queryByLabelText("Facilitator secret")).toBeNull();
  });

  it("passwords_never_in_storage_or_url", async () => {
    const f = answering(401, refused("login_refused", "x"));
    const { container } = render(<ConsoleLogin legacyAllowed={false} fetch={f.fetch} />);
    fillAccount("ann", PASSWORD);
    signIn();
    await waitFor(() => expect(region(container).textContent).toMatch(/did not work/));
    expect(JSON.stringify({ ...localStorage })).not.toContain(PASSWORD);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(PASSWORD);
    expect(window.location.href).not.toContain(PASSWORD);
    expect(container.querySelector("form")!.getAttribute("method")).toBe("post");
    expect(container.innerHTML).not.toContain(PASSWORD);
  });
});

describe("ConsoleLogin (shared secret)", () => {
  it("shows labelled secret and name fields, an error region (aria-live polite) and never echoes the secret", async () => {
    const f = answering(
      401,
      refused(
        "login_refused",
        "That did not work. Check the secret and the name and try again.",
      ),
    );
    const { container } = render(<ConsoleLogin legacyAllowed fetch={f.fetch} />);
    const secret = screen.getByLabelText(
      "Facilitator secret",
    ) as HTMLInputElement;
    expect(secret.type).toBe("password");
    expect(secret.getAttribute("autocomplete")).toBe("off");
    expect(screen.getByLabelText("Your name")).toBeTruthy();
    const region = container.querySelector("[aria-live=polite]");
    expect(region).not.toBeNull();
    fill(SECRET, "Ann");
    submit();
    await waitFor(() =>
      expect(region!.textContent).toContain("That did not work"),
    );
    expect(container.innerHTML).not.toContain(SECRET);
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("posts the secret and trimmed name once with the CSRF header, then goes to /console", async () => {
    const f = answering(200, ok({ name: "Ann" }));
    const navigate = vi.fn();
    render(<ConsoleLogin legacyAllowed fetch={f.fetch} navigate={navigate} />);
    fill(SECRET, "  Ann  ");
    submit();
    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/console"));
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("/api/v1/console/login");
    expect(f.calls[0]!.init.headers).toMatchObject({
      "X-Requested-With": "scenecoach",
    });
    expect(f.calls[0]!.body).toEqual({ secret: SECRET, name: "Ann" });
  });

  it("requires a non-empty name and a secret before it sends anything", () => {
    const f = answering(200, ok({}));
    const { container } = render(<ConsoleLogin legacyAllowed fetch={f.fetch} />);
    fill(SECRET, "   ");
    submit();
    expect(container.querySelector("[aria-live=polite]")!.textContent).toMatch(
      /name/i,
    );
    fill("", "Ann");
    submit();
    expect(container.querySelector("[aria-live=polite]")!.textContent).toMatch(
      /secret/i,
    );
    expect(f.calls).toHaveLength(0);
  });

  it("clears the secret after a refusal; throttling and an unreachable server read plainly", async () => {
    const f = answering(
      429,
      refused(
        "rate_limited",
        "Too many attempts. Wait a minute and try again.",
      ),
    );
    const { container } = render(<ConsoleLogin legacyAllowed fetch={f.fetch} />);
    fill(SECRET, "Ann");
    submit();
    const region = container.querySelector("[aria-live=polite]")!;
    await waitFor(() =>
      expect(region.textContent).toMatch(/Too many attempts/),
    );
    expect(
      (screen.getByLabelText("Facilitator secret") as HTMLInputElement).value,
    ).toBe("");
    cleanup();

    const down = vi.fn(async () => {
      throw new TypeError("offline");
    }) as unknown as typeof fetch;
    const second = render(<ConsoleLogin legacyAllowed fetch={down} />);
    fill(SECRET, "Ann");
    submit();
    await waitFor(() =>
      expect(
        second.container.querySelector("[aria-live=polite]")!.textContent,
      ).toMatch(/cannot be reached/),
    );
  });
});

describe("ConsoleDisabled", () => {
  it("the disabled configuration renders the generic message and no form", () => {
    const { container } = render(<ConsoleDisabled />);
    expect(
      screen.getByText("The console is not set up on this server."),
    ).toBeTruthy();
    expect(container.querySelector("form, input, button")).toBeNull();
    expect(container.textContent).not.toMatch(/FACILITATOR_SECRET|LAUNCHER/);
  });
});

describe("ConsoleShell", () => {
  it("says who is signed in, as text, with the empty state and a sign-out button", async () => {
    const XSS = `<img src=x onerror="alert(1)">`;
    const f = answering(200, ok({}));
    const refresh = vi.fn();
    const { container } = render(
      <ConsoleShell name={XSS} fetch={f.fetch} refresh={refresh} />,
    );
    expect(screen.getByText(`Signed in as ${XSS}`)).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
    expect(await screen.findByText("No sessions yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const logout = f.calls.find((c) => c.url === "/api/v1/console/logout")!;
    expect(logout.init.method).toBe("POST");
  });
});
