import { Lock, Timer } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { formatNear } from "@/lib/utils";
import type { Draft } from "./types";

/** Exactly what the gallery will show. Nothing private appears here. */
export function PublicPreview({ draft, creator }: { draft: Draft; creator: string | null }) {
  const fee = Number(draft.fee);
  return (
    <div className="space-y-4 rounded-md border border-border bg-surface p-5" aria-label="Public preview">
      <p className="label-caps">Preview</p>
      <div>
        <p className="font-mono text-lg font-semibold">{draft.market ? draft.market.toUpperCase() : "Market"}</p>
        <p className="label-caps mt-1">{draft.direction || "direction"} · v1</p>
      </div>
      <div className="flex items-end justify-between">
        <p className="font-mono text-2xl">{fee > 0 ? formatNear(fee) : "– NEAR"}</p>
        <Badge tone="muted"><Timer className="h-3 w-3" aria-hidden />{draft.expiry ? draft.expiry.replace("T", " ") : "ConDex sets it"}</Badge>
      </div>
      <div className="flex items-center justify-between border-t border-border pt-3 text-xs text-muted">
        <span className="font-mono">{creator ?? "connect wallet"}</span>
        <span className="flex items-center gap-1"><Lock className="h-3 w-3" aria-hidden />Private</span>
      </div>
    </div>
  );
}
