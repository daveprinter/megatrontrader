import { useSyncExternalStore } from "react";

export const MARKETS = [
  { symbol: "1HZ10V", name: "Volatility 10 (1s)" },
  { symbol: "1HZ15V", name: "Volatility 15 (1s)" },
  { symbol: "1HZ25V", name: "Volatility 25 (1s)" },
  { symbol: "1HZ30V", name: "Volatility 30 (1s)" },
  { symbol: "1HZ50V", name: "Volatility 50 (1s)" },
  { symbol: "1HZ75V", name: "Volatility 75 (1s)" },
  { symbol: "1HZ90V", name: "Volatility 90 (1s)" },
  { symbol: "1HZ100V", name: "Volatility 100 (1s)" },
  { symbol: "R_10", name: "Volatility 10 Index" },
  { symbol: "R_25", name: "Volatility 25 Index" },
  { symbol: "R_50", name: "Volatility 50 Index" },
  { symbol: "R_75", name: "Volatility 75 Index" },
  { symbol: "R_100", name: "Volatility 100 Index" },
];
export const marketName = (s: string) => MARKETS.find((m) => m.symbol === s)?.name ?? s;

export const CONTRACTS = ["EVEN", "ODD", "RISE", "FALL", "OVER", "UNDER", "DIFFERS"] as const;
export type ContractKey = (typeof CONTRACTS)[number];
export const HAS_PREDICTION: ContractKey[] = ["OVER", "UNDER", "DIFFERS"];
export const DERIV_TYPE: Record<ContractKey, string> = {
  EVEN: "DIGITEVEN",
  ODD: "DIGITODD",
  RISE: "CALL",
  FALL: "PUT",
  OVER: "DIGITOVER",
  UNDER: "DIGITUNDER",
  DIFFERS: "DIGITDIFF",
};

export interface ContractCfg {
  enabled: boolean;
  ticks: number;
  maxStake: number;
  predMode: "single" | "multi";
  preds: number[];
}

export interface Settings {
  token: string;
  market: string;
  multiMarket: boolean;
  markets: string[];
  marketMode: "auto" | "manual";
  marketMaxTrades: number;
  marketMaxHours: number;
  contracts: Record<ContractKey, ContractCfg>;
  tradeMode: "auto" | "manual";
  typeMaxTrades: number;
  typeMaxLosses: number;
  hourlyTarget: number;
  hoursPerDay: number;
  stopLoss: number;
  mgEnabled: boolean;
  mgMultiplier: number;
  mgMaxMultiplier: number;
  mgMaxSteps: number;
  recoveryMode: "same" | "different" | "auto";
  recoveryCoverage: number; // percent
  tradeSpeed: "normal" | "tick";
}

export interface Trade {
  id: string;
  time: number;
  type: ContractKey;
  pred?: number | undefined;
  symbol: string;
  stake: number;
  profit: number;
  recovery: boolean;
}

export interface AppState {
  settings: Settings;
  session: { startedAt: number | null; launched: boolean };
  conn: { status: "idle" | "connecting" | "connected" | "error"; error?: string | undefined; loginid?: string | undefined };
  balance: number | null;
  currency: string;
  ticks: Record<string, { price: number; digit: number; pip: number; symbol: string; prev?: number | undefined }>;
  errors: { t: number; msg: string }[];
  trades: Trade[];
  log: { t: number; msg: string; kind: "info" | "win" | "loss" | "warn" }[];
  floating: number;
  engine: { market: string; status: string; hourProfit: number; nextAt: number | null; cooldownUntil?: number | null; signal?: string };
}

const cc = (over?: Partial<ContractCfg>): ContractCfg => ({
  enabled: false,
  ticks: 1,
  maxStake: 2,
  predMode: "single",
  preds: [],
  ...over,
});

export const defaultSettings: Settings = {
  token: "",
  market: "1HZ10V",
  multiMarket: false,
  markets: ["1HZ10V"],
  marketMode: "auto",
  marketMaxTrades: 20,
  marketMaxHours: 30,
  contracts: {
    EVEN: cc(),
    ODD: cc(),
    RISE: cc(),
    FALL: cc(),
    OVER: cc({ preds: [1] }),
    UNDER: cc({ preds: [8] }),
    DIFFERS: cc({ preds: [5] }),
  },
  tradeMode: "auto",
  typeMaxTrades: 5,
  typeMaxLosses: 2,
  hourlyTarget: 1,
  hoursPerDay: 24,
  stopLoss: 10,
  mgEnabled: true,
  mgMultiplier: 1.5,
  mgMaxMultiplier: 2,
  mgMaxSteps: 3,
  recoveryMode: "auto",
  recoveryCoverage: 80,
  tradeSpeed: "normal",
};

let state: AppState = {
  settings: defaultSettings,
  session: { startedAt: null, launched: false },
  conn: { status: "idle" },
  balance: null,
  currency: "USD",
  ticks: {},
  errors: [],
  trades: [],
  log: [],
  floating: 0,
  engine: { market: "1HZ10V", status: "Idle", hourProfit: 0, nextAt: null },
};

const listeners = new Set<() => void>();
const KEY = "megatron-ai-v1";

export const getState = () => state;
export function setState(fn: (s: AppState) => Partial<AppState>) {
  state = { ...state, ...fn(state) };
  listeners.forEach((l) => l());
  persist();
}
export function updateSettings(patch: Partial<Settings>) {
  setState((s) => ({ settings: { ...s.settings, ...patch } }));
}
export function updateContract(k: ContractKey, patch: Partial<ContractCfg>) {
  setState((s) => ({
    settings: {
      ...s.settings,
      contracts: { ...s.settings.contracts, [k]: { ...s.settings.contracts[k], ...patch } },
    },
  }));
}
export function addLog(msg: string, kind: AppState["log"][number]["kind"] = "info") {
  setState((s) => ({ log: [{ t: Date.now(), msg, kind }, ...s.log].slice(0, 500) }));
}

export function addError(msg: string) {
  setState((s) => {
    if (s.errors[0]?.msg === msg && Date.now() - s.errors[0].t < 3000) return {};
    return { errors: [{ t: Date.now(), msg }, ...s.errors].slice(0, 200) };
  });
}
export function clearErrors() {
  setState(() => ({ errors: [] }));
}

let hydrated = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
function writeNow() {
  const { settings, session, trades, log, errors } = state;
  try {
    localStorage.setItem(KEY, JSON.stringify({ settings, session, trades, log, errors }));
  } catch {
    /* quota */
  }
}
function persist() {
  if (!hydrated || typeof window === "undefined") return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(writeNow, 300);
}
export function hydrate() {
  if (typeof window !== "undefined" && !hydrated) {
    const flush = () => hydrated && writeNow();
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flush());
  }
  if (hydrated) return;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw);
      state = {
        ...state,
        settings: {
          ...defaultSettings,
          ...p.settings,
          contracts: { ...defaultSettings.contracts, ...p.settings?.contracts },
        },
        session: p.session ?? state.session,
        trades: p.trades ?? [],
        log: p.log ?? [],
        errors: p.errors ?? [],
      };
    }
  } catch {
    /* ignore */
  }
  hydrated = true;
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export function useApp<T>(sel: (s: AppState) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => sel(state),
    () => sel(state),
  );
}

export function nairobiTime(d = new Date()) {
  return d.toLocaleTimeString("en-US", {
    timeZone: "Africa/Nairobi",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}
