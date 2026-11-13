import { cn } from "@/lib/utils";

export function Badge({ className, tone = "neutral", ...props }: React.HTMLAttributes<HTMLSpanElement> & { tone?: "neutral" | "accent" | "warning" | "danger" | "muted" }) {
  const tones = {
    neutral: "border-border text-text",
    accent: "border-accent/60 text-accent",
    warning: "border-warning/60 text-warning",
    danger: "border-danger/60 text-danger",
    muted: "border-border text-muted",
  };
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[11px] uppercase tracking-wider", tones[tone], className)} {...props} />
  );
}
