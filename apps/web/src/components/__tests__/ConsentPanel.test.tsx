// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ConsentPanel } from "../ConsentPanel";

afterEach(cleanup);

const EARLIER = /This seat agreed to a consent notice earlier\./;
const okAction = async () => ({ ok: true as const });
const panel = (given: boolean) => <ConsentPanel noticeVersion="v2" notice="n" given={given} onConsent={okAction} onWithdraw={okAction} />;

describe("ConsentPanel agreed-here", () => {
  it("a seat that is already consented reads the earlier-consent sentence, not 'You agreed to notice v2'", () => {
    render(panel(true));
    expect(screen.getByText(EARLIER)).toBeTruthy();
    expect(screen.queryByText(/You agreed to notice/)).toBeNull();
  });

  it("agreeing in this panel reads 'You agreed to notice v2'", async () => {
    const { rerender } = render(panel(false));
    fireEvent.click(screen.getByLabelText("I have read this notice and agree to take part."));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "I agree" })); });
    rerender(panel(true));
    expect(screen.getByText(/You agreed to notice v2\./)).toBeTruthy();
  });

  it("when consent is taken away from outside and then adopted again, the panel no longer claims the agreement", async () => {
    const { rerender } = render(panel(false));
    fireEvent.click(screen.getByLabelText("I have read this notice and agree to take part."));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "I agree" })); });
    rerender(panel(true));
    expect(screen.getByText(/You agreed to notice v2\./)).toBeTruthy();
    rerender(panel(false)); // withdrawn elsewhere
    rerender(panel(true)); // adopted again, not given here
    expect(screen.getByText(EARLIER)).toBeTruthy();
    expect(screen.queryByText(/You agreed to notice/)).toBeNull();
  });
});
