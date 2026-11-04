// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialog, focusFallback } from "../console/ConfirmDialog";

afterEach(cleanup);

// BUG-0022: closing hands focus to the opener only while the opener can take it; otherwise to a documented fallback; never over a
// deliberate move of focus elsewhere.

type Host = { open: boolean; openerGone?: boolean; openerDisabled?: boolean; withFallback?: boolean };

function host(o: Host) {
  return (
    <div>
      {o.openerGone ? null : (
        <button type="button" id="op" disabled={o.openerDisabled === true}>
          Opener
        </button>
      )}
      <button type="button" id="elsewhere">
        Elsewhere
      </button>
      <p id="msg" tabIndex={-1} data-focus-fallback="msg">
        Something happened.
      </p>
      {o.open ? (
        <ConfirmDialog
          title="Sure?"
          description="Really."
          confirmLabel="Do it"
          opener={document.getElementById("op")}
          {...(o.withFallback === false ? {} : { fallbackFocus: focusFallback("msg") })}
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />
      ) : null}
    </div>
  );
}
const byId = (id: string) => document.getElementById(id) as HTMLElement;

describe("ConfirmDialog focus fallback", () => {
  it("returns focus to the opener when it is still there, visible and enabled", () => {
    const { rerender } = render(host({ open: false }));
    byId("op").focus();
    rerender(host({ open: true }));
    rerender(host({ open: false }));
    expect(document.activeElement).toBe(byId("op"));
  });

  it("moves focus to the fallback when the opener has left the document", () => {
    const { rerender } = render(host({ open: false }));
    byId("op").focus();
    rerender(host({ open: true }));
    rerender(host({ open: false, openerGone: true }));
    expect(document.activeElement).toBe(byId("msg"));
  });

  it("moves focus to the fallback when the opener is disabled", () => {
    const { rerender } = render(host({ open: false }));
    rerender(host({ open: true }));
    rerender(host({ open: false, openerDisabled: true }));
    expect(document.activeElement).toBe(byId("msg"));
  });

  it("moves focus to the fallback when the opener is hidden", () => {
    const { rerender } = render(host({ open: false }));
    rerender(host({ open: true }));
    byId("op").style.display = "none";
    rerender(host({ open: false }));
    expect(document.activeElement).toBe(byId("msg"));
  });

  it("keeps an aria-disabled opener as the target (it stays focusable)", () => {
    const { rerender } = render(host({ open: false }));
    rerender(host({ open: true }));
    byId("op").setAttribute("aria-disabled", "true");
    rerender(host({ open: false }));
    expect(document.activeElement).toBe(byId("op"));
  });

  it("does not move focus the user has put elsewhere meanwhile", () => {
    const { rerender } = render(host({ open: false }));
    rerender(host({ open: true }));
    byId("elsewhere").focus();
    rerender(host({ open: false, openerGone: true }));
    expect(document.activeElement).toBe(byId("elsewhere"));
  });

  it("does not pull focus back to the opener from where the user put it", () => {
    const { rerender } = render(host({ open: false }));
    rerender(host({ open: true }));
    byId("elsewhere").focus();
    rerender(host({ open: false }));
    expect(document.activeElement).toBe(byId("elsewhere"));
  });

  it("with no fallback and no opener, focus stays on the page", () => {
    const { rerender } = render(host({ open: false }));
    rerender(host({ open: true, withFallback: false }));
    rerender(host({ open: false, openerGone: true }));
    expect(document.activeElement).toBe(document.body);
  });

  it("focusFallback takes the first named message that has text, skipping an empty one", () => {
    render(
      <div>
        <p data-focus-fallback="a" tabIndex={-1} />
        <p data-focus-fallback="b" tabIndex={-1}>
          B text
        </p>
        <p data-focus-fallback="c" tabIndex={-1}>
          C text
        </p>
      </div>,
    );
    expect(focusFallback("a", "c", "b")()?.textContent).toBe("C text");
    expect(focusFallback("a")()).toBeNull();
  });
});
