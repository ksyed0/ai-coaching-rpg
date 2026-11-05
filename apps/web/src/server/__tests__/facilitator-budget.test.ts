import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  FACILITATOR_FORWARD_KEY,
  FacilitatorBudget,
  LIVE_TABS_PER_SESSION,
  SHORT_SOCKETS_PER_SESSION,
} from "../facilitator-budget";

const A = "s-0123456789abcdef";
const B = "s-fedcba9876543210";

describe("FacilitatorBudget", () => {
  it("four live slots then null; three short slots then null; kinds and sessions are independent", () => {
    const b = new FacilitatorBudget();
    for (let i = 0; i < 4; i++) expect(b.tryAcquire(A, "live")).not.toBeNull();
    expect(b.tryAcquire(A, "live")).toBeNull();
    for (let i = 0; i < 3; i++) expect(b.tryAcquire(A, "short")).not.toBeNull();
    expect(b.tryAcquire(A, "short")).toBeNull();
    expect(b.tryAcquire(B, "live")).not.toBeNull();
    expect(b.tryAcquire(B, "short")).not.toBeNull();
    expect(b.inUse(A, "live")).toBe(4);
    expect(b.inUse(A, "short")).toBe(3);
    expect(b.inUse(B, "live")).toBe(1);
  });

  it("release twice frees one slot", () => {
    const b = new FacilitatorBudget();
    const r = [1, 2, 3].map(() => b.tryAcquire(A, "short")!);
    r[0]!();
    r[0]!();
    expect(b.inUse(A, "short")).toBe(2);
    expect(b.tryAcquire(A, "short")).not.toBeNull();
    expect(b.tryAcquire(A, "short")).toBeNull();
  });

  it("an entry at zero is deleted", () => {
    const b = new FacilitatorBudget();
    b.tryAcquire(A, "live")!();
    expect(b.inUse(A, "live")).toBe(0);
    expect((b as unknown as { counts: Map<string, number> }).counts.size).toBe(0);
  });

  it("the reserved key is not an address", () => {
    expect(FACILITATOR_FORWARD_KEY).toBe("scenecoach-console");
  });

  it("LIVE_TABS_PER_SESSION + SHORT_SOCKETS_PER_SESSION is below CHILD_WS_MAX_CONNECTIONS_PER_IP", async () => {
    // Loaded by a computed path (see hub.runtime.test.ts): a static import would type-check the control service under this app's settings.
    const CHILD_ENV = fileURLToPath(new URL("../../../../../services/control/src/child-env.ts", import.meta.url));
    if (!existsSync(CHILD_ENV)) throw new Error(`facilitator-budget.test.ts needs ${CHILD_ENV}; it moved: update CHILD_ENV`);
    const { CHILD_WS_MAX_CONNECTIONS_PER_IP } = (await import(CHILD_ENV)) as { CHILD_WS_MAX_CONNECTIONS_PER_IP: number };
    expect(CHILD_WS_MAX_CONNECTIONS_PER_IP).toBeGreaterThan(0);
    expect(LIVE_TABS_PER_SESSION + SHORT_SOCKETS_PER_SESSION).toBeLessThan(CHILD_WS_MAX_CONNECTIONS_PER_IP);
  });
});
