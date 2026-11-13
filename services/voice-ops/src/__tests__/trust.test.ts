import tls from "node:tls";
import { describe, expect, it } from "vitest";
import { trustStore } from "../trust.js";

// US-0072 (review B2 F9): the TLS route's CA list is Node's bundle plus the system store; without `tls.getCACertificates` (Node before
// 22.15) that is reported, never dropped silently.
describe("trustStore", () => {
  it("adds the system store when tls.getCACertificates exists", () => {
    const r = trustStore({ rootCertificates: ["bundled"], getCACertificates: (t: "system") => (t === "system" ? ["system-a", "system-b"] : ["other"]) });
    expect(r).toEqual({ cas: ["bundled", "system-a", "system-b"], system: true });
  });
  it("says so when it does not exist, or throws", () => {
    expect(trustStore({ rootCertificates: ["bundled"] })).toEqual({ cas: ["bundled"], system: false });
    expect(trustStore({ rootCertificates: ["bundled"], getCACertificates: () => { throw new Error("no"); } })).toEqual({ cas: ["bundled"], system: false });
  });
  it("this Node has the system store (the engines field asks for 22.15 or newer)", () => {
    expect(trustStore(tls).system).toBe(true);
  });
});
