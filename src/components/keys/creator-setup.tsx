"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Circle, Plug, ShieldCheck } from "lucide-react";
import { api, friendlyError, SCOPES, toApiError, type IssuedKey, type KeyRow, type Scope } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/code-block";
import { CopyButton } from "@/components/ui/copy-button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/states";
import { MCP_API_URL, MCP_SERVER_PATH } from "@/lib/config";
import { useWallet } from "@/lib/near/connector";
import { formatDate } from "@/lib/utils";

/** What each access level lets an agent do, in plain words. */
const SCOPE_HELP: Record<Scope, { title: string; help: string }> = {
  publish: { title: "Publish", help: "Publish theses and new versions." },
  read: { title: "Read", help: "Read the full conversation of any thesis. Always free." },
  trade: { title: "Trade", help: "Quote the fee and place orders linked to a thesis." },
};

/** The label the backend looks for when "Disconnect" revokes a user's MCP keys. */
const MCP_LABEL = "MCP agent";

/** The two lines the backend documents: the first removes an older entry, so the same lines also replace a key. */
export function mcpCommand(secret: string | null, serverPath: string) {
  return `claude mcp remove condex
claude mcp add condex --env CONDEX_API_KEY=${secret ?? "YOUR_KEY"} --env CONDEX_API_URL=${MCP_API_URL} "--" node "${serverPath || MCP_SERVER_PATH}"`;
}

/** The path is the creator's own, so it is kept in this browser for next time. */
function useServerPath() {
  const [path, setPath] = useState(MCP_SERVER_PATH);
  useEffect(() => {
    try { const saved = window.localStorage.getItem("condex.mcpPath"); if (saved) queueMicrotask(() => setPath(saved)); } catch { /* storage blocked */ }
  }, []);
  const update = (next: string) => {
    setPath(next);
    try { window.localStorage.setItem("condex.mcpPath", next); } catch { /* storage blocked */ }
  };
  return [path, update] as const;
}

export const EXPORT_PROMPT = `Publish this conversation to ConDex.
Market: ETH-USD. Direction: short.
Entry: a 15-minute candle closes back below yesterday's high.
Invalidation: a 1-hour close above the sweep high.
Expiry: in 3 days (or leave it out and ConDex will set one).`;

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

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : formatDate(iso);
}

/** Wallet → sign in → API key → Claude Code (MCP) → publish. Context never leaves the creator's machine. */
export function CreatorSetup() {
  const { accountId, signedIn, signingIn, signIn, connect, connecting } = useWallet();
  const qc = useQueryClient();
  // The secret lives in component memory only. Never in storage, cookies or URLs.
  const [issued, setIssued] = useState<IssuedKey | null>(null);
  const [scopes, setScopes] = useState<Scope[]>(["publish"]);
  const [serverPath, setServerPath] = useServerPath();

  const keysQ = useQuery({
    queryKey: ["keys"], queryFn: () => api.keys.list(), enabled: signedIn,
    // Checks faster while waiting for Claude Code to connect, then settles.
    refetchInterval: (q) => (q.state.data?.some((k) => !k.revoked && k.mcp) ? 15_000 : 3_000),
  });
  const active: KeyRow[] = (keysQ.data ?? []).filter((k) => !k.revoked);
  const mcpKey = active.find((k) => k.mcp) ?? null;
  const connected = !!mcpKey;
  const toolsQ = useQuery({ queryKey: ["mcp-tools"], queryFn: () => api.keys.mcpTools(), enabled: signedIn && connected });

  const refresh = () => qc.invalidateQueries({ queryKey: ["keys"] });
  const create = useMutation({
    mutationFn: () => api.keys.issue({ scopes, label: MCP_LABEL }),
    onSuccess: (k) => { setIssued(k); refresh(); toast.success("Key created. Copy it now: it is shown once."); },
  });
  const revoke = useMutation({ mutationFn: (id: string) => api.keys.revoke(id), onSuccess: refresh });
  const disconnect = useMutation({ mutationFn: () => api.keys.disconnectMcp(), onSuccess: () => { setIssued(null); refresh(); } });
  const toggle = (s: Scope) => setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  return (
    <section aria-labelledby="creator-setup" className="space-y-6">
      <div className="space-y-1.5">
        <h2 id="creator-setup" className="text-lg font-semibold">Connect Claude Code</h2>
        <p className="flex max-w-3xl items-start gap-2 text-sm leading-relaxed text-muted">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
          Your chat is never uploaded until you publish it. It stays on your machine behind an MCP server.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 rounded-md border border-border bg-surface p-5">
          <StepHeader n={1} title="API key" done={active.length > 0} />
          {!accountId ? (
            <>
              <p className="text-sm text-muted">Connect your wallet first.</p>
              <Button variant="primary" loading={connecting} onClick={() => connect()}>Connect testnet wallet</Button>
            </>
          ) : !signedIn ? (
            <>
              <p className="text-sm text-muted">Sign in to ConDex with {accountId}. It signs a message in your wallet. No transaction, no fee.</p>
              <Button variant="primary" loading={signingIn} onClick={() => signIn()}>Sign in to ConDex</Button>
            </>
          ) : keysQ.isError ? (
            <ErrorState error={keysQ.error} onRetry={() => keysQ.refetch()} />
          ) : keysQ.isLoading ? (
            <Skeleton className="h-20" />
          ) : issued ? (
            <div className="space-y-3">
              <code className="block break-all rounded-md border border-border bg-background p-3 font-mono text-xs">{issued.secret}</code>
              <p role="alert" className="flex items-center gap-2 text-sm text-warning"><AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />Shown only once. Store it now.</p>
              <div className="flex gap-2"><CopyButton value={issued.secret} label="Copy key" /><Button variant="ghost" size="sm" onClick={() => setIssued(null)}>I stored it</Button></div>
            </div>
          ) : (
            <div className="space-y-4">
              {active.length > 0 && (
                <ul className="space-y-2" aria-label="Your keys">
                  {active.map((k) => (
                    <li key={k.id} className="flex items-start justify-between gap-2 rounded-md border border-border p-3 text-sm">
                      <span className="min-w-0 space-y-1">
                        <span className="block truncate font-mono">{k.prefix}…</span>
                        <span className="block text-xs text-muted">{k.scopes.join(" · ")} · {k.lastUsedAt ? `used ${ago(k.lastUsedAt)}` : "never used"}</span>
                      </span>
                      <Button variant="ghost" size="sm" loading={revoke.isPending && revoke.variables === k.id} onClick={() => revoke.mutate(k.id)}>Revoke</Button>
                    </li>
                  ))}
                </ul>
              )}
              <fieldset className="space-y-2">
                <legend className="label-caps mb-1">{active.length ? "New key" : "What can it do?"}</legend>
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {([["Publisher", ["publish"]], ["Trading agent", ["read", "trade"]], ["Everything", ["publish", "read", "trade"]]] as [string, Scope[]][]).map(([label, preset]) => (
                    <button key={label} type="button" onClick={() => setScopes(preset)} aria-pressed={preset.length === scopes.length && preset.every((x) => scopes.includes(x))}
                      className="cursor-pointer rounded-full border border-border px-2.5 py-0.5 text-xs text-muted hover:text-text aria-pressed:border-accent aria-pressed:text-accent">{label}</button>
                  ))}
                </div>
                {SCOPES.map((s) => (
                  <label key={s} className="flex cursor-pointer items-start gap-2.5 text-sm">
                    <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)} className="mt-1 h-4 w-4 accent-[var(--accent)]" />
                    <span><span className="font-medium">{SCOPE_HELP[s].title}</span><span className="block text-xs text-muted">{SCOPE_HELP[s].help}</span></span>
                  </label>
                ))}
              </fieldset>
              <Button variant="primary" loading={create.isPending} disabled={scopes.length === 0} onClick={() => create.mutate()}>{active.length ? "Create another key" : "Get my API key"}</Button>
              {create.isError && <p role="alert" className="text-sm text-danger">{friendlyError(toApiError(create.error)).title}</p>}
            </div>
          )}
        </div>

        <div className="space-y-4 rounded-md border border-border bg-surface p-5 lg:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <StepHeader n={2} title="Add the MCP server" done={connected} />
            <Badge tone={connected ? "accent" : "muted"}>{connected ? <Check className="h-3 w-3" aria-hidden /> : <Circle className="h-3 w-3" aria-hidden />}{connected ? "MCP connected" : "Waiting for Claude Code"}</Badge>
          </div>
          <p className="text-sm text-muted">Run these two lines in your terminal. This page shows connected when Claude Code starts the server with your key.</p>
          <label htmlFor="mcp-path" className="label-caps block">Where the backend is on your machine</label>
          <Input id="mcp-path" value={serverPath} onChange={(e) => setServerPath(e.target.value)} spellCheck={false} className="font-mono text-xs" aria-describedby="mcp-path-help" />
          <p id="mcp-path-help" className="text-xs text-muted">The full path to <span className="font-mono">src/mcp/server.ts</span> in the ConDex backend folder. It is kept in this browser.</p>
          <CodeBlock title="terminal" code={mcpCommand(issued?.secret ?? null, serverPath)} />
          {connected && mcpKey?.mcp && (
            <div className="space-y-3 rounded-md border border-border p-3 text-sm">
              <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="flex items-center gap-1.5 font-medium"><Plug className="h-3.5 w-3.5 text-accent" aria-hidden />{mcpKey.mcp.client}</span>
                <span className="text-muted">connected {ago(mcpKey.mcp.connectedAt)} · last seen {ago(mcpKey.mcp.lastSeenAt)}</span>
              </p>
              <details>
                <summary className="cursor-pointer text-muted hover:text-text">{toolsQ.data?.length ?? mcpKey.mcp.tools.length} tools available to Claude Code</summary>
                <ul className="mt-2 space-y-1 text-xs">
                  {(toolsQ.data ?? []).map((t) => <li key={t.name}><span className="font-mono">{t.name}</span><span className="text-muted"> · {t.description}</span></li>)}
                </ul>
              </details>
              <Button variant="secondary" size="sm" loading={disconnect.isPending} onClick={() => disconnect.mutate()}>Disconnect Claude Code</Button>
              <p className="text-xs text-muted">Disconnecting revokes your MCP keys. Claude Code keeps its settings, but every call it makes now fails.</p>
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface p-5">
        <div className="space-y-1"><StepHeader n={3} title="Publish a thesis" done={false} /><p className="pl-9 text-sm text-muted">Define the market, direction, entry, invalidation, expiry and fee, then paste the prompt into Claude Code.</p></div>
        <Button asChild variant="secondary"><Link href="/publish">Define a thesis</Link></Button>
      </div>
    </section>
  );
}
