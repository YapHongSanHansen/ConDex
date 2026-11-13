"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { InsightCard } from "@/components/gallery/insight-card";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { MockBadge } from "@/components/ui/mock-badge";

export function LiveBoard() {
  const q = useQuery({ queryKey: ["insights", "latest"], queryFn: () => api.insights.listInsights({ sort: "newest" }) });
  return (
    <section aria-labelledby="live-board" className="space-y-4">
      <div className="flex items-center gap-3"><h2 id="live-board" className="text-lg font-semibold">Latest</h2><MockBadge /></div>
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : q.isLoading ? (
        <div className="flex gap-4 overflow-hidden">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-40 w-72 shrink-0" />)}</div>
      ) : (
        <div className="overflow-hidden" style={{ maskImage: "linear-gradient(90deg, transparent, #000 4%, #000 96%, transparent)" }}>
          <div className="marquee-track flex gap-4">
            {[...q.data!.items, ...q.data!.items].map((i, n) => (
              <div key={n} aria-hidden={n >= q.data!.items.length || undefined} className="contents">
                <InsightCard insight={i} compact />
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
