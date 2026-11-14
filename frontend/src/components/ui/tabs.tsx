"use client";

import * as T from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";

export const Tabs = T.Root;
export function TabsList({ className, ...p }: React.ComponentPropsWithoutRef<typeof T.List>) {
  return <T.List className={cn("inline-flex gap-1 border-b border-border", className)} {...p} />;
}
export function TabsTrigger({ className, ...p }: React.ComponentPropsWithoutRef<typeof T.Trigger>) {
  return <T.Trigger className={cn("cursor-pointer border-b-2 border-transparent px-3 py-2 font-mono text-xs uppercase tracking-wider text-muted data-[state=active]:border-accent data-[state=active]:text-text", className)} {...p} />;
}
export const TabsContent = T.Content;
