// Pure entry-signal analysis. A contract is only returned when its statistics
// favour it AND the latest ticks form the entry trigger — otherwise the AI waits.
import type { ContractCfg, ContractKey } from "./store";

export interface Signal {
  type: ContractKey;
  pred?: number | undefined;
  prob: number; // estimated win probability
  edge: number; // prob minus theoretical probability
  reason: string;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

export function analyse(
  digits: number[],
  prices: number[],
  contracts: Record<ContractKey, ContractCfg>,
): Signal[] {
  const out: Signal[] = [];
  if (digits.length < 50) return out;
  const w = digits.slice(-100);
  const n = w.length;
  const last = digits[digits.length - 1]!;
  const share = (f: (d: number) => boolean, arr = w) => arr.filter(f).length / arr.length;

  // ---- Even / Odd: bias over 100 ticks, confirmed over 25, entered on a reversal ----
  const even100 = share((d) => d % 2 === 0);
  const even25 = share((d) => d % 2 === 0, digits.slice(-25));
  let streak = 1;
  for (let i = digits.length - 2; i >= 0 && digits[i]! % 2 === last % 2; i--) streak++;
  const parityCheck = (wantEven: boolean, k: ContractKey) => {
    if (!contracts[k].enabled) return;
    const bias = wantEven ? even100 : 1 - even100;
    const recent = wantEven ? even25 : 1 - even25;
    const lastIsWanted = (last % 2 === 0) === wantEven;
    // dominant side, recent confirmation, and a 2+ tick run of the opposite side to fade
    if (bias >= 0.53 && recent >= 0.5 && !lastIsWanted && streak >= 2) {
      const prob = Math.min(0.62, 0.5 + (bias - 0.5) * 0.6 + Math.min(streak, 5) * 0.005);
      out.push({ type: k, prob, edge: prob - 0.5, reason: `${k.toLowerCase()} ${pct(bias)} of last ${n}, reversal after ${streak} opposite ticks` });
    }
  };
  parityCheck(true, "EVEN");
  parityCheck(false, "ODD");

  // ---- Over / Under: observed % vs theory, enter after a trigger digit on the other side ----
  for (const k of ["OVER", "UNDER"] as const) {
    const c = contracts[k];
    if (!c.enabled) continue;
    const preds = c.predMode === "single" ? c.preds.slice(0, 1) : c.preds;
    for (const d of preds) {
      if ((k === "OVER" && d >= 9) || (k === "UNDER" && d <= 0)) continue;
      const theo = k === "OVER" ? (9 - d) / 10 : d / 10;
      const obs = share((x) => (k === "OVER" ? x > d : x < d));
      const obs20 = share((x) => (k === "OVER" ? x > d : x < d), digits.slice(-20));
      const trigger = k === "OVER" ? last <= Math.max(1, d - 2) && last < d + 1 : last >= Math.min(8, d + 2) && last > d - 1;
      const opp = k === "OVER" ? `digit ${last} (low)` : `digit ${last} (high)`;
      if (obs >= theo && obs20 >= theo - 0.05 && trigger) {
        const prob = Math.min(0.95, theo + (obs - theo) * 0.5);
        out.push({ type: k, pred: d, prob, edge: prob - theo, reason: `${k.toLowerCase()} ${d} hit ${pct(obs)} vs ${pct(theo)} expected, trigger ${opp}` });
      }
    }
  }

  // ---- Differs: digit is rare and hasn't appeared recently ----
  const dc = contracts.DIFFERS;
  if (dc.enabled) {
    const preds = dc.predMode === "single" ? dc.preds.slice(0, 1) : dc.preds;
    const recent = digits.slice(-6);
    for (const d of preds) {
      const f = share((x) => x === d);
      if (f <= 0.09 && !recent.includes(d)) {
        const prob = Math.min(0.96, 0.9 + (0.1 - f) * 0.3);
        out.push({ type: "DIFFERS", pred: d, prob, edge: prob - 0.9, reason: `digit ${d} only ${pct(f)} and absent last 6 ticks` });
      }
    }
  }

  // ---- Rise / Fall: momentum in last 10 moves with a confirming last move ----
  if ((contracts.RISE.enabled || contracts.FALL.enabled) && prices.length >= 12) {
    const p = prices.slice(-11);
    let up = 0;
    for (let i = 1; i < p.length; i++) if (p[i]! > p[i - 1]!) up++;
    const lastUp = p[10]! > p[9]!;
    if (contracts.RISE.enabled && up >= 7 && lastUp) {
      const prob = 0.5 + (up - 5) * 0.012;
      out.push({ type: "RISE", prob, edge: prob - 0.5, reason: `${up}/10 up moves, momentum confirmed` });
    }
    if (contracts.FALL.enabled && up <= 3 && !lastUp) {
      const prob = 0.5 + (5 - up) * 0.012;
      out.push({ type: "FALL", prob, edge: prob - 0.5, reason: `${10 - up}/10 down moves, momentum confirmed` });
    }
  }
  return out;
}
