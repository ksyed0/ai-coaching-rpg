// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialsPanel } from "../console/admin/CredentialsPanel";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const PW = "Tmp-Pass-9xQ2-zebra";
const props = { login: "dana@example.com", name: "Dana Cook", temporaryPassword: PW };

describe("CredentialsPanel", () => {
  it("says who to share with, shows the login and password as inert text, with Copy buttons", () => {
    const { container } = render(
      <CredentialsPanel login="<img src=x onerror=alert(1)>" name="<b>Dana</b>" temporaryPassword="<script>alert(1)</script>" onDismiss={vi.fn()} />,
    );
    expect(document.body.textContent).toContain("Share these with <b>Dana</b>. Shown once.");
    expect(container.querySelector("img, b, script")).toBeNull();
    expect(screen.getByText("<script>alert(1)</script>").tagName).toBe("CODE");
    expect(screen.getByRole("button", { name: "Copy login" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy temporary password" })).toBeTruthy();
  });

  it("credentials_never_in_storage_or_url_and_gone_after_remount", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const push = vi.spyOn(window.history, "pushState");
    const replace = vi.spyOn(window.history, "replaceState");
    const before = window.location.href;
    const first = render(<CredentialsPanel {...props} onDismiss={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy temporary password" }));
    expect(setItem).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(window.location.href).toBe(before);
    expect(JSON.stringify({ ...localStorage })).not.toContain(PW);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(PW);
    expect(document.cookie).not.toContain(PW);
    first.unmount();
    expect(document.body.textContent).not.toContain(PW);
  });

  it("removes the password from the DOM on dismiss and tells the parent", () => {
    const onDismiss = vi.fn();
    const { container } = render(<CredentialsPanel {...props} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "I have shared these" }));
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(container.innerHTML).not.toContain(PW);
    expect(document.body.textContent).not.toContain(PW);
  });

  it("copies with the clipboard and says so; says plainly when the clipboard is unavailable or refuses", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<CredentialsPanel {...props} onDismiss={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy login" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("dana@example.com"));
    await screen.findByText("Copied.");
    writeText.mockRejectedValueOnce(new Error("blocked"));
    fireEvent.click(screen.getByRole("button", { name: "Copy temporary password" }));
    await screen.findByText(/Could not copy the password/);
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    fireEvent.click(screen.getByRole("button", { name: "Copy login" }));
    await screen.findByText(/Could not copy the login/);
  });
});
