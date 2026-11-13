import { AlertTriangle, Inbox } from "lucide-react";
import { friendlyError } from "@/lib/api/errors";
import { Button } from "./button";

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const f = friendlyError(error);
  return (
    <div role="alert" className="flex flex-col items-start gap-3 rounded-md border border-danger/50 bg-surface p-6">
      <div className="flex items-center gap-2 text-danger"><AlertTriangle className="h-4 w-4" aria-hidden /><span className="font-medium">{f.title}</span></div>
      <p className="text-sm text-muted">{f.next}</p>
      {onRetry && <Button variant="secondary" size="sm" onClick={onRetry}>Try again</Button>}
    </div>
  );
}

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-border p-10 text-center">
      <Inbox className="h-5 w-5 text-muted" aria-hidden />
      <p className="font-medium">{title}</p>
      {body && <p className="max-w-md text-sm text-muted">{body}</p>}
      {action}
    </div>
  );
}
