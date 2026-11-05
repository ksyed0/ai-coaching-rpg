import { describe, expect, it } from "vitest";
import type { Config } from "../config";
import { seal, unseal } from "../seal";

const KEYS: Config["cookieKeys"] = [{ id: "k1", key: Buffer.alloc(32, 9) }];
const NOW = 1_900_000_000_000;
const payload = { name: "Ann", expiresAt: NOW + 60_000 };

describe("seal purpose", () => {
  it("a fac-sealed token is refused without a purpose and a player-sealed token is refused with fac", () => {
    const fac = seal(payload, KEYS, NOW, "fac");
    const player = seal(payload, KEYS, NOW);
    expect(unseal(fac, KEYS, NOW)).toBeNull();
    expect(unseal(player, KEYS, NOW, "fac")).toBeNull();
  });

  it("both still round-trip with their own purpose", () => {
    expect(unseal(seal(payload, KEYS, NOW, "fac"), KEYS, NOW, "fac")).toEqual(
      payload,
    );
    expect(unseal(seal(payload, KEYS, NOW), KEYS, NOW)).toEqual(payload);
  });
});
