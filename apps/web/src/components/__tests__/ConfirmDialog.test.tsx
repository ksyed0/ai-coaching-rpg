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

describe("ConfirmDialog body", () => {
  function body(extra: Record<string, unknown> = {}, onCancel = vi.fn(), onConfirm = vi.fn()) {
    return (
      <div>
        <button type="button">Opener</button>
        <ConfirmDialog title="T" description="Desc." confirmLabel="Go" onConfirm={onConfirm} onCancel={onCancel} {...extra}>
          <label htmlFor="msg">Message</label>
          <textarea id="msg" />
          <p>PREVIEW TEXT</p>
        </ConfirmDialog>
      </div>
    );
  }

  it("children are rendered and Tab cycles through a textarea in them", () => {
    render(body());
    const dialog = screen.getByRole("dialog");
    const ta = screen.getByLabelText("Message");
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const go = screen.getByRole("button", { name: "Go" });
    expect(dialog.contains(ta)).toBe(true);
    // The body sits between the description and the actions.
    expect([...dialog.querySelectorAll("button, textarea")]).toEqual([ta, cancel, go]);
    expect(document.activeElement).toBe(cancel);
    // The textarea is part of the cycle: Shift+Tab from the first control wraps to the last, Tab from the last wraps to the first.
    go.focus();
    fireEvent.keyDown(go, { key: "Tab" });
    expect(document.activeElement).toBe(ta);
    fireEvent.keyDown(ta, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(go);
  });

  it("Escape cancels from inside a body field", () => {
    const onCancel = vi.fn();
    render(body({}, onCancel));
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("with describeBody the preview is part of the dialog's description", () => {
    const { unmount } = render(body({ describeBody: true }));
    const ids = screen.getByRole("dialog").getAttribute("aria-describedby")!.split(" ");
    expect(ids).toHaveLength(2);
    expect(ids.map((i) => document.getElementById(i)?.textContent)).toEqual(["Desc.", "MessagePREVIEW TEXT"]);
    unmount();
    render(body());
    const plain = screen.getByRole("dialog").getAttribute("aria-describedby")!.split(" ");
    expect(plain).toHaveLength(1);
    expect(document.getElementById(plain[0]!)?.textContent).toBe("Desc.");
  });

  it("tone primary changes only the confirm button class", () => {
    const { unmount } = render(body());
    expect(screen.getByRole("button", { name: "Go" }).className).toBe("btn danger");
    expect(screen.getByRole("button", { name: "Cancel" }).className).toBe("btn");
    unmount();
    render(body({ tone: "primary" }));
    expect(screen.getByRole("button", { name: "Go" }).className).toBe("btn pri");
    expect(screen.getByRole("button", { name: "Cancel" }).className).toBe("btn");
  });

  it("while pending, Escape and both buttons do nothing", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(body({ pending: true }, onCancel, onConfirm));
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onCancel).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
