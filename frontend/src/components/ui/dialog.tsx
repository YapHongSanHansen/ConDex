"use client";

import * as React from "react";
import * as D from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export const Dialog = D.Root;
export const DialogTrigger = D.Trigger;
export const DialogClose = D.Close;

export function DialogContent({
  className, children, side = "center", title, description, ...props
}: React.ComponentPropsWithoutRef<typeof D.Content> & { side?: "center" | "left" | "right"; title: string; description?: string }) {
  const pos = {
    center: "left-1/2 top-1/2 w-[calc(100%-32px)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-md max-h-[90vh]",
    left: "left-0 top-0 h-full w-[85%] max-w-sm",
    right: "right-0 top-0 h-full w-full max-w-lg",
  }[side];
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-black/60" />
      <D.Content
        className={cn("fixed z-50 overflow-y-auto border border-border bg-surface p-6 shadow-xl", pos, className)}
        aria-describedby={description ? undefined : undefined}
        {...props}
      >
        <div className="mb-4 pr-8">
          <D.Title className="text-lg font-semibold">{title}</D.Title>
          {description ? <D.Description className="mt-1 text-sm text-muted">{description}</D.Description> : null}
        </div>
        {children}
        <D.Close className="absolute right-4 top-4 rounded-md p-1 text-muted hover:text-text cursor-pointer" aria-label="Close">
          <X className="h-4 w-4" />
        </D.Close>
      </D.Content>
    </D.Portal>
  );
}
