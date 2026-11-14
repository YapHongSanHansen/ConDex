"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { CreatorSetup } from "./creator-setup";
import { OrdersTable } from "./orders-table";
import { AgentSteps } from "./snippets";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

/** Two jobs on one page: follow the orders this wallet placed, and give an agent a key. The tab is in the URL so links can open either. */
export function KeysTabs() {
  const router = useRouter();
  const tab = useSearchParams().get("tab") === "keys" ? "keys" : "orders";
  return (
    <Tabs value={tab} onValueChange={(v) => router.replace(`/keys?tab=${v}`, { scroll: false })} className="space-y-8">
      <TabsList aria-label="Keys and orders">
        <TabsTrigger value="orders">Your orders</TabsTrigger>
        <TabsTrigger value="keys">Agent keys &amp; MCP</TabsTrigger>
      </TabsList>
      <TabsContent value="orders"><OrdersTable /></TabsContent>
      <TabsContent value="keys" className="space-y-12"><CreatorSetup /><AgentSteps /></TabsContent>
    </Tabs>
  );
}
