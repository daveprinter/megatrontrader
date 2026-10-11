import { deriv, lastDigit } from "./deriv";
import { coverage, estProfitRatio, martingaleStake, MIN_STAKE, round2 } from "./martingale";
import {
  addLog,
  CONTRACTS,
  type ContractKey,
  DERIV_TYPE,
  getState,
  HAS_PREDICTION,
  marketName,
  setState,
  type Trade,
} from "./store";

const HOUR = 3600_000;

interface Candidate {
  type: ContractKey;
  pred?: number | undefined;
  prob: number;
}

// ---------- connection / live ticks ----------
let tickSubId: string | null = null;
let wired = false;

function wire() {
  if (wired) return;
  wired = true;
  deriv.onMessage((m) => {
    if (m.msg_type === "balance" && m.balance) {
      setState(() => ({ balance: m.balance.balance, currency: m.balance.currency }));
    }
    if (m.msg_type === "tick" && m.tick) {
      const pip = m.tick.pip_size ?? 2;
      setState(() => ({
        tick: { price: m.tick.quote, pip, digit: lastDigit(m.tick.quote, pip), symbol: m.tick.symbol },
      }));
    }
    if (m.msg_type === "__closed") {
      setState(() => ({ conn: { status: "idle", error: "Disconnected" } }));
    }
  });
}

export async function connectAccount() {
  wire();
  const token = getState().settings.token;
  if (!token) return;
  setState(() => ({ conn: { status: "connecting" } }));
  try {
    const a = await deriv.connect(token);
    setState(() => ({
      conn: { status: "connected", loginid: a.loginid },
      balance: a.balance,
      currency: a.currency,
    }));
    addLog(`Connected to ${a.loginid}`);
    await watchMarket(getState().settings.market);
  } catch (e: any) {
    setState(() => ({ conn: { status: "error", error: e.message } }));
  }
}

export function disconnectAccount() {
  stopEngine();
  deriv.disconnect();
  setState(() => ({ conn: { status: "idle" }, balance: null }));
}

export async function watchMarket(symbol: string) {
  wire();
  try {
    if (tickSubId) await deriv.send({ forget: tickSubId }).catch(() => {});
    const r = await deriv.send({ ticks: symbol, subscribe: 1 });
    tickSubId = r.subscription?.id ?? null;
  } catch (e: any) {
    addLog(`Tick stream error: ${e.message}`, "warn");
  }
}

// ---------- engine state ----------
let loop: ReturnType<typeof setInterval> | null = null;
let busy = false;
let curHour = -1;
let scheduledAt = 0;
let hourProfit = 0;
let targetLogged = false;
let hourTypeTrades: Partial<Record<ContractKey, number>> = {};
let hourTypeLosses: Partial<Record<ContractKey, number>> = {};
let bannedTypes = new Set<ContractKey>();
let mgStep = 0;
let lossAccum = 0;
let lastStake = 0;
let lastType: ContractKey | null = null;
let marketStartedAt = Date.now();
let marketTrades = 0;
let marketIdx = 0;

const eng = (patch: Partial<ReturnType<typeof getState>["engine"]>) =>
  setState((s) => ({ engine: { ...s.engine, ...patch } }));

export function launchEngine() {
  const s = getState();
  if (!s.session.startedAt) return addLog("Start a session in Settings first", "warn");
  if (s.conn.status !== "connected") return addLog("Connect your Deriv account first", "warn");
  if (!CONTRACTS.some((k) => s.settings.contracts[k].enabled))
    return addLog("Select at least one contract type", "warn");
  const markets = activeMarkets();
  marketIdx = 0;
  marketStartedAt = Date.now();
  marketTrades = 0;
  eng({ market: markets[0]!, status: "Running" });
  setState((st) => ({ session: { ...st.session, launched: true } }));
  addLog("Megatron AI launched");
  curHour = -1;
  if (loop) clearInterval(loop);
  loop = setInterval(tickLoop, 1000);
}

export function stopEngine() {
  if (loop) clearInterval(loop);
  loop = null;
  setState((st) => ({ session: { ...st.session, launched: false } }));
  eng({ status: "Stopped", nextAt: null });
}

/** Resume automatically after a page reload when session was launched. */
export function resumeIfLaunched() {
  const s = getState();
  if (s.session.launched && s.conn.status === "connected" && !loop) launchEngine();
}

function activeMarkets() {
  const s = getState().settings;
  return s.multiMarket && s.markets.length ? s.markets : [s.market];
}

async function tickLoop() {
  if (busy) return;
  const s = getState();
  const st = s.settings;
  const now = Date.now();

  // stop loss on session
  const sessionPnl = s.trades
    .filter((t) => s.session.startedAt && t.time >= s.session.startedAt)
    .reduce((a, t) => a + t.profit, 0);
  if (st.stopLoss > 0 && sessionPnl <= -st.stopLoss) {
    addLog(`Stop loss hit (${sessionPnl.toFixed(2)}). Engine stopped.`, "loss");
    return stopEngine();
  }

  const hk = Math.floor(now / HOUR);
  if (hk !== curHour) {
    curHour = hk;
    hourProfit = 0;
    targetLogged = false;
    const hourEnd = (hk + 1) * HOUR;
    const window = Math.max(0, hourEnd - now - 12 * 60_000);
    scheduledAt = now + Math.random() * window;
    // carry banned types from previous hour, then reset counters
    bannedTypes = new Set(
      (Object.keys(hourTypeLosses) as ContractKey[]).filter(
        (k) => st.tradeMode === "manual" && (hourTypeLosses[k] ?? 0) >= st.typeMaxLosses,
      ),
    );
    hourTypeTrades = {};
    hourTypeLosses = {};
    eng({ hourProfit: 0, nextAt: scheduledAt });
    addLog(`New hour — trading window opens at ${new Date(scheduledAt).toLocaleTimeString("en-US", { timeZone: "Africa/Nairobi" })} EAT`);
  }

  // daily active window
  const elapsed = (now - (s.session.startedAt ?? now)) % (24 * HOUR);
  if (elapsed >= st.hoursPerDay * HOUR) {
    eng({ status: "Resting (daily hours done)" });
    return;
  }
  if (hourProfit >= st.hourlyTarget) {
    if (!targetLogged) {
      targetLogged = true;
      addLog(`Hourly target $${st.hourlyTarget} reached — waiting for next hour`, "win");
    }
    eng({ status: "Target reached · waiting" });
    return;
  }
  if (now < scheduledAt) {
    eng({ status: "Waiting for random window" });
    return;
  }

  busy = true;
  try {
    maybeSwitchMarket();
    await runTrade();
  } catch (e: any) {
    addLog(`Trade error: ${e.message}`, "warn");
    scheduledAt = Date.now() + 15_000;
  } finally {
    busy = false;
  }
  scheduledAt = Math.max(scheduledAt, Date.now() + 2000 + Math.random() * 4000);
}

function maybeSwitchMarket() {
  const st = getState().settings;
  const markets = activeMarkets();
  if (markets.length < 2) {
    eng({ market: markets[0]! });
    return;
  }
  const cur = getState().engine.market;
  let reason = "";
  if (st.marketMode === "manual") {
    if (marketTrades >= st.marketMaxTrades) reason = `max ${st.marketMaxTrades} trades reached`;
    else if (Date.now() - marketStartedAt >= st.marketMaxHours * HOUR) reason = `max ${st.marketMaxHours}h runtime reached`;
  } else {
    const recent = getState().trades.filter((t) => t.symbol === cur).slice(0, 8);
    const losses = recent.filter((t) => t.profit < 0).length;
    const pnl = recent.reduce((a, t) => a + t.profit, 0);
    if (recent.length >= 4 && losses >= 3) reason = `${losses} recent losses`;
    else if (recent.length >= 6 && pnl > st.hourlyTarget * 2) reason = "banking profit before market turns";
  }
  if (reason || !markets.includes(cur)) {
    marketIdx = (markets.indexOf(cur) + 1) % markets.length;
    const next = markets[marketIdx];
    marketStartedAt = Date.now();
    marketTrades = 0;
    eng({ market: next! });
    if (reason) addLog(`Switching ${marketName(cur)} → ${marketName(next!)} (${reason})`);
  }
}

async function recentTicks(symbol: string) {
  const r = await deriv.send({ ticks_history: symbol, count: 120, end: "latest", style: "ticks" });
  const prices: number[] = r.history.prices;
  const pip = r.pip_size ?? 2;
  return { prices, digits: prices.map((p) => lastDigit(p, pip)) };
}

function buildCandidates(digits: number[], prices: number[]): Candidate[] {
  const st = getState().settings;
  const n = digits.length || 1;
  const freq = Array.from({ length: 10 }, (_, d) => digits.filter((x) => x === d).length / n);
  const evenF = freq.filter((_, d) => d % 2 === 0).reduce((a, b) => a + b, 0);
  const last20 = prices.slice(-20);
  const trend = last20.length > 1 ? Math.sign(last20[last20.length - 1]! - last20[0]!) : 0;
  // volatility (std of returns) to penalise choppy markets
  const out: Candidate[] = [];
  for (const k of CONTRACTS) {
    const c = st.contracts[k];
    if (!c.enabled) continue;
    if (st.tradeMode === "manual") {
      if ((hourTypeTrades[k] ?? 0) >= st.typeMaxTrades) continue;
      if ((hourTypeLosses[k] ?? 0) >= st.typeMaxLosses) continue;
      if (bannedTypes.has(k)) continue;
    }
    if (HAS_PREDICTION.includes(k)) {
      const preds = c.predMode === "single" ? c.preds.slice(0, 1) : c.preds;
      for (const d of preds) {
        let p = 0;
        if (k === "OVER" && d <= 8) p = (9 - d) / 10 + (freq.slice(d + 1).reduce((a, b) => a + b, 0) - (9 - d) / 10) * 0.2;
        if (k === "UNDER" && d >= 1) p = d / 10 + (freq.slice(0, d).reduce((a, b) => a + b, 0) - d / 10) * 0.2;
        if (k === "DIFFERS") p = 0.9 + (0.1 - freq[d]!) * 0.3;
        if (p > 0) out.push({ type: k, pred: d, prob: p });
      }
    } else if (k === "EVEN") out.push({ type: k, prob: 0.5 + (evenF - 0.5) * 0.3 });
    else if (k === "ODD") out.push({ type: k, prob: 0.5 + (0.5 - evenF) * 0.3 });
    else if (k === "RISE") out.push({ type: k, prob: 0.5 + trend * 0.03 });
    else if (k === "FALL") out.push({ type: k, prob: 0.5 - trend * 0.03 });
  }
  return out;
}

function typePerf(k: ContractKey) {
  const recent = getState().trades.filter((t) => t.type === k).slice(0, 6);
  const losses = recent.filter((t) => t.profit < 0).length;
  return Math.pow(0.85, losses);
}

function baseStake(c: Candidate) {
  const max = getState().settings.contracts[c.type].maxStake;
  const conf = Math.min(1, Math.max(0, (c.prob - 0.35) / 0.6));
  const jitter = 0.85 + Math.random() * 0.15;
  return Math.min(max, Math.max(MIN_STAKE, round2(MIN_STAKE + (max - MIN_STAKE) * conf * typePerf(c.type) * jitter)));
}

function pick(cands: Candidate[]): Candidate {
  // weighted random: favour probability × recent performance, but rotate types
  const w = cands.map((c) => c.prob * typePerf(c.type) * (c.type === lastType ? 0.7 : 1));
  const total = w.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < cands.length; i++) {
    r -= w[i]!;
    if (r <= 0) return cands[i]!;
  }
  return cands[0]!;
}

async function runTrade() {
  const s = getState();
  const st = s.settings;
  const symbol = s.engine.market;
  eng({ status: `Analysing ${marketName(symbol)}` });
  const { digits, prices } = await recentTicks(symbol);
  let cands = buildCandidates(digits, prices);
  if (!cands.length) {
    addLog("No eligible contracts this hour (limits reached) — waiting", "warn");
    hourProfit = st.hourlyTarget; // park until next hour
    return;
  }

  let chosen: Candidate;
  let stake: number;
  const recovering = st.mgEnabled && lossAccum > 0 && mgStep > 0 && mgStep < st.mgMaxSteps;

  if (recovering) {
    stake = martingaleStake(lastStake / Math.pow(Math.min(st.mgMultiplier, st.mgMaxMultiplier), mgStep - 1), st.mgMultiplier, mgStep, st.mgMaxSteps, st.mgMaxMultiplier);
    if (st.recoveryMode === "same" && lastType) cands = cands.filter((c) => c.type === lastType).length ? cands.filter((c) => c.type === lastType) : cands;
    if (st.recoveryMode === "different" && lastType) cands = cands.filter((c) => c.type !== lastType).length ? cands.filter((c) => c.type !== lastType) : cands;
    const need = st.recoveryCoverage / 100;
    const scored = cands
      .map((c) => ({ c, cov: coverage(stake, estProfitRatio(c.prob), lossAccum) }))
      .sort((a, b) => b.c.prob - a.c.prob);
    const ok = scored.filter((x) => x.cov >= need);
    const best = ok[0] ?? scored.sort((a, b) => b.cov - a.cov)[0]!;
    chosen = best.c;
    addLog(
      `Recovery step ${mgStep}: ${label(chosen)} stake ${stake.toFixed(2)} · expected profit ${(stake * estProfitRatio(chosen.prob)).toFixed(2)} covers ${(best.cov * 100).toFixed(0)}% of loss ${lossAccum.toFixed(2)}${ok.length ? "" : " (below target — best available)"}`,
      ok.length ? "info" : "warn",
    );
  } else {
    chosen = pick(cands);
    stake = baseStake(chosen);
  }
  stake = Math.max(MIN_STAKE, round2(stake));

  const cfg = st.contracts[chosen.type];
  const contractParams: Record<string, any> = {
    amount: stake,
    basis: "stake",
    contract_type: DERIV_TYPE[chosen.type],
    currency: s.currency,
    duration: cfg.ticks,
    duration_unit: "t",
  };
  if (chosen.pred !== undefined) contractParams["barrier"] = String(chosen.pred);
  eng({ status: `Buying ${label(chosen)}` });

  let payout: number;
  let cid: number;
  if (deriv.mode === "pat") {
    // PAT: proposal (with underlying_symbol) -> buy by proposal id
    const prop = await deriv.send({ proposal: 1, ...contractParams, underlying_symbol: symbol });
    const proposalId = prop?.proposal?.id;
    if (!proposalId) throw new Error("Deriv did not return a proposal ID");
    payout = prop.proposal.payout as number;
    if (recovering) {
      const realCov = coverage(stake, payout / stake - 1, lossAccum);
      addLog(`Payout ${payout.toFixed(2)} → real coverage ${(realCov * 100).toFixed(0)}%`);
    }
    const buy = await deriv.send({ buy: proposalId, price: stake });
    cid = buy.buy.contract_id;
  } else {
    // Legacy: direct buy with parameters
    const buy = await deriv.send({
      buy: 1,
      price: stake,
      parameters: { ...contractParams, symbol },
    });
    cid = buy.buy.contract_id;
    payout = Number(buy.buy.payout ?? 0);
  }
  addLog(`Bought ${label(chosen)} on ${marketName(symbol)} · stake ${stake.toFixed(2)} · payout ${payout.toFixed(2)}`);

  const profit = await new Promise<number>((resolve) => {
    const off = deriv.onMessage((m) => {
      const poc = m.proposal_open_contract;
      if (m.msg_type !== "proposal_open_contract" || !poc || poc.contract_id !== cid) return;
      setState(() => ({ floating: poc.profit ?? 0 }));
      if (poc.is_sold) {
        off();
        resolve(Number(poc.profit));
      }
    });
    deriv.send({ proposal_open_contract: 1, contract_id: cid, subscribe: 1 }).catch(() => {});
  });
  setState(() => ({ floating: 0 }));

  const trade: Trade = {
    id: String(cid),
    time: Date.now(),
    type: chosen.type,
    pred: chosen.pred,
    symbol,
    stake,
    profit: round2(profit),
    recovery: recovering,
  };
  setState((st2) => ({ trades: [trade, ...st2.trades].slice(0, 2000) }));
  hourProfit = round2(hourProfit + profit);
  eng({ hourProfit });
  marketTrades++;
  hourTypeTrades[chosen.type] = (hourTypeTrades[chosen.type] ?? 0) + 1;
  lastType = chosen.type;
  lastStake = stake;

  if (profit >= 0) {
    addLog(`WIN +${profit.toFixed(2)} on ${label(chosen)}`, "win");
    if (lossAccum > 0) lossAccum = Math.max(0, round2(lossAccum - profit));
    if (lossAccum <= 0) mgStep = 0;
    else mgStep = 0; // win resets martingale chain
    lossAccum = profit >= lossAccum ? 0 : lossAccum;
  } else {
    addLog(`LOSS ${profit.toFixed(2)} on ${label(chosen)}`, "loss");
    hourTypeLosses[chosen.type] = (hourTypeLosses[chosen.type] ?? 0) + 1;
    if (st.mgEnabled) {
      lossAccum = round2(lossAccum - profit);
      mgStep++;
      if (mgStep >= st.mgMaxSteps) {
        addLog(`Max martingale steps (${st.mgMaxSteps}) reached — resetting to base stake`, "warn");
        mgStep = 0;
        lossAccum = 0;
      }
    }
  }
}

function label(c: Candidate) {
  return c.pred !== undefined ? `${c.type} ${c.pred}` : c.type;
}
