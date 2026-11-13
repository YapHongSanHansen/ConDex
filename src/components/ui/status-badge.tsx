import { CheckCircle2, Clock, Hourglass, Ban, CircleDashed, Undo2, PackageCheck } from "lucide-react";
import type { BorrowStatus, InsightStatus, ReceiptStatus } from "@/lib/api/types";
import { Badge } from "./badge";

type Any = BorrowStatus | InsightStatus | ReceiptStatus;
const MAP: Record<Any, { label: string; tone: "accent" | "warning" | "danger" | "muted" | "neutral"; Icon: typeof Clock; meaning: string }> = {
  active: { label: "Active", tone: "warning", Icon: Clock, meaning: "Fee reserved, context not yet fetched." },
  retrieved: { label: "Retrieved", tone: "warning", Icon: PackageCheck, meaning: "Context fetched. Fee still reserved until a trade is reported." },
  traded: { label: "Trade executed", tone: "accent", Icon: CheckCircle2, meaning: "Fee charged once and paid to the creator." },
  expired: { label: "Expired", tone: "muted", Icon: Hourglass, meaning: "Expired without a trade. Reserve released, zero charge." },
  revoked: { label: "Revoked", tone: "danger", Icon: Ban, meaning: "Key blocked for new requests." },
  live: { label: "Live", tone: "accent", Icon: CircleDashed, meaning: "Open for borrowing." },
  settled: { label: "Settled", tone: "accent", Icon: CheckCircle2, meaning: "Trade executed. Fee paid to creator." },
  pending: { label: "Pending", tone: "warning", Icon: Clock, meaning: "Reserved, waiting for a trade to be reported." },
  released: { label: "Released", tone: "muted", Icon: Undo2, meaning: "Expired without a trade, no fee." },
};

/** Colour + icon + text, never colour alone. */
export function StatusBadge({ status }: { status: Any }) {
  const m = MAP[status];
  return (
    <Badge tone={m.tone} title={m.meaning}>
      <m.Icon className="h-3 w-3" aria-hidden />
      {m.label}
    </Badge>
  );
}

export function StatusLegend({ statuses }: { statuses: Any[] }) {
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted">
      {statuses.map((s) => (
        <div key={s} className="flex items-center gap-2"><dt><StatusBadge status={s} /></dt><dd>{MAP[s].meaning}</dd></div>
      ))}
    </dl>
  );
}
