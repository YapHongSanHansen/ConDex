import { CheckCircle2, Clock, Hourglass, Ban, CircleDashed, Undo2, PackageCheck, XCircle, KeyRound } from "lucide-react";
import { Badge } from "./badge";

type Tone = "accent" | "warning" | "danger" | "muted" | "neutral";
type Entry = { label: string; tone: Tone; Icon: typeof Clock; meaning: string };

// Thesis, order, trade and receipt states, in the words the backend uses for them.
const MAP: Record<string, Entry> = {
  live: { label: "Live", tone: "accent", Icon: CircleDashed, meaning: "Open: a trade can still be linked to it." },
  expired: { label: "Expired", tone: "muted", Icon: Hourglass, meaning: "No new trade can be linked. Reading and earlier trades are unaffected." },
  revoked: { label: "Revoked", tone: "danger", Icon: Ban, meaning: "Blocked." },
  awaiting_approval: { label: "Awaiting approval", tone: "warning", Icon: KeyRound, meaning: "The trader still has to approve the fee in their wallet." },
  submitted: { label: "Submitted", tone: "warning", Icon: Clock, meaning: "Sent to the venue. No fee yet." },
  open: { label: "Open", tone: "warning", Icon: Clock, meaning: "Accepted by the venue and waiting to fill. The fee is reserved, not charged." },
  partially_filled: { label: "Part filled", tone: "accent", Icon: PackageCheck, meaning: "Filled in part. The fee was charged once, on the first fill." },
  filled: { label: "Filled", tone: "accent", Icon: CheckCircle2, meaning: "Filled. The fee was charged once and paid to the creator." },
  cancelled: { label: "Cancelled", tone: "muted", Icon: XCircle, meaning: "Cancelled before any fill, so nothing was charged." },
  rejected: { label: "Rejected", tone: "danger", Icon: Ban, meaning: "Rejected by the venue. The reserve was released." },
  closed: { label: "Closed", tone: "accent", Icon: CheckCircle2, meaning: "The position is fully closed and its result is recorded." },
  partially_closed: { label: "Part closed", tone: "warning", Icon: PackageCheck, meaning: "Part of the position is closed." },
  settled: { label: "Settled", tone: "accent", Icon: CheckCircle2, meaning: "Fee paid to the creator." },
  pending: { label: "Pending", tone: "warning", Icon: Clock, meaning: "Reserved, waiting for the first fill." },
  released: { label: "Released", tone: "muted", Icon: Undo2, meaning: "No fill, so no fee." },
};

const FALLBACK: Entry = { label: "", tone: "neutral", Icon: CircleDashed, meaning: "" };

/** Colour + icon + text, never colour alone. */
export function StatusBadge({ status }: { status: string }) {
  const m = MAP[status] ?? { ...FALLBACK, label: status.replace(/_/g, " ") };
  return (
    <Badge tone={m.tone} title={m.meaning}>
      <m.Icon className="h-3 w-3" aria-hidden />
      {m.label}
    </Badge>
  );
}

export function StatusLegend({ statuses }: { statuses: string[] }) {
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted">
      {statuses.map((s) => (
        <div key={s} className="flex items-center gap-2"><dt><StatusBadge status={s} /></dt><dd>{MAP[s]?.meaning}</dd></div>
      ))}
    </dl>
  );
}
