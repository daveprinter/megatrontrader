import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { NumField, Panel, Segmented } from "@/components/kit";
import { connectAccount, disconnectAccount, launchEngine, stopEngine, watchMarket } from "@/lib/engine";
import {
  CONTRACTS,
  type ContractKey,
  HAS_PREDICTION,
  MARKETS,
  marketName,
  updateContract,
  updateSettings,
  useApp,
} from "@/lib/store";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Home · Megatron AI" },
      { name: "description", content: "Connect your Deriv account and configure Megatron AI trades." },
      { property: "og:title", content: "Megatron AI — Trade Configuration" },
      { property: "og:description", content: "Connect Deriv, watch live prices and pick contracts for the AI." },
    ],
  }),
  component: Home,
});

const SUB: Record<ContractKey, string> = {
  EVEN: "Last digit even",
  ODD: "Last digit odd",
  RISE: "Price goes up",
  FALL: "Price goes down",
  OVER: "Digit over N",
  UNDER: "Digit under N",
  DIFFERS: "Digit differs N",
};

function Home() {
  const s = useApp((x) => x.settings);
  const conn = useApp((x) => x.conn);
  const balance = useApp((x) => x.balance);
  const currency = useApp((x) => x.currency);
  const tick = useApp((x) => x.ticks[x.settings.market] ?? null);
  const session = useApp((x) => x.session);
  const engine = useApp((x) => x.engine);
  const [open, setOpen] = useState<ContractKey | null>(null);

  return (
    <>
      <Panel title="Deriv account">
        <label className="field-label">API token</label>
        <div className="flex gap-2">
          <input
            type="password"
            className="input"
            placeholder="Paste your Deriv API token"
            value={s.token}
            onChange={(e) => updateSettings({ token: e.target.value })}
          />
          {conn.status === "connected" ? (
            <button className="btn-ghost" onClick={disconnectAccount}>Disconnect</button>
          ) : (
            <button className="btn-primary" disabled={!s.token || conn.status === "connecting"} onClick={connectAccount}>
              {conn.status === "connecting" ? "…" : "Connect"}
            </button>
          )}
        </div>
        {conn.status === "error" && <p className="mt-2 text-sm text-destructive">{conn.error}</p>}
        <div className="mt-4 flex items-end justify-between">
          <div>
            <div className="text-xs text-muted-foreground">{conn.loginid ?? "Not connected"}</div>
            <div className="num text-3xl font-bold">
              {balance !== null ? `${balance.toFixed(2)}` : "—"}{" "}
              <span className="text-base text-muted-foreground">{currency}</span>
            </div>
          </div>
          <span className={cn("text-xs font-semibold uppercase", conn.status === "connected" ? "text-success" : "text-muted-foreground")}>
            {conn.status}
          </span>
        </div>
      </Panel>

      <Panel title="Live market">
        <select
          className="input"
          value={s.market}
          onChange={(e) => {
            updateSettings({ market: e.target.value });
            if (conn.status === "connected") watchMarket(e.target.value);
          }}
        >
          {MARKETS.map((m) => (
            <option key={m.symbol} value={m.symbol}>{m.name}</option>
          ))}
        </select>
        <div className="mt-4 grid grid-cols-[1fr_auto] items-center gap-4">
          <div>
            <div className="text-xs text-muted-foreground">Current price</div>
            <div className="num text-3xl font-bold">
              {tick && tick.symbol === s.market ? tick.price.toFixed(tick.pip) : "—"}
            </div>
          </div>
          <div className="flex h-20 w-20 flex-col items-center justify-center rounded-xl border-2 border-primary bg-primary/10">
            <span className="text-[10px] uppercase text-muted-foreground">Last digit</span>
            <span className="num text-4xl font-bold glow-text">
              {tick && tick.symbol === s.market ? tick.digit : "–"}
            </span>
          </div>
        </div>
      </Panel>

      <Panel title="Markets for AI">
        <Segmented
          value={s.multiMarket ? "multi" : "single"}
          options={[
            { value: "single", label: "Single market" },
            { value: "multi", label: "Multi indices" },
          ]}
          onChange={(v) => updateSettings({ multiMarket: v === "multi" })}
        />
        {s.multiMarket && (
          <div className="mt-4 space-y-4">
            <div className="grid grid-cols-2 gap-2">
              {MARKETS.map((m) => {
                const on = s.markets.includes(m.symbol);
                return (
                  <button
                    key={m.symbol}
                    className={cn("chip text-left text-xs", on && "chip-on")}
                    onClick={() =>
                      updateSettings({ markets: on ? s.markets.filter((x) => x !== m.symbol) : [...s.markets, m.symbol] })
                    }
                  >
                    {m.name}
                  </button>
                );
              })}
            </div>
            <div>
              <span className="field-label">Switching mode</span>
              <Segmented
                value={s.marketMode}
                options={[
                  { value: "auto", label: "Automated" },
                  { value: "manual", label: "Manual" },
                ]}
                onChange={(v) => updateSettings({ marketMode: v })}
              />
            </div>
            {s.marketMode === "manual" ? (
              <div className="grid grid-cols-2 gap-3">
                <NumField label="Max trades per market" value={s.marketMaxTrades} onChange={(n) => updateSettings({ marketMaxTrades: n })} />
                <NumField label="Max hours per market" value={s.marketMaxHours} onChange={(n) => updateSettings({ marketMaxHours: n })} />
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">AI switches when a market collects losses, gets choppy, or after banking strong profit.</p>
            )}
          </div>
        )}
      </Panel>

      <Panel title="Contract types">
        {open ? (
          <ContractPanel k={open} onClose={() => setOpen(null)} />
        ) : (
          <div className="grid grid-cols-2 gap-3">
            {CONTRACTS.map((k) => {
              const c = s.contracts[k];
              return (
                <button
                  key={k}
                  onClick={() => {
                    if (!c.enabled) updateContract(k, { enabled: true });
                    setOpen(k);
                  }}
                  className={cn("rounded-xl border bg-secondary p-4 text-left transition", c.enabled && "border-primary bg-primary/10")}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-display text-lg font-bold">{k}</span>
                    <span className={cn("h-2.5 w-2.5 rounded-full", c.enabled ? "bg-primary" : "bg-muted")} />
                  </div>
                  <div className="text-xs text-muted-foreground">{SUB[k]}</div>
                  {c.enabled && (
                    <div className="num mt-2 text-xs text-primary">
                      {c.ticks}t · max ${c.maxStake}
                      {HAS_PREDICTION.includes(k) && ` · [${c.preds.join(",")}]`}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </Panel>

      <Panel title="Trade type switching">
        <Segmented
          value={s.tradeMode}
          options={[
            { value: "auto", label: "Automated" },
            { value: "manual", label: "Manual" },
          ]}
          onChange={(v) => updateSettings({ tradeMode: v })}
        />
        {s.tradeMode === "manual" ? (
          <div className="mt-4 grid grid-cols-2 gap-3">
            <NumField label="Max trades per type / hour" value={s.typeMaxTrades} onChange={(n) => updateSettings({ typeMaxTrades: n })} />
            <NumField label="Max losses per type / hour" value={s.typeMaxLosses} onChange={(n) => updateSettings({ typeMaxLosses: n })} />
          </div>
        ) : (
          <p className="mt-3 text-xs text-muted-foreground">AI rotates contract types, favouring those performing well and cutting stake on losing ones.</p>
        )}
      </Panel>

      <Panel title="Session">
        {!session.startedAt ? (
          <p className="text-sm text-muted-foreground">
            No live session. <Link to="/settings" className="text-primary underline">Start one in Settings</Link>.
          </p>
        ) : (
          <div className="mb-3 space-y-1 text-sm">
            <div className="flex justify-between"><span className="text-muted-foreground">Status</span><span>{engine.status}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">Market</span><span>{marketName(engine.market)}</span></div>
            <div className="flex justify-between"><span className="text-muted-foreground">This hour</span><span className="num">${engine.hourProfit.toFixed(2)} / ${s.hourlyTarget}</span></div>
          </div>
        )}
        {session.launched ? (
          <button className="btn-danger w-full" onClick={stopEngine}>Stop Session</button>
        ) : (
          <button className="btn-primary w-full" disabled={!session.startedAt} onClick={launchEngine}>Launch Session</button>
        )}
      </Panel>
    </>
  );
}

function ContractPanel({ k, onClose }: { k: ContractKey; onClose: () => void }) {
  const c = useApp((x) => x.settings.contracts[k]);
  const hasPred = HAS_PREDICTION.includes(k);
  const toggleDigit = (d: number) => {
    if (c.predMode === "single") return updateContract(k, { preds: [d] });
    updateContract(k, { preds: c.preds.includes(d) ? c.preds.filter((x) => x !== d) : [...c.preds, d].sort() });
  };
  const invalid = (d: number) => (k === "OVER" && d === 9) || (k === "UNDER" && d === 0);
  return (
    <div className="space-y-4 rounded-xl border border-primary bg-primary/5 p-4">
      <div className="flex items-center justify-between">
        <span className="font-display text-xl font-bold text-primary">{k} settings</span>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <NumField label="Duration (ticks)" value={c.ticks} min={1} onChange={(n) => updateContract(k, { ticks: Math.max(1, Math.min(10, n)) })} />
        <NumField label="Max stake ($)" value={c.maxStake} step={0.1} min={0.35} onChange={(n) => updateContract(k, { maxStake: n })} />
      </div>
      {hasPred && (
        <>
          <div>
            <span className="field-label">Prediction mode</span>
            <select
              className="input"
              value={c.predMode}
              onChange={(e) => {
                const v = e.target.value as "single" | "multi";
                updateContract(k, { predMode: v, preds: v === "single" ? c.preds.slice(0, 1) : c.preds });
              }}
            >
              <option value="single">Single prediction</option>
              <option value="multi">Multiple predictions</option>
            </select>
          </div>
          <div className="grid grid-cols-5 gap-2">
            {Array.from({ length: 10 }, (_, d) => (
              <button
                key={d}
                disabled={invalid(d)}
                onClick={() => toggleDigit(d)}
                className={cn("chip num py-3 text-lg disabled:opacity-25", c.preds.includes(d) && "chip-on")}
              >
                {d}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="grid grid-cols-2 gap-2">
        <button
          className="btn-ghost"
          onClick={() => {
            updateContract(k, { enabled: false });
            onClose();
          }}
        >
          Disable
        </button>
        <button className="btn-primary" onClick={onClose}>Close panel</button>
      </div>
    </div>
  );
}
