// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog } from "../console/ConfirmDialog";

afterEach(cleanup);

function page(open: boolean, onCancel = vi.fn()) {
  return (
    <div id="app">
      <header id="head">
        <button type="button">Opener</button>
      </header>
      <main id="main">
        <p>Background</p>
        {open ? (
          <ConfirmDialog
            title="Sure?"
            description="Really."
            confirmLabel="Do it"
            onConfirm={vi.fn()}
            onCancel={onCancel}
          />
        ) : null}
        <footer id="foot">Footer</footer>
      </main>
    </div>
  );
}

describe("ConfirmDialog background", () => {
  it("makes everything outside the dialog inert while it is open, and restores it on close", () => {
    const { container, rerender } = render(page(true));
    const dialog = screen.getByRole("dialog");
    expect(container.querySelector("#head")!.hasAttribute("inert")).toBe(true);
    expect(container.querySelector("#foot")!.hasAttribute("inert")).toBe(true);
    expect(container.querySelector("#main p")!.hasAttribute("inert")).toBe(
      true,
    );
    // The dialog and the chain of elements that hold it stay live.
    expect(dialog.closest("[inert]")).toBeNull();
    expect(container.querySelector("#main")!.hasAttribute("inert")).toBe(false);
    expect(container.querySelector("#app")!.hasAttribute("inert")).toBe(false);

    rerender(page(false));
    expect(container.querySelector("#head")!.hasAttribute("inert")).toBe(false);
    expect(container.querySelector("#foot")!.hasAttribute("inert")).toBe(false);
    expect(container.querySelector("#main p")!.hasAttribute("inert")).toBe(
      false,
    );
  });

  it("leaves an element that was already inert inert after it closes", () => {
    const { container, rerender } = render(page(false));
    container.querySelector("#foot")!.setAttribute("inert", "");
    rerender(page(true));
    rerender(page(false));
    expect(container.querySelector("#foot")!.hasAttribute("inert")).toBe(true);
  });

  it("still cancels on Escape and on the Cancel button", () => {
    const onCancel = vi.fn();
    render(page(true, onCancel));
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
