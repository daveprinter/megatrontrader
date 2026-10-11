// Pure money-management helpers (kept separate so they are testable).

/** Deriv accepts at most 2 decimal places on stakes. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export const MIN_STAKE = 0.35;

/**
 * Stake after `step` consecutive martingale losses.
 * The multiplier is clamped to `maxMultiplier` and never changes between steps.
 * Once `step` reaches `maxSteps`, stake resets to `base`.
 */
export function martingaleStake(
  base: number,
  multiplier: number,
  step: number,
  maxSteps: number,
  maxMultiplier: number,
): number {
  const m = Math.min(multiplier, maxMultiplier);
  if (step <= 0 || step >= maxSteps) return round2(base);
  return round2(base * Math.pow(m, step));
}

/** Approximate Deriv profit ratio (profit / stake) for a given win probability. */
export function estProfitRatio(winProb: number): number {
  return Math.max(0.05, 0.955 / winProb - 1);
}

/** Fraction of `loss` covered by winning `stake` at `profitRatio`. */
export function coverage(stake: number, profitRatio: number, loss: number): number {
  if (loss <= 0) return 1;
  return (stake * profitRatio) / loss;
}
