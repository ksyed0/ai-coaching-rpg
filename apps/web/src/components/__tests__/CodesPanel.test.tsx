// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodesPanel } from "../console/CodesPanel";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const CODES = [
  { roleId: "account_manager", code: "AAAA-1111" },
  { roleId: "delivery_lead", code: "BBBB-2222" },
];

describe("CodesPanel", () => {
  it("shows each role and code as text with a Copy button, and the shown-once warning", () => {
    const { container } = render(
      <CodesPanel
        codes={[
          { roleId: "x", code: "<img src=x onerror=alert(1)>" },
          ...CODES,
        ]}
      />,
    );
    expect(
      screen.getByText("These codes are shown once and cannot be shown again."),
    ).toBeTruthy();
    expect(screen.getByText("AAAA-1111").tagName).toBe("CODE");
    expect(
      screen.getAllByRole("button", { name: /^Copy code for/ }),
    ).toHaveLength(3);
    expect(container.querySelector("img")).toBeNull();
  });

  it("CodesPanel never writes codes to localStorage, sessionStorage or the URL", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const before = window.location.href;
    const push = vi.spyOn(window.history, "pushState");
    const replace = vi.spyOn(window.history, "replaceState");
    render(<CodesPanel codes={CODES} />);
    fireEvent.click(
      screen.getAllByRole("button", { name: /^Copy code for/ })[0]!,
    );
    expect(setItem).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    expect(window.location.href).toBe(before);
    expect(window.location.href).not.toContain("AAAA");
    expect(JSON.stringify({ ...localStorage })).not.toContain("AAAA");
    expect(JSON.stringify({ ...sessionStorage })).not.toContain("AAAA");
    expect(document.cookie).not.toContain("AAAA");
  });

  it('CodesPanel removes the codes from the DOM after "I have copied the codes"', () => {
    const onDismiss = vi.fn();
    const { container } = render(
      <CodesPanel codes={CODES} onDismiss={onDismiss} />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "I have copied the codes" }),
    );
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(container.innerHTML).not.toContain("AAAA-1111");
    expect(document.body.textContent).not.toContain("BBBB-2222");
  });

  it("copies with the clipboard and says so; says plainly when the clipboard is unavailable or refuses", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    render(<CodesPanel codes={CODES} />);
    fireEvent.click(
      screen.getAllByRole("button", { name: /^Copy code for/ })[0]!,
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("AAAA-1111"));
    await screen.findByText("Copied.");
    writeText.mockRejectedValueOnce(new Error("blocked"));
    fireEvent.click(
      screen.getAllByRole("button", { name: /^Copy code for/ })[1]!,
    );
    await screen.findByText(/Could not copy/);
    Object.defineProperty(navigator, "clipboard", {
      value: undefined,
      configurable: true,
    });
    fireEvent.click(
      screen.getAllByRole("button", { name: /^Copy code for/ })[0]!,
    );
    await waitFor(() =>
      expect(screen.getAllByText(/Could not copy/).length).toBeGreaterThan(0),
    );
  });
});
