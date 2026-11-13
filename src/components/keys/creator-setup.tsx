"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Circle, ShieldCheck } from "lucide-react";
import { api, friendlyError, toApiError } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/code-block";
import { CopyButton } from "@/components/ui/copy-button";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { useWallet } from "@/lib/near/connector";
import { formatDate } from "@/lib/utils";

// PROPOSED: the `condex-mcp` package does not exist yet. Align with the real MCP server.
export const MCP_COMMAND = `claude mcp add condex \\
  --env CONDEX_API_KEY=YOUR_CREATOR_KEY \\
  -- npx -y condex-mcp`;

export const EXPORT_PROMPT = `Export this conversation to ConDex.
Market: BTC/USDT. Expire it in 24 hours.
Include my PNL for this trade in the private context.`;

function StepHeader({ n, title, done }: { n: number; title: string; done: boolean }) {
  return (
    <div className="flex items-center gap-3">
      <span className={`flex h-6 w-6 items-center justify-center rounded-full border font-mono text-xs ${done ? "border-accent bg-accent text-accent-fg" : "border-border text-muted"}`}>
        {done ? <Check className="h-3.5 w-3.5" aria-hidden /> : n}
      </span>
      <h3 className="font-semibold">{title}</h3>
    </div>
  );
}

/** Wallet → API key → Claude Code (MCP) → export with expiry. Context never leaves the creator's machine. */
export function CreatorSetup() {
  const { accountId, connect, connecting } = useWallet();
  const qc = useQueryClient();
  // The key lives in component memory only. Never in storage, cookies or URLs.
  const [issued, setIssued] = useState<string | null>(null);
  const info = useQuery({ queryKey: ["creator-key"], queryFn: () => api.creators.getCreatorKey(), enabled: !!accountId });
  const create = useMutation({
    mutationFn: () => api.creators.createCreatorKey(),
    onSuccess: (r) => { setIssued(r.api_key); qc.invalidateQueries({ queryKey: ["creator-key"] }); },
  });
  const hasKey = !!info.data?.has_key;
  const connected = !!info.data?.mcp_connected;

  return (
    <section aria-labelledby="creator-setup" className="space-y-6">
      <div className="space-y-1.5">
        <h2 id="creator-setup" className="text-lg font-semibold">Creators: connect Claude Code</h2>
        <p className="flex max-w-3xl items-start gap-2 text-sm leading-relaxed text-muted">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
          Your chat is never uploaded. It stays on your machine behind an MCP server.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 rounded-md border border-border bg-surface p-5">
          <StepHeader n={1} title="API key" done={hasKey} />
          {!accountId ? (
            <>
              <p className="text-sm text-muted">Connect your wallet first.</p>
              <Button variant="primary" loading={connecting} onClick={() => connect()}>Connect testnet wallet</Button>
            </>
          ) : info.isError ? (
            <ErrorState error={info.error} onRetry={() => info.refetch()} />
          ) : info.isLoading ? (
            <Skeleton className="h-20" />
          ) : issued ? (
            <div className="space-y-3">
              <code className="block break-all rounded-md border border-border bg-background p-3 font-mono text-xs">{issued}</code>
              <p role="alert" className="flex items-center gap-2 text-sm text-warning"><AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />Shown only once. Store it now.</p>
              <div className="flex gap-2"><CopyButton value={issued} label="Copy key" /><Button variant="ghost" size="sm" onClick={() => setIssued(null)}>I stored it</Button></div>
            </div>
          ) : hasKey ? (
            <div className="space-y-2 text-sm">
              <p className="font-mono">{info.data!.key_prefix}…</p>
              <p className="text-muted">Created {formatDate(info.data!.created_at!)}.</p>
            </div>
          ) : (
            <>
              <p className="text-sm text-muted">Create the key Claude Code will use.</p>
              <Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>Get my API key</Button>
              {create.isError && <p role="alert" className="text-sm text-danger">{friendlyError(toApiError(create.error)).title}</p>}
            </>
          )}
        </div>

        <div className="space-y-4 rounded-md border border-border bg-surface p-5 lg:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <StepHeader n={2} title="Add the MCP server" done={connected} />
            <Badge tone={connected ? "accent" : "muted"}>{connected ? <Check className="h-3 w-3" aria-hidden /> : <Circle className="h-3 w-3" aria-hidden />}{connected ? "MCP connected" : "Not connected yet"}</Badge>
          </div>
          <p className="text-sm text-muted">Run once in your terminal with your key.</p>
          <CodeBlock title="terminal · proposed command" code={MCP_COMMAND} />
        </div>
      </div>

      <div className="space-y-4 rounded-md border border-border bg-surface p-5">
        <StepHeader n={3} title="Export with an expiry" done={false} />
        <div className="grid gap-4 lg:grid-cols-2">
          <p className="text-sm leading-relaxed text-muted">
            Ask Claude Code to export and set an expiry. You may include your own PNL; it stays private. Then finish on the Publish page.
          </p>
          <CodeBlock title="say this in claude code" code={EXPORT_PROMPT} />
        </div>
      </div>
    </section>
  );
}
