"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronRight, Loader2, Plug } from "lucide-react";
import { toast } from "sonner";
import { api, friendlyError, toApiError, type KeyRow, type Scope } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/code-block";
import { Input } from "@/components/ui/input";
import { SignInGate } from "@/components/ui/sign-in-gate";
import { MCP_API_URL, MCP_SERVER_PATH } from "@/lib/config";
import { keyVault } from "@/lib/key-vault";
import { useWallet } from "@/lib/near/connector";
import { useNow } from "@/hooks/use-now";
import { cn } from "@/lib/utils";

/** The label the backend looks for when "Disconnect" revokes a user's MCP keys. */
export const MCP_LABEL = "MCP agent";
/** A connection is "live" if the MCP server said hello in this long. It says hello every 30 seconds. */
const LIVE_MS = 2 * 60_000;

/** How the person runs Claude Code decides how it is told about ConDex. */
export type How = "terminal" | "vscode" | "file";

/** The two lines the backend documents: the first removes an older entry, so the same lines also replace a key. */
export function mcpCommand(secret: string, serverPath: string) {
  return `claude mcp remove condex
claude mcp add condex --env CONDEX_API_KEY=${secret} --env CONDEX_API_URL=${MCP_API_URL} "--" node "${serverPath}"`;
}

/**
 * The VS Code extension ships its own `claude` program but does not put it on the PATH, so a terminal says
 * "command not found: claude". This finds the newest copy of it first, then runs the same two lines with it.
 */
export function vscodeCommand(secret: string, serverPath: string) {
  return `CLAUDE="$(ls -d ~/.vscode/extensions/anthropic.claude-code-*/resources/native-binary/claude | tail -1)"
"$CLAUDE" mcp remove condex
"$CLAUDE" mcp add condex --env CONDEX_API_KEY=${secret} --env CONDEX_API_URL=${MCP_API_URL} "--" node "${serverPath}"`;
}

/** A project file Claude Code reads on its own: no terminal and no `claude` program needed. */
export function mcpJson(secret: string, serverPath: string) {
  // The file format expands ${HOME}, where the shell commands above use $HOME.
  const path = serverPath.replace(/^\$HOME(?=\/)/, "${HOME}");
  return JSON.stringify({ mcpServers: { condex: { command: "node", args: [path], env: { CONDEX_API_KEY: secret, CONDEX_API_URL: MCP_API_URL } } } }, null, 2);
}

const HOW_LABEL: Record<How, string> = { terminal: "Terminal", vscode: "VS Code extension", file: "A file, no terminal" };

function useHow() {
  const [how, setHow] = useState<How>("terminal");
  useEffect(() => {
    try { const saved = window.localStorage.getItem("condex.claudeHow") as How | null; if (saved && saved in HOW_LABEL) queueMicrotask(() => setHow(saved)); } catch { /* storage blocked */ }
  }, []);
  const set = (next: How) => {
    setHow(next);
    try { window.localStorage.setItem("condex.claudeHow", next); } catch { /* storage blocked */ }
  };
  return [how, set] as const;
}

/** Where the backend's MCP server file is. In development the backend reports it, so nothing needs to be typed. */
function useServerPath() {
  const [typed, setTyped] = useState<string | null>(null);
  const found = useQuery({
    queryKey: ["mcp-path"],
    queryFn: async () => ((await (await fetch("/api/dev/mcp-path")).json()) as { path: string | null }).path,
    staleTime: Infinity,
    retry: false,
  });
  useEffect(() => {
    try { const saved = window.localStorage.getItem("condex.mcpPath"); if (saved) queueMicrotask(() => setTyped(saved)); } catch { /* storage blocked */ }
  }, []);
  const set = (next: string) => {
    setTyped(next);
    try { window.localStorage.setItem("condex.mcpPath", next); } catch { /* storage blocked */ }
  };
  const detected = found.data ?? null;
  return { path: typed ?? detected ?? MCP_SERVER_PATH, detected: !!detected && typed === null, set, loading: found.isLoading };
}

export function agoText(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  return s < 10 ? "just now" : s < 60 ? `${s} seconds ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}

function Step({ n, done, children }: { n: number; done?: boolean; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className={cn("mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border font-mono text-xs", done ? "border-accent bg-accent text-accent-fg" : "border-border text-muted")}>
        {done ? <Check className="h-3.5 w-3.5" aria-hidden /> : n}
      </span>
      <div className="min-w-0 flex-1 space-y-2">{children}</div>
    </li>
  );
}

/**
 * Connects Claude Code in three plain steps: make the connection, paste one command, restart Claude Code. The page then
 * watches for Claude Code to check in and says so. Everything about scopes and other keys is in the Advanced section.
 */
export function ConnectClaude({ scopes = ["publish"], onConnected, after }: { scopes?: Scope[]; onConnected?: () => void; after?: React.ReactNode }) {
  const qc = useQueryClient();
  const secret = useSyncExternalStore(keyVault.subscribe, keyVault.get, () => null);
  const server = useServerPath();
  const [how, setHow] = useHow();
  const now = useNow(10_000);

  const { signedIn } = useWallet();
  const keysQ = useQuery({
    queryKey: ["keys"], queryFn: () => api.keys.list(), enabled: signedIn,
    // Quick while waiting for Claude Code, then relaxed.
    refetchInterval: 3_000,
  });
  const keys: KeyRow[] = (keysQ.data ?? []).filter((k) => !k.revoked);
  const live = keys.find((k) => k.mcp && now - new Date(k.mcp.lastSeenAt).getTime() < LIVE_MS) ?? null;
  const quiet = !live ? keys.find((k) => k.mcp) ?? null : null;
  const hasConnection = !!secret || keys.some((k) => k.label === MCP_LABEL);

  const create = useMutation({
    mutationFn: async () => {
      // A fresh connection replaces any MCP key that nothing is using, so keys do not pile up.
      for (const k of keys) if (k.label === MCP_LABEL && !k.mcp) await api.keys.revoke(k.id);
      return api.keys.issue({ scopes, label: MCP_LABEL });
    },
    onSuccess: (k) => { keyVault.set({ id: k.id, secret: k.secret }); qc.invalidateQueries({ queryKey: ["keys"] }); toast.success("Connection created. Copy the command below."); },
  });
  const disconnect = useMutation({
    mutationFn: () => api.keys.disconnectMcp(),
    onSuccess: () => { keyVault.set(null); qc.invalidateQueries({ queryKey: ["keys"] }); toast("Claude Code disconnected"); },
  });

  // Tell the page that owns this step the moment Claude Code checks in.
  useEffect(() => { if (live) onConnected?.(); }, [live, onConnected]);

  return (
    <section aria-labelledby="connect-claude" className="space-y-5 rounded-md border border-border bg-surface p-6">
      <div className="space-y-1">
        <h2 id="connect-claude" className="flex items-center gap-2 text-lg font-semibold"><Plug className="h-5 w-5" aria-hidden />Connect Claude Code</h2>
        <p className="max-w-2xl text-sm text-muted">So Claude can publish for you. Your conversation stays on your computer, and only what you choose to share is sent.</p>
      </div>

      <SignInGate why="to connect Claude Code">
        {live ? (
          <div className="space-y-4" role="status">
            <p className="flex items-center gap-2 font-medium text-accent"><Check className="h-5 w-5" aria-hidden />Claude Code is connected</p>
            <p className="text-sm text-muted">Last heard from {agoText(live.mcp!.lastSeenAt)}. It can use the ConDex tools in any new chat.</p>
            <div className="flex flex-wrap items-center gap-2">
              {after}
              <Button variant="ghost" size="sm" loading={disconnect.isPending} onClick={() => disconnect.mutate()}>Disconnect</Button>
            </div>
          </div>
        ) : keysQ.isLoading ? (
          <p className="text-sm text-muted">Checking…</p>
        ) : !hasConnection ? (
          <div className="space-y-3">
            <p className="text-sm">One click makes a private key for this connection. You will paste it into Claude Code next.</p>
            <Button variant="primary" size="lg" loading={create.isPending} onClick={() => create.mutate()}>Create my connection</Button>
            {create.isError && <p role="alert" className="text-sm text-danger">{friendlyError(toApiError(create.error)).title}</p>}
          </div>
        ) : (
          <ol className="space-y-5" aria-label="Connect Claude Code">
            <Step n={1}>
              <p className="font-medium">How do you use Claude Code?</p>
              <div role="radiogroup" aria-label="How you use Claude Code" className="flex flex-wrap gap-1.5">
                {(Object.keys(HOW_LABEL) as How[]).map((h) => (
                  <button key={h} type="button" role="radio" aria-checked={how === h} onClick={() => setHow(h)}
                    className="cursor-pointer rounded-full border border-border px-3 py-1 text-sm text-muted hover:text-text aria-checked:border-accent aria-checked:text-text">{HOW_LABEL[h]}</button>
                ))}
              </div>
              {secret ? (
                <>
                  {how === "terminal" && <><CodeBlock title="terminal" code={mcpCommand(secret.secret, server.path)} /><p className="text-xs text-muted">Copy it whole and paste it into a terminal window. It already has your key and the right folder in it. If it says <span className="font-mono">command not found: claude</span>, pick &ldquo;VS Code extension&rdquo; above.</p></>}
                  {how === "vscode" && <><CodeBlock title="terminal · Mac or Linux" code={vscodeCommand(secret.secret, server.path)} /><p className="text-xs text-muted">The VS Code extension has its own copy of Claude that a terminal cannot find by name. These lines find it, then connect ConDex. Paste all three into a terminal window.</p></>}
                  {how === "file" && (
                    <>
                      <CodeBlock title=".mcp.json" code={mcpJson(secret.secret, server.path)} />
                      <p className="text-xs text-muted">Save this as a file named <span className="font-mono">.mcp.json</span> in the folder you open in Claude Code, then approve it when Claude Code asks. It holds your key, so do not commit it. If Claude Code already has a ConDex entry, remove it first in <span className="font-mono">/mcp</span>.</p>
                    </>
                  )}
                </>
              ) : (
                <div className="space-y-2 rounded-md border border-dashed border-border p-3 text-sm">
                  <p className="text-muted">For safety a key is shown only once, and this page was reloaded since. Make a new one to get the command again.</p>
                  <Button variant="secondary" size="sm" loading={create.isPending} onClick={() => create.mutate()}>Make a new connection</Button>
                </div>
              )}
              {!server.detected && !server.loading && (
                <div className="space-y-1">
                  <label htmlFor="mcp-path" className="label-caps block">Folder of the ConDex backend on your computer</label>
                  <Input id="mcp-path" value={server.path} onChange={(e) => server.set(e.target.value)} spellCheck={false} className="font-mono text-xs" />
                  <p className="text-xs text-muted">The full path to <span className="font-mono">src/mcp/server.ts</span>. Change it if the text above has the wrong folder.</p>
                </div>
              )}
            </Step>
            <Step n={2}>
              <p className="font-medium">Restart Claude Code</p>
              <p className="text-sm text-muted">{how === "vscode" ? "Reload the Claude Code panel in VS Code, or reload the window." : "Close it and open it again."} Claude Code only picks up a new tool when it starts. Type <span className="font-mono">/mcp</span> to check that <span className="font-mono">condex</span> says connected.</p>
            </Step>
            <Step n={3}>
              <p className="font-medium">Wait here</p>
              <p role="status" className="flex items-center gap-2 text-sm text-muted">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                {quiet ? `Claude Code was connected, but has not been heard from since ${agoText(quiet.mcp!.lastSeenAt)}. Restart it.` : "Waiting for Claude Code. This page updates by itself."}
              </p>
            </Step>
          </ol>
        )}

        {!live && hasConnection && (
          <details className="rounded-md border border-border p-3 text-sm">
            <summary className="flex cursor-pointer items-center gap-1 text-muted hover:text-text"><ChevronRight className="h-4 w-4" aria-hidden />Not connecting?</summary>
            <ul className="mt-2 list-disc space-y-1.5 pl-5 text-muted">
              <li>The terminal did not say <span className="font-mono text-text">command not found: claude</span>. If it did, choose &ldquo;VS Code extension&rdquo; above.</li>
              <li>You ran everything exactly as shown, with no part left out or edited.</li>
              <li>Claude Code did not already have an older ConDex entry with an old key. The terminal options replace it. For the file, remove the old one in <span className="font-mono text-text">/mcp</span> first.</li>
              <li>Claude Code was closed and opened again after running it.</li>
              <li>In Claude Code, type <span className="font-mono text-text">/mcp</span>. The <span className="font-mono text-text">condex</span> line should say connected. Or run <span className="font-mono text-text">claude mcp list</span> in a terminal.</li>
              <li>The ConDex backend is running at <span className="font-mono text-text">{MCP_API_URL}</span> on the computer where Claude Code runs.</li>
              <li>You did not reload this page after creating the key. If you did, make a new connection above.</li>
            </ul>
          </details>
        )}
        {create.isError && hasConnection && <p role="alert" className="text-sm text-danger">{friendlyError(toApiError(create.error)).title}</p>}
      </SignInGate>
    </section>
  );
}
