import { USE_MOCKS } from "@/lib/config";
import { cn } from "@/lib/utils";

/** Visible only while NEXT_PUBLIC_USE_MOCKS=true. */
export function MockBadge({ className }: { className?: string }) {
  if (!USE_MOCKS) return null;
  return (
    <span
      title="Mock data"
      className={cn("inline-flex items-center rounded-md border border-dashed border-muted/70 px-1 py-px font-mono text-[9px] uppercase tracking-[0.14em] text-muted", className)}
    >
      Mock
    </span>
  );
}
