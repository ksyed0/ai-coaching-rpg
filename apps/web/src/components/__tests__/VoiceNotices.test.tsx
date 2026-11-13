// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { VoiceNotices } from "../VoiceNotices";
import { VOICE_NOTICES, type VoiceNoticeCode } from "../../lib/messages";

// US-0071 (A1b Task 14): ONE stable polite status region; the latest notice is an inner span keyed by its count, so a repeated code is
// announced again by replacing the span's text node, never by remounting the region.

afterEach(cleanup);

describe("VoiceNotices", () => {
  it("the region is a polite status, present and empty before any notice", () => {
    render(<VoiceNotices notice={null} />);
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.textContent).toBe("");
  });

  it("each code shows its sentence", () => {
    const r = render(<VoiceNotices notice={null} />);
    let n = 0;
    for (const code of Object.keys(VOICE_NOTICES) as VoiceNoticeCode[]) {
      r.rerender(<VoiceNotices notice={{ code, n: ++n }} />);
      expect(screen.getByRole("status").textContent).toBe(VOICE_NOTICES[code]);
    }
  });

  it("a repeated code replaces the inner span and the region element is the same node", () => {
    const r = render(<VoiceNotices notice={{ code: "empty", n: 1 }} />);
    const region = screen.getByRole("status");
    const span = region.firstElementChild;
    expect(span?.tagName).toBe("SPAN");
    r.rerender(<VoiceNotices notice={{ code: "empty", n: 2 }} />);
    expect(screen.getByRole("status")).toBe(region);
    expect(region.firstElementChild).not.toBe(span);
    expect(region.textContent).toBe(VOICE_NOTICES.empty);
    expect(region.children).toHaveLength(1);
  });
});
