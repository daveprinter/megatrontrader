import { createFileRoute } from "@tanstack/react-router";
import { Panel, Stat } from "@/components/kit";
import { CONTRACTS, marketName, setState, useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/history")({
  head: () => ({
    meta: [
      { title: "History · Megatron AI" },
      { name: "description", content: "Accumulated profit, trades taken and the Megatron AI log." },
      { property: "og:title", content: "Megatron AI — History" },
      { property: "og:description", content: "Track profit, trades and logs from Megatron AI." },
    ],
  }),
  component: HistoryPage,
});

function HistoryPage() {
  const trades = useApp((x) => x.trades);
  const log = useApp((x) => x.log);
  const floating = useApp((x) => x.floating);
  const stopLoss = useApp((x) => x.settings.stopLoss);

  const profit = trades.reduce((a, t) => a + t.profit, 0);
  const wins = trades.filter((t) => t.profit >= 0).length;
  const fmt = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}`;

  return (
    <>
      <Panel title="Stats">
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Accumulated profit" value={fmt(profit)} tone={profit >= 0 ? "up" : "down"} />
          <Stat label="Floating P/L" value={fmt(floating)} tone={floating >= 0 ? "up" : "down"} />
          <Stat label="Stop loss" value={`-${stopLoss.toFixed(2)}`} />
          <Stat label="Trades" value={`${trades.length} (${wins}W / ${trades.length - wins}L)`} />
        </div>
        <div className="mt-3 grid grid-cols-4 gap-2">
          {CONTRACTS.map((k) => {
            const n = trades.filter((t) => t.type === k).length;
            return (
              <div key={k} className="rounded-lg border bg-secondary/50 p-2 text-center">
                <div className="text-[10px] text-muted-foreground">{k}</div>
                <div className="num font-semibold">{n}</div>
              </div>
            );
          })}
        </div>
        <button className="btn-ghost mt-3 w-full" onClick={() => setState(() => ({ trades: [] }))}>
          Clear stats
        </button>
      </Panel>

      <Panel title="Trades">
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {trades.length === 0 && <p className="text-sm text-muted-foreground">No trades yet.</p>}
          {trades.slice(0, 200).map((t) => (
            <div key={t.id} className="flex items-center justify-between rounded-md bg-secondary/50 px-3 py-2 text-xs">
              <div>
                <span className="font-semibold">{t.type}{t.pred !== undefined ? ` ${t.pred}` : ""}</span>
                {t.recovery && <span className="ml-1 text-warning">R</span>}
                <div className="text-muted-foreground">{marketName(t.symbol)} · {new Date(t.time).toLocaleTimeString("en-US", { timeZone: "Africa/Nairobi" })}</div>
              </div>
              <div className="text-right num">
                <div className={t.profit >= 0 ? "text-success" : "text-destructive"}>{fmt(t.profit)}</div>
                <div className="text-muted-foreground">${t.stake.toFixed(2)}</div>
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Log">
        <div className="max-h-80 space-y-1 overflow-y-auto rounded-lg bg-background p-2 font-mono text-[11px]">
          {log.length === 0 && <p className="text-muted-foreground">Log is empty.</p>}
          {log.map((l, i) => (
            <div
              key={i}
              className={cn(
                l.kind === "win" && "text-success",
                l.kind === "loss" && "text-destructive",
                l.kind === "warn" && "text-warning",
              )}
            >
              <span className="text-muted-foreground">
                {new Date(l.t).toLocaleTimeString("en-US", { timeZone: "Africa/Nairobi", hour12: false })}
              </span>{" "}
              {l.msg}
            </div>
          ))}
        </div>
        <button className="btn-ghost mt-3 w-full" onClick={() => setState(() => ({ log: [] }))}>
          Clear log
        </button>
      </Panel>
    </>
  );
}
