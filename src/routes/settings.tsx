import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { NumField, Panel, Segmented, Toggle } from "@/components/kit";
import { stopEngine } from "@/lib/engine";
import { addLog, nairobiTime, setState, updateSettings, useApp } from "@/lib/store";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings · Megatron AI" },
      { name: "description", content: "Session, hourly profit target, martingale and recovery settings." },
      { property: "og:title", content: "Megatron AI — Settings" },
      { property: "og:description", content: "Configure sessions, martingale and recovery for Megatron AI." },
    ],
  }),
  component: SettingsPage,
});

function fmtDur(ms: number) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${h}h ${String(m).padStart(2, "0")}m ${String(sec).padStart(2, "0")}s`;
}

function SettingsPage() {
  const s = useApp((x) => x.settings);
  const session = useApp((x) => x.session);
  const nav = useNavigate();
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, []);

  return (
    <>
      <Panel title="Session">
        <div className="mb-4 text-center">
          <div className="text-xs text-muted-foreground">Nairobi time</div>
          <div className="num text-3xl font-bold glow-text">{now ? nairobiTime(new Date(now)) : "--"}</div>
        </div>
        {session.startedAt ? (
          <>
            <div className="mb-3 rounded-lg border border-success/40 bg-success/10 p-3 text-sm">
              <div className="font-semibold text-success">● LIVE SESSION</div>
              <div className="text-muted-foreground">
                Started {nairobiTime(new Date(session.startedAt))} · running{" "}
                <span className="num text-foreground">{fmtDur(Math.max(0, now - session.startedAt))}</span>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                className="btn-danger"
                onClick={() => {
                  stopEngine();
                  setState(() => ({ session: { startedAt: null, launched: false } }));
                  addLog("Session ended");
                }}
              >
                End Session
              </button>
              <button className="btn-primary" onClick={() => nav({ to: "/" })}>Launch →</button>
            </div>
          </>
        ) : (
          <button
            className="btn-primary w-full"
            onClick={() => {
              setState(() => ({ session: { startedAt: Date.now(), launched: false } }));
              addLog(`Session started at ${nairobiTime()} EAT`);
            }}
          >
            Start Session
          </button>
        )}
      </Panel>

      <Panel title="Trade Speed">
        <Segmented
          value={s.tradeSpeed}
          options={[
            { value: "normal", label: "Normal Speed" },
            { value: "tick", label: "Every Tick Speed" },
          ]}
          onChange={(v) => updateSettings({ tradeSpeed: v })}
        />
        <p className="mt-2 text-xs text-muted-foreground">
          {s.tradeSpeed === "normal"
            ? "Waits for each contract to settle on Deriv before sending the next."
            : "Trades on every tick: each 1-tick contract is settled on the next tick and the next trade (with martingale applied instantly) goes out on that same tick."}
        </p>
      </Panel>

      <Panel title="Targets">
        <div className="grid grid-cols-2 gap-3">
          <NumField label="Profit per hour ($)" value={s.hourlyTarget} step={0.1} onChange={(n) => updateSettings({ hourlyTarget: n })} />
          <NumField label="Hours per 24h day" value={s.hoursPerDay} min={1} onChange={(n) => updateSettings({ hoursPerDay: Math.max(1, Math.min(24, n)) })} />
          <NumField label="Session stop loss ($)" value={s.stopLoss} step={0.5} onChange={(n) => updateSettings({ stopLoss: n })} />
        </div>
      </Panel>

      <Panel title="Martingale">
        <Toggle label="Enable martingale" checked={s.mgEnabled} onChange={(b) => updateSettings({ mgEnabled: b })} />
        {s.mgEnabled && (
          <div className="mt-3 grid grid-cols-2 gap-3">
            <NumField label="Multiplier" value={s.mgMultiplier} step={0.1} min={1} onChange={(n) => updateSettings({ mgMultiplier: n })} />
            <NumField label="Max multiplier allowed" value={s.mgMaxMultiplier} step={0.1} min={1} onChange={(n) => updateSettings({ mgMaxMultiplier: n })} />
            <NumField label="Max martingale steps" value={s.mgMaxSteps} min={1} onChange={(n) => updateSettings({ mgMaxSteps: Math.max(1, n) })} />
            <p className="col-span-2 text-xs text-muted-foreground">
              Stakes always rounded to 2 decimals. Multiplier never exceeds {Math.min(s.mgMultiplier, s.mgMaxMultiplier)}×. After {s.mgMaxSteps} steps the stake resets.
            </p>
          </div>
        )}
      </Panel>

      <Panel title="Recovery mode">
        <Segmented
          value={s.recoveryMode}
          options={[
            { value: "same", label: "Same type" },
            { value: "different", label: "Different" },
            { value: "auto", label: "AI decides" },
          ]}
          onChange={(v) => updateSettings({ recoveryMode: v })}
        />
        <div className="mt-3">
          <NumField
            label="Minimum loss coverage (%)"
            value={s.recoveryCoverage}
            min={50}
            onChange={(n) => updateSettings({ recoveryCoverage: Math.max(50, Math.min(150, n)) })}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            Before recovering, the AI checks the expected payout and only picks contracts that cover at least this share of the loss.
          </p>
        </div>
      </Panel>
    </>
  );
}
