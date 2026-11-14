"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { LayoutGrid, List, Search, SlidersHorizontal } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { StatusBadge } from "@/components/ui/status-badge";
import { useNow } from "@/hooks/use-now";
import { cn, formatNear, timeUntil, truncateAccount } from "@/lib/utils";
import { InsightCard } from "./insight-card";
import { DEFAULT_FILTERS, FilterRail, MAX_PRICE, type Filters } from "./filters";

export function GalleryView() {
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"grid" | "table">("grid");
  const searchRef = useRef<HTMLInputElement>(null);
  const now = useNow();

  // Debounce free-text search into the market filter.
  const [debounced, setDebounced] = useState("");
  useEffect(() => { const t = setTimeout(() => setDebounced(search), 250); return () => clearTimeout(t); }, [search]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)) { e.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const market = debounced || filters.market;
  const q = useInfiniteQuery({
    queryKey: ["insights", { ...filters, market }],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.insights.listInsights({
        market: market || undefined,
        direction: filters.direction,
        include_expired: filters.includeExpired,
        max_price: filters.maxPrice >= MAX_PRICE ? undefined : filters.maxPrice,
        expiry: filters.expiry,
        sort: filters.sort,
        cursor: pageParam,
      }),
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });

  const items = useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const total = q.data?.pages[0]?.total ?? 0;
  const filtered = JSON.stringify(filters) !== JSON.stringify(DEFAULT_FILTERS) || search !== "";
  const clear = () => { setFilters(DEFAULT_FILTERS); setSearch(""); };

  return (
    <div className="grid gap-8 lg:grid-cols-[260px_1fr]">
      <aside className="hidden lg:block" aria-label="Filters">
        <div className="sticky top-20 rounded-md border border-border bg-surface p-5">
          <FilterRail value={filters} onChange={setFilters} />
          <Button variant="ghost" size="sm" className="mt-6 w-full" disabled={!filtered} onClick={clear}>Clear filters</Button>
        </div>
      </aside>

      <section aria-label="Results" className="min-w-0 space-y-5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-0 flex-1 basis-64">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
            <Input ref={searchRef} aria-label="Search markets" placeholder="Search markets, for example ETH  ( / )" className="h-9 pl-9" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <Dialog>
            <DialogTrigger asChild><Button variant="secondary" className="lg:hidden"><SlidersHorizontal className="h-4 w-4" />Filters</Button></DialogTrigger>
            <DialogContent side="left" title="Filters">
              <FilterRail value={filters} onChange={setFilters} />
              <Button variant="ghost" size="sm" className="mt-6 w-full" disabled={!filtered} onClick={clear}>Clear filters</Button>
            </DialogContent>
          </Dialog>
          <div className="flex rounded-md border border-border" role="group" aria-label="View">
            {([["grid", LayoutGrid], ["table", List]] as const).map(([v, Icon]) => (
              <button key={v} aria-label={`${v} view`} aria-pressed={view === v} onClick={() => setView(v)} className={cn("cursor-pointer p-2.5", view === v ? "bg-surface-2 text-text" : "text-muted")}><Icon className="h-4 w-4" /></button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted" aria-live="polite">{q.isLoading ? "Loading…" : `${total} thesis${total === 1 ? "" : "es"}`}</p>
        </div>

        {q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : q.isLoading ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-36" />)}</div>
        ) : items.length === 0 ? (
          <EmptyState title="No theses match." body={filtered ? "Try fewer filters, or include expired ones." : "Nothing has been published yet."} action={filtered ? <Button variant="secondary" onClick={clear}>Clear filters</Button> : <Button asChild variant="primary"><Link href="/publish">Publish a thesis</Link></Button>} />
        ) : view === "grid" ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{items.map((i) => <InsightCard key={i.id} insight={i} />)}</div>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border bg-surface">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="label-caps border-b border-border"><tr>{["Market", "Direction", "Fee", "Expires", "Ver.", "Creator", "Status"].map((h) => <th key={h} scope="col" className="px-4 py-3 font-normal">{h}</th>)}</tr></thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id} className="border-b border-border last:border-0 hover:bg-surface-2">
                    <td className="px-4 py-3 font-mono"><Link className="hover:text-accent" href={`/gallery/${i.id}`}>{i.market}</Link></td>
                    <td className="px-4 py-3 capitalize">{i.direction}</td>
                    <td className="px-4 py-3 font-mono">{formatNear(i.price)}</td>
                    <td className="px-4 py-3 font-mono">{timeUntil(i.expires_at, now)}</td>
                    <td className="px-4 py-3 font-mono">v{i.version}</td>
                    <td className="px-4 py-3 font-mono text-muted">{truncateAccount(i.creator)}</td>
                    <td className="px-4 py-3"><StatusBadge status={i.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {q.hasNextPage && (
          <div className="flex justify-center"><Button variant="secondary" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>Load more</Button></div>
        )}
        
      </section>
    </div>
  );
}
