"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { SortKey } from "@/lib/api/types";
import { Slider } from "@/components/ui/slider";
import { cn, formatNear } from "@/lib/utils";

export interface Filters {
  market: string;
  direction?: "long" | "short";
  includeExpired: boolean;
  maxPrice: number;
  expiry?: "soon" | "later";
  sort: SortKey;
}

export const MAX_PRICE = 3;
export const DEFAULT_FILTERS: Filters = { market: "", maxPrice: MAX_PRICE, sort: "newest", includeExpired: false };

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick}
      className={cn("cursor-pointer rounded-full border px-3 py-1 text-xs", active ? "border-accent bg-accent/10 text-accent" : "border-border text-muted hover:text-text")}>
      {children}
    </button>
  );
}

export function FilterRail({ value, onChange }: { value: Filters; onChange: (f: Filters) => void }) {
  const set = (p: Partial<Filters>) => onChange({ ...value, ...p });
  const markets = useQuery({ queryKey: ["markets"], queryFn: () => api.insights.listMarkets(), staleTime: 60_000 });
  return (
    <div className="space-y-6">
      <fieldset className="space-y-3">
        <legend className="label-caps mb-2.5">Market</legend>
        {markets.data?.length === 0 && <p className="text-xs text-muted">No markets yet.</p>}
        <div className="flex flex-wrap gap-2">
          {(markets.data ?? []).map((c) => <Chip key={c} active={value.market === c} onClick={() => set({ market: value.market === c ? "" : c })}>{c}</Chip>)}
        </div>
      </fieldset>
      <fieldset className="space-y-3">
        <legend className="label-caps mb-2.5">Direction</legend>
        <div className="flex flex-wrap gap-2">
          {(["long", "short"] as const).map((d) => <Chip key={d} active={value.direction === d} onClick={() => set({ direction: value.direction === d ? undefined : d })}><span className="capitalize">{d}</span></Chip>)}
        </div>
      </fieldset>
      <div className="space-y-3">
        <div className="flex items-baseline justify-between"><span className="label-caps">Max fee</span><span className="font-mono text-xs">{value.maxPrice >= MAX_PRICE ? "any" : formatNear(value.maxPrice)}</span></div>
        <Slider label="Maximum price in NEAR" min={0.1} max={MAX_PRICE} step={0.05} value={[value.maxPrice]} onValueChange={([v]) => set({ maxPrice: v })} />
      </div>
      <fieldset className="space-y-3">
        <legend className="label-caps mb-2.5">Expiry</legend>
        <div className="flex flex-wrap gap-2">
          <Chip active={value.expiry === "soon"} onClick={() => set({ expiry: value.expiry === "soon" ? undefined : "soon" })}>Under 24h</Chip>
          <Chip active={value.expiry === "later"} onClick={() => set({ expiry: value.expiry === "later" ? undefined : "later" })}>Later</Chip>
          <Chip active={value.includeExpired} onClick={() => set({ includeExpired: !value.includeExpired })}>Show expired</Chip>
        </div>
      </fieldset>
      <div className="space-y-3">
        <label htmlFor="sort" className="label-caps block">Sort</label>
        <select id="sort" value={value.sort} onChange={(e) => set({ sort: e.target.value as SortKey })} className="h-9 w-full rounded-md border border-border bg-surface px-3 text-sm">
          <option value="newest">Newest</option>
          <option value="cheapest">Lowest fee</option>
          <option value="expiring">Expiring soon</option>
        </select>
      </div>
    </div>
  );
}
