import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Panel({ title, children, className }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("panel", className)}>
      {title && <h2 className="panel-title">{title}</h2>}
      {children}
    </section>
  );
}

export function NumField({
  label,
  value,
  onChange,
  step = 1,
  min = 0,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  step?: number;
  min?: number;
}) {
  return (
    <label className="block">
      <span className="field-label">{label}</span>
      <input
        type="number"
        className="input"
        value={value}
        step={step}
        min={min}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn("chip", value === o.value && "chip-on")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (b: boolean) => void; label: string }) {
  return (
    <button type="button" onClick={() => onChange(!checked)} className="flex w-full items-center justify-between py-1">
      <span className="text-sm">{label}</span>
      <span className={cn("relative h-6 w-11 rounded-full border transition", checked ? "bg-primary" : "bg-secondary")}>
        <span
          className={cn(
            "absolute top-0.5 h-4.5 w-4.5 rounded-full bg-foreground transition-all",
            checked ? "left-5.5" : "left-0.5",
          )}
        />
      </span>
    </button>
  );
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: "up" | "down" }) {
  return (
    <div className="rounded-lg border bg-secondary/50 p-3">
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn("num mt-1 text-lg font-semibold", tone === "up" && "text-success", tone === "down" && "text-destructive")}>
        {value}
      </div>
    </div>
  );
}
