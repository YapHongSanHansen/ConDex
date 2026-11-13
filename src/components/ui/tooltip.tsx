"use client";

import * as T from "@radix-ui/react-tooltip";
import { HelpCircle } from "lucide-react";

export const TooltipProvider = T.Provider;

export function Hint({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <T.Root delayDuration={150}>
      <T.Trigger asChild>
        {children ?? (
          <button type="button" aria-label={label} className="inline-flex align-middle text-muted hover:text-text cursor-help">
            <HelpCircle className="h-3.5 w-3.5" />
          </button>
        )}
      </T.Trigger>
      <T.Portal>
        <T.Content sideOffset={6} className="z-50 max-w-xs rounded-md border border-border bg-surface-2 px-3 py-2 text-xs text-text shadow-lg">
          {label}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
