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
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
const answering = (status: number, body: unknown) =>
  fakeFetch(() => ({ status, body }));

describe("ConsoleLogin", () => {
  it("shows labelled secret and name fields, an error region (aria-live polite) and never echoes the secret", async () => {
    const f = answering(
      401,
      refused(
        "login_refused",
        "That did not work. Check the secret and the name and try again.",
      ),
    );
    const { container } = render(<ConsoleLogin fetch={f.fetch} />);
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
    render(<ConsoleLogin fetch={f.fetch} navigate={navigate} />);
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
    const { container } = render(<ConsoleLogin fetch={f.fetch} />);
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
    const { container } = render(<ConsoleLogin fetch={f.fetch} />);
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
    const second = render(<ConsoleLogin fetch={down} />);
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
