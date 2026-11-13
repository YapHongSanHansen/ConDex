"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";
import { formatNear } from "@/lib/utils";

export function Stats() {
  const q = useQuery({ queryKey: ["stats"], queryFn: () => api.insights.getStats() });
  const items = [
    ["Insights", q.data?.insights_listed],
    ["Borrows today", q.data?.borrows_today],
    ["Paid out", q.data ? formatNear(q.data.paid_to_creators) : undefined],
  ] as const;
  return (
    <dl className="grid grid-cols-3 gap-3 pt-2">
      {items.map(([label, value]) => (
        <div key={label} className="rounded-md border border-border bg-surface p-3">
          <dt className="label-caps flex items-center gap-1.5">{label}</dt>
          <dd className="mt-1.5 font-mono text-xl">{q.isError ? "n/a" : value === undefined ? <Skeleton className="h-6 w-12" /> : value}</dd>
        </div>
      ))}
    </dl>
  );
}
