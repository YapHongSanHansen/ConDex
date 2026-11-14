"use client";

import * as M from "@radix-ui/react-dropdown-menu";
import { cn } from "@/lib/utils";

export const DropdownMenu = M.Root;
export const DropdownTrigger = M.Trigger;
export function DropdownContent({ className, ...p }: React.ComponentPropsWithoutRef<typeof M.Content>) {
  return (
    <M.Portal>
      <M.Content align="end" sideOffset={8} className={cn("z-50 min-w-48 rounded-md border border-border bg-surface p-1 shadow-lg", className)} {...p} />
    </M.Portal>
  );
}
export function DropdownItem({ className, ...p }: React.ComponentPropsWithoutRef<typeof M.Item>) {
  return <M.Item className={cn("flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm outline-none data-[highlighted]:bg-surface-2", className)} {...p} />;
}
