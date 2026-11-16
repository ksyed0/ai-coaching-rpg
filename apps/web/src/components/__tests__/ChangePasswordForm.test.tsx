// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChangePasswordForm } from "../console/ChangePasswordForm";
import { fakeFetch, ok, refused } from "../../lib/__tests__/fakes";

afterEach(cleanup);

const TEMP = "temporary-pass-1";
const NEXT = "a-brand-new-passphrase";
const answering = (status: number, body: unknown) => fakeFetch(() => ({ status, body }));
const fill = (current: string, next: string, repeat: string) => {
  fireEvent.change(screen.getByLabelText("Current (temporary) password"), { target: { value: current } });
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: next } });
  fireEvent.change(screen.getByLabelText("Repeat"), { target: { value: repeat } });
};
const submit = () => fireEvent.click(screen.getByRole("button", { name: "Change password" }));
const region = (c: HTMLElement) => c.querySelector("[aria-live=polite]")!;

describe("ChangePasswordForm", () => {
  it("labels the three password fields and shows the minimum length as helper text", () => {
    const { container } = render(<ChangePasswordForm onDone={vi.fn()} />);
    for (const label of ["Current (temporary) password", "New password", "Repeat"]) {
      expect((screen.getByLabelText(label) as HTMLInputElement).type).toBe("password");
    }
    expect(screen.getByLabelText("Current (temporary) password").getAttribute("autocomplete")).toBe("current-password");
    expect(screen.getByLabelText("New password").getAttribute("autocomplete")).toBe("new-password");
    expect(container.textContent).toMatch(/at least 10 characters/i);
  });

  it("change_form_rejects_mismatch_and_short_without_a_request", () => {
    const f = answering(200, ok({}));
    const { container } = render(<ChangePasswordForm onDone={vi.fn()} fetch={f.fetch} />);
    fill(TEMP, "short", "short");
    submit();
    expect(region(container).textContent).toMatch(/at least 10 characters/);
    fill(TEMP, NEXT, NEXT + "x");
    submit();
    expect(region(container).textContent).toMatch(/do not match/);
    fill("", NEXT, NEXT);
    submit();
    expect(region(container).textContent).toMatch(/current/i);
    expect(f.calls).toHaveLength(0);
  });

  it("change_form_sends_current_and_new and change_success_goes_to_console", async () => {
    const f = answering(200, ok({ name: "Ann", role: "facilitator", mustChange: false }));
    const onDone = vi.fn();
    render(<ChangePasswordForm onDone={onDone} fetch={f.fetch} />);
    fill(TEMP, NEXT, NEXT);
    submit();
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("/api/v1/console/password");
    expect(f.calls[0]!.body).toEqual({ current: TEMP, next: NEXT });
    expect(f.calls[0]!.init.headers).toMatchObject({ "X-Requested-With": "scenecoach" });
  });

  it("disables submit while pending and sends once", async () => {
    const f = answering(200, ok({}));
    f.hold();
    render(<ChangePasswordForm onDone={vi.fn()} fetch={f.fetch} />);
    fill(TEMP, NEXT, NEXT);
    submit();
    await waitFor(() => expect((screen.getByRole("button", { name: "Change password" }) as HTMLButtonElement).disabled).toBe(true));
    submit();
    f.release();
    expect(f.calls).toHaveLength(1);
  });

  it.each([
    [403, "wrong_password", /current password is not right/],
    [400, "weak_password", /longer password/],
    [429, "rate_limited", /Too many attempts/],
    [401, "unauthorized", /sign-in ended/],
    [502, "launcher_unavailable", /cannot be reached/],
  ])("a %i %s answer reads plainly, clears the fields and does not finish", async (status, code, text) => {
    const f = answering(status, refused(code, "x"));
    const onDone = vi.fn();
    const { container } = render(<ChangePasswordForm onDone={onDone} fetch={f.fetch} />);
    fill(TEMP, NEXT, NEXT);
    submit();
    await waitFor(() => expect(region(container).textContent).toMatch(text));
    expect(onDone).not.toHaveBeenCalled();
    for (const label of ["Current (temporary) password", "New password", "Repeat"]) {
      expect((screen.getByLabelText(label) as HTMLInputElement).value).toBe("");
    }
  });

  it("passwords_never_in_storage_or_url", async () => {
    const f = answering(403, refused("wrong_password", "x"));
    const { container } = render(<ChangePasswordForm onDone={vi.fn()} fetch={f.fetch} />);
    fill(TEMP, NEXT, NEXT);
    submit();
    await waitFor(() => expect(region(container).textContent).not.toBe(""));
    for (const secret of [TEMP, NEXT]) {
      expect(JSON.stringify({ ...localStorage })).not.toContain(secret);
      expect(JSON.stringify({ ...sessionStorage })).not.toContain(secret);
      expect(window.location.href).not.toContain(secret);
      expect(container.innerHTML).not.toContain(secret);
    }
    expect(container.querySelector("form")!.getAttribute("method")).toBe("post");
  });
});
