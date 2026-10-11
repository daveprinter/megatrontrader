import { deriv } from "./deriv";
import { feed } from "./feed";
import { coverage, estProfitRatio, martingaleStake, MIN_STAKE, round2 } from "./martingale";
import { analyse, type Signal } from "./signals";
import {
  addError,
  addLog,
  CONTRACTS,
  type ContractKey,
  DERIV_TYPE,
  getState,
  marketName,
  setState,
  type Trade,
} from "./store";

const HOUR = 3600_000;
const LOSS_COOLDOWN_AFTER = 3; // consecutive losses
const LOSS_COOLDOWN_MS = 3 * 60_000;
const ERROR_COOLDOWN_AFTER = 3; // consecutive errors
const ERROR_COOLDOWN_MS = 2 * 60_000;

// ---------- live market data ----------
const priceBuf: Record<string, { prices: number[]; digits: number[] }> = {};
const lastPrice: Record<string, number> = {};
type TickInfo = { price: number; digit: number };
let tickWaiters: { symbol: string; resolve: (t: TickInfo) => void }[] = [];
let feedWired = false;
let accountWired = false;

function waitNextTick(symbol: string) {
  return new Promise<TickInfo>((resolve) => tickWaiters.push({ symbol, resolve }));
}

function wireFeed() {
  if (feedWired) return;
  feedWired = true;
  feed.onHistory = (sym, prices, pip) => {
    const digits = prices.map((p) => Number(p.toFixed(pip).slice(-1)));
    priceBuf[sym] = { prices: prices.slice(-200), digits: digits.slice(-200) };
    const p = prices[prices.length - 1];
    if (p !== undefined) {
      lastPrice[sym] = p;
      setState((s) => ({ ticks: { ...s.ticks, [sym]: { symbol: sym, price: p, pip, digit: digits[digits.length - 1]! } } }));
    }
  };
  feed.onTick = ({ symbol: sym, price, digit, pip }) => {
    const b = (priceBuf[sym] ??= { prices: [], digits: [] });
    b.prices.push(price);
    b.digits.push(digit);
    if (b.prices.length > 200) {
      b.prices.shift();
      b.digits.shift();
    }
    const prev = lastPrice[sym];
    lastPrice[sym] = price;
    setState((s) => ({ ticks: { ...s.ticks, [sym]: { symbol: sym, price, pip, digit, prev } } }));
    const ready = tickWaiters.filter((w) => w.symbol === sym);
    tickWaiters = tickWaiters.filter((w) => w.symbol !== sym);
    ready.forEach((w) => w.resolve({ price, digit }));
    // analysis runs on every incoming tick while launched
    if (loop) queueMicrotask(() => void tickLoop());
  };
  feed.onError = (msg) => addError(msg);
}

/** Keep the live feed subscribed to every market the UI or the AI needs. */
export function syncFeed() {
  wireFeed();
  const st = getState().settings;
  const syms = new Set<string>([st.market, getState().engine.market]);
  if (st.multiMarket) st.markets.forEach((m) => syms.add(m));
  feed.setSymbols([...syms]);
}

/** Kept for existing callers: switching market just re-syncs the live feed. */
export async function watchMarket(_symbol?: string) {
  setTimeout(syncFeed, 0);
}

function wireAccount() {
  if (accountWired) return;
  accountWired = true;
  deriv.onMessage((m) => {
    if (m.msg_type === "balance" && m.balance) {
      setState(() => ({ balance: m.balance.balance, currency: m.balance.currency }));
    }
    if (m.msg_type === "__closed") {
      setState(() => ({ conn: { status: "idle", error: "Disconnected" } }));
      addError("Deriv account connection closed");
    }
    if (m.error && m.msg_type !== "ping") addError(`Deriv API: ${m.error.message}`);
  });
}

export async function connectAccount() {
  wireAccount();
  syncFeed();
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
    addLog(`Connected to ${a.loginid} (${a.mode.toUpperCase()})`);
  } catch (e: any) {
    setState(() => ({ conn: { status: "error", error: e.message } }));
    addError(`Connect failed: ${e.message}`);
  }
}

export function disconnectAccount() {
  stopEngine();
  deriv.disconnect();
  setState(() => ({ conn: { status: "idle" }, balance: null }));
}

// ---------- engine state ----------
let loop: ReturnType<typeof setInterval> | null = null;
let busy = false;
let curHour = -1;
let nextAllowed = 0;
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
let consecLosses = 0;
let consecErrors = 0;
let cooldownUntil = 0;
let lastScanLog = 0;

const eng = (patch: Partial<ReturnType<typeof getState>["engine"]>) =>
  setState((s) => ({ engine: { ...s.engine, ...patch } }));

export function launchEngine() {
  const s = getState();
  if (!s.session.startedAt) return addLog("Start a session in Settings first", "warn");
  if (s.conn.status !== "connected") return addLog("Connect your Deriv account first", "warn");
  if (!CONTRACTS.some((k) => s.settings.contracts[k].enabled))
    return addLog("Select at least one contract type", "warn");
  const markets = activeMarkets();
  marketStartedAt = Date.now();
  marketTrades = 0;
  consecErrors = 0;
  cooldownUntil = 0;
  nextAllowed = 0;
  eng({ market: markets[0]!, status: "Scanning markets", cooldownUntil: null });
  setState((st) => ({ session: { ...st.session, launched: true } }));
  syncFeed();
  addLog(`Megatron AI launched — analysing ${markets.map(marketName).join(", ")}`);
  curHour = -1;
  if (loop) clearInterval(loop);
  loop = setInterval(tickLoop, 1000);
}

export function stopEngine() {
  if (loop) clearInterval(loop);
  loop = null;
  setState((st) => ({ session: { ...st.session, launched: false } }));
  eng({ status: "Stopped", nextAt: null, cooldownUntil: null, signal: "" });
}

export function resumeIfLaunched() {
  const s = getState();
  if (s.session.launched && s.conn.status === "connected" && !loop) launchEngine();
}

function activeMarkets() {
  const s = getState().settings;
  return s.multiMarket && s.markets.length ? s.markets : [s.market];
}

function startCooldown(ms: number, why: string) {
  cooldownUntil = Date.now() + ms;
  eng({ cooldownUntil, status: `Cooldown (${why})` });
  addLog(`Cooldown ${Math.round(ms / 60000)} min — ${why}. Recovery resumes after.`, "warn");
}

async function tickLoop() {
  if (busy || !loop) return;
  const s = getState();
  const st = s.settings;
  const now = Date.now();

  const sessionPnl = s.trades
    .filter((t) => s.session.startedAt && t.time >= s.session.startedAt)
    .reduce((a, t) => a + t.profit, 0);
  if (st.stopLoss > 0 && sessionPnl <= -st.stopLoss) {
    addLog(`Stop loss hit (${sessionPnl.toFixed(2)}). Engine stopped.`, "loss");
    return stopEngine();
  }

  const hk = Math.floor(now / HOUR);
  if (hk !== curHour) {
    if (curHour !== -1) addLog("New hour — hourly target reset");
    curHour = hk;
    hourProfit = 0;
    targetLogged = false;
    bannedTypes = new Set(
      (Object.keys(hourTypeLosses) as ContractKey[]).filter(
        (k) => st.tradeMode === "manual" && (hourTypeLosses[k] ?? 0) >= st.typeMaxLosses,
      ),
    );
    hourTypeTrades = {};
    hourTypeLosses = {};
    eng({ hourProfit: 0, nextAt: null });
  }

  const elapsed = (now - (s.session.startedAt ?? now)) % (24 * HOUR);
  if (elapsed >= st.hoursPerDay * HOUR) return eng({ status: "Resting (daily hours done)" });
  if (hourProfit >= st.hourlyTarget) {
    if (!targetLogged) {
      targetLogged = true;
      addLog(`Hourly target $${st.hourlyTarget} reached — resting until next hour`, "win");
    }
    return eng({ status: "Target reached · resting", nextAt: (hk + 1) * HOUR });
  }
  if (now < cooldownUntil) return;
  if (cooldownUntil) {
    cooldownUntil = 0;
    consecLosses = 0;
    consecErrors = 0;
    eng({ cooldownUntil: null });
    addLog("Cooldown over — scanning for entries");
  }
  if (now < nextAllowed) return;

  maybeSwitchMarket();
  const pickRes = findSignal();
  if (!pickRes) {
    if (now - lastScanLog > 1000) {
      lastScanLog = now;
      const m = getState().engine.market;
      const ready = (priceBuf[m]?.digits.length ?? 0) >= 50;
      eng({ status: ready ? "Analysing · waiting for entry" : `Loading data for ${marketName(m)}`, signal: "" });
    }
    return;
  }

  busy = true;
  try {
    await runTrade(pickRes.symbol, pickRes.cands);
    consecErrors = 0;
  } catch (e: any) {
    consecErrors++;
    addError(`Trade error: ${e.message}`);
    addLog(`Trade error: ${e.message}`, "warn");
    nextAllowed = Date.now() + 5000;
    if (consecErrors >= ERROR_COOLDOWN_AFTER) startCooldown(ERROR_COOLDOWN_MS, `${consecErrors} errors in a row`);
  } finally {
    busy = false;
  }
  if (getState().settings.tradeSpeed !== "tick") nextAllowed = Math.max(nextAllowed, Date.now() + 1500);
  if (consecLosses >= LOSS_COOLDOWN_AFTER && !cooldownUntil)
    startCooldown(LOSS_COOLDOWN_MS, `${consecLosses} losses in a row`);
}

/** Scan active markets and return the best one with live entry signals. */
function findSignal(): { symbol: string; cands: Signal[] } | null {
  const st = getState().settings;
  const auto = st.multiMarket && st.marketMode === "auto";
  const markets = auto ? activeMarkets() : [getState().engine.market];
  let best: { symbol: string; cands: Signal[]; edge: number } | null = null;
  for (const m of markets) {
    const b = priceBuf[m];
    if (!b || b.digits.length < 50) continue;
    const cands = analyse(b.digits, b.prices, st.contracts).filter(eligible);
    if (!cands.length) continue;
    const edge = Math.max(...cands.map((c) => c.edge));
    if (!best || edge > best.edge) best = { symbol: m, cands, edge };
  }
  if (best && auto && best.symbol !== getState().engine.market) {
    addLog(`Market fit: ${marketName(best.symbol)} shows the strongest setup`);
    eng({ market: best.symbol });
    marketStartedAt = Date.now();
    marketTrades = 0;
  }
  return best;
}

function eligible(c: Signal) {
  const st = getState().settings;
  if (st.tradeMode !== "manual") return true;
  if ((hourTypeTrades[c.type] ?? 0) >= st.typeMaxTrades) return false;
  if ((hourTypeLosses[c.type] ?? 0) >= st.typeMaxLosses) return false;
  return !bannedTypes.has(c.type);
}

function maybeSwitchMarket() {
  const st = getState().settings;
  const markets = activeMarkets();
  const cur = getState().engine.market;
  if (markets.length < 2) {
    if (cur !== markets[0]) eng({ market: markets[0]! });
    return;
  }
  if (st.marketMode !== "manual") {
    if (!markets.includes(cur)) eng({ market: markets[0]! });
    return;
  }
  let reason = "";
  if (marketTrades >= st.marketMaxTrades) reason = `max ${st.marketMaxTrades} trades reached`;
  else if (Date.now() - marketStartedAt >= st.marketMaxHours * HOUR) reason = `max ${st.marketMaxHours}h runtime reached`;
  if (reason || !markets.includes(cur)) {
    const next = markets[(markets.indexOf(cur) + 1) % markets.length]!;
    marketStartedAt = Date.now();
    marketTrades = 0;
    eng({ market: next });
    if (reason) addLog(`Switching ${marketName(cur)} → ${marketName(next)} (${reason})`);
  }
}

function typePerf(k: ContractKey) {
  const recent = getState().trades.filter((t) => t.type === k).slice(0, 6);
  const losses = recent.filter((t) => t.profit < 0).length;
  return Math.pow(0.85, losses);
}

function baseStake(c: Signal) {
  const max = getState().settings.contracts[c.type].maxStake;
  const conf = Math.min(1, Math.max(0, (c.prob - 0.35) / 0.6));
  return Math.min(max, Math.max(MIN_STAKE, round2(MIN_STAKE + (max - MIN_STAKE) * conf * typePerf(c.type))));
}

function pick(cands: Signal[]): Signal {
  return [...cands].sort(
    (a, b) => b.edge * typePerf(b.type) * (b.type === lastType ? 0.9 : 1) - a.edge * typePerf(a.type) * (a.type === lastType ? 0.9 : 1),
  )[0]!;
}

async function runTrade(symbol: string, candsIn: Signal[]) {
  const s = getState();
  const st = s.settings;
  const tickMode = st.tradeSpeed === "tick";
  let cands = candsIn;

  let chosen: Signal;
  let stake: number;
  const recovering = st.mgEnabled && lossAccum > 0 && mgStep > 0 && mgStep < st.mgMaxSteps;

  if (recovering) {
    stake = martingaleStake(lastStake / Math.pow(Math.min(st.mgMultiplier, st.mgMaxMultiplier), mgStep - 1), st.mgMultiplier, mgStep, st.mgMaxSteps, st.mgMaxMultiplier);
    if (st.recoveryMode === "same" && lastType && cands.some((c) => c.type === lastType)) cands = cands.filter((c) => c.type === lastType);
    if (st.recoveryMode === "different" && lastType && cands.some((c) => c.type !== lastType)) cands = cands.filter((c) => c.type !== lastType);
    const need = st.recoveryCoverage / 100;
    const scored = cands
      .map((c) => ({ c, cov: coverage(stake, estProfitRatio(c.prob), lossAccum) }))
      .sort((a, b) => b.c.prob - a.c.prob);
    const ok = scored.filter((x) => x.cov >= need);
    const best = ok[0] ?? scored.sort((a, b) => b.cov - a.cov)[0]!;
    chosen = best.c;
    addLog(
      `Recovery step ${mgStep}: ${label(chosen)} stake ${stake.toFixed(2)} covers ${(best.cov * 100).toFixed(0)}% of loss ${lossAccum.toFixed(2)}${ok.length ? "" : " (below target — best available)"}`,
      ok.length ? "info" : "warn",
    );
  } else {
    chosen = pick(cands);
    stake = baseStake(chosen);
  }
  stake = Math.max(MIN_STAKE, round2(stake));
  eng({ signal: `${label(chosen)} · ${chosen.reason}` });
  addLog(`Entry signal on ${marketName(symbol)}: ${label(chosen)} — ${chosen.reason}`);

  const cfg = st.contracts[chosen.type];
  const contractParams: Record<string, any> = {
    amount: stake,
    basis: "stake",
    contract_type: DERIV_TYPE[chosen.type],
    currency: s.currency,
    duration: tickMode ? 1 : cfg.ticks,
    duration_unit: "t",
  };
  if (chosen.pred !== undefined) contractParams["barrier"] = String(chosen.pred);
  eng({ status: `Buying ${label(chosen)}` });

  let payout: number;
  let cid: number;
  if (deriv.mode === "pat") {
    const prop = await deriv.send({ proposal: 1, ...contractParams, underlying_symbol: symbol });
    const proposalId = prop?.proposal?.id;
    if (!proposalId) throw new Error("Deriv did not return a proposal ID");
    payout = prop.proposal.payout as number;
    const buy = await deriv.send({ buy: proposalId, price: stake });
    cid = buy.buy.contract_id;
  } else {
    const buy = await deriv.send({ buy: 1, price: stake, parameters: { ...contractParams, symbol } });
    cid = buy.buy.contract_id;
    payout = Number(buy.buy.payout ?? 0);
  }
  const entryPrice = lastPrice[symbol] ?? 0;
  addLog(`Bought ${label(chosen)} · stake ${stake.toFixed(2)} · payout ${payout.toFixed(2)}`);

  let profit: number;
  if (tickMode) {
    const next = await waitNextTick(symbol);
    const d = next.digit;
    const p = chosen.pred ?? 0;
    const win =
      chosen.type === "EVEN" ? d % 2 === 0 :
      chosen.type === "ODD" ? d % 2 === 1 :
      chosen.type === "OVER" ? d > p :
      chosen.type === "UNDER" ? d < p :
      chosen.type === "DIFFERS" ? d !== p :
      chosen.type === "RISE" ? next.price > entryPrice :
      next.price < entryPrice;
    profit = win ? payout - stake : -stake;
  } else {
    profit = await new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => {
        off();
        reject(new Error("Contract result timed out"));
      }, 120_000);
      const off = deriv.onMessage((m) => {
        const poc = m.proposal_open_contract;
        if (m.msg_type !== "proposal_open_contract" || !poc || poc.contract_id !== cid) return;
        setState(() => ({ floating: poc.profit ?? 0 }));
        if (poc.is_sold) {
          clearTimeout(timeout);
          off();
          resolve(Number(poc.profit));
        }
      });
      deriv.send({ proposal_open_contract: 1, contract_id: cid, subscribe: 1 }).catch(() => {});
    });
  }
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
    consecLosses = 0;
    mgStep = 0;
    lossAccum = 0;
  } else {
    addLog(`LOSS ${profit.toFixed(2)} on ${label(chosen)}`, "loss");
    consecLosses++;
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

function label(c: Signal) {
  return c.pred !== undefined ? `${c.type} ${c.pred}` : c.type;
}
