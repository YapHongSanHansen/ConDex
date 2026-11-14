"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AdvancedKeys } from "@/components/connect/advanced-keys";
import { ConnectClaude } from "@/components/connect/connect-claude";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { OrdersTable } from "./orders-table";
import { AgentSteps } from "./snippets";

/** Two jobs on one page: follow the orders this wallet placed, and connect Claude Code. The tab is in the URL so links can open either. */
export function KeysTabs() {
  const router = useRouter();
  const tab = useSearchParams().get("tab") === "keys" ? "keys" : "orders";
  return (
    <Tabs value={tab} onValueChange={(v) => router.replace(`/keys?tab=${v}`, { scroll: false })} className="space-y-8">
      <TabsList aria-label="Keys and orders">
        <TabsTrigger value="orders">Your orders</TabsTrigger>
        <TabsTrigger value="keys">Connect Claude Code</TabsTrigger>
      </TabsList>
      <TabsContent value="orders"><OrdersTable /></TabsContent>
      <TabsContent value="keys" className="space-y-8">
        <ConnectClaude after={<Button asChild variant="primary"><Link href="/publish">Publish a thesis</Link></Button>} />
        <AdvancedKeys />
        <details className="rounded-md border border-border bg-surface p-5">
          <summary className="cursor-pointer font-semibold">Advanced: let an agent read and trade with a key</summary>
          <div className="mt-5"><AgentSteps /></div>
        </details>
      </TabsContent>
    </Tabs>
  );
}
