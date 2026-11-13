"use client";

import Link from "next/link";
import { Lock } from "lucide-react";
import { useNow } from "@/hooks/use-now";
import type { Insight } from "@/lib/api/types";
import { cn, formatAmount, isExpiringSoon, timeUntil } from "@/lib/utils";

const DOT: Record<Insight["status"], string> = { live: "bg-accent", expired: "bg-muted", revoked: "bg-danger" };
const LABEL: Record<Insight["status"], string> = { live: "Live", expired: "Expired", revoked: "Revoked" };

export function InsightCard({ insight, compact }: { insight: Insight; compact?: boolean }) {
  const now = useNow();
  const soon = insight.status === "live" && isExpiringSoon(insight.expires_at, now);
  return (
    <Link
      href={`/gallery/${insight.id}`}
      className={cn("group flex flex-col rounded-md border border-border bg-surface p-4 transition-colors hover:border-accent/70 hover:bg-surface-2", compact && "w-64 shrink-0")}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="truncate font-mono text-[15px] font-semibold">{insight.market}</p>
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted">
          <span className={cn("h-1.5 w-1.5 rounded-full", DOT[insight.status])} aria-hidden />{LABEL[insight.status]}
        </span>
      </div>
      <p className="mt-1 text-xs text-muted"><span className="capitalize">{insight.horizon}</span> · v{insight.version}</p>

      <div className="mt-5 flex items-baseline gap-1.5">
        <span className="font-mono text-2xl font-medium tabular-nums">{formatAmount(insight.price)}</span>
        <span className="font-mono text-xs text-muted">NEAR</span>
      </div>

      <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-3 text-xs">
        <span className={cn("shrink-0 whitespace-nowrap font-mono", soon ? "text-warning" : "text-muted")}>{insight.status === "live" ? `${soon ? "Ends " : ""}${timeUntil(insight.expires_at, now)}` : "Closed"}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-muted">
          <span className="truncate font-mono">{insight.creator}</span>
          <Lock className="h-3 w-3 shrink-0" aria-label="Private context stays with its creator" />
        </span>
      </div>
    </Link>
  );
}
