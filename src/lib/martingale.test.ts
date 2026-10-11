import { describe, expect, it } from "vitest";
import { coverage, martingaleStake, round2 } from "./martingale";

describe("martingale", () => {
  it("rounds stakes to 2 decimals", () => {
    expect(round2(1.5 * 1.5 * 0.35)).toBe(0.79);
    expect(round2(1.1 * 1.1 * 1.1)).toBe(1.33);
  });
  it("never exceeds the max multiplier", () => {
    // user asks 3x but cap is 2x -> 1 * 2^2
    expect(martingaleStake(1, 3, 2, 5, 2)).toBe(4);
  });
  it("keeps the same multiplier each step", () => {
    expect(martingaleStake(1, 1.5, 1, 5, 2)).toBe(1.5);
    expect(martingaleStake(1, 1.5, 2, 5, 2)).toBe(2.25);
  });
  it("resets to base stake when max steps reached", () => {
    expect(martingaleStake(1, 2, 3, 3, 2)).toBe(1);
  });
  it("computes loss coverage", () => {
    expect(coverage(2, 0.9, 2)).toBeCloseTo(0.9);
  });
});
