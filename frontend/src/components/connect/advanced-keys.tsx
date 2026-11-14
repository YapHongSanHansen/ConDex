"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { api, friendlyError, SCOPES, toApiError, type IssuedKey, type Scope } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { useWallet } from "@/lib/near/connector";
import { SignInGate } from "@/components/ui/sign-in-gate";
import { Skeleton } from "@/components/ui/skeleton";
import { agoText, MCP_LABEL } from "./connect-claude";

const SCOPE_HELP: Record<Scope, { title: string; help: string }> = {
  publish: { title: "Publish", help: "Publish theses and new versions." },
  read: { title: "Read", help: "Read the full text of any thesis (needs a subscription)." },
  trade: { title: "Trade", help: "Quote the fee and place orders linked to a thesis." },
};
const PRESETS: [string, Scope[]][] = [["Publisher", ["publish"]], ["Trading agent", ["read", "trade"]], ["Everything", ["publish", "read", "trade"]]];

/** For people who want a key of their own, for another agent or a script: choose what it may do, see the keys, revoke one. */
export function AdvancedKeys() {
  const qc = useQueryClient();
  const [scopes, setScopes] = useState<Scope[]>(["read", "trade"]);
  const [issued, setIssued] = useState<IssuedKey | null>(null);
  const { signedIn } = useWallet();
  const keysQ = useQuery({ queryKey: ["keys"], queryFn: () => api.keys.list(), enabled: signedIn });
  const refresh = () => qc.invalidateQueries({ queryKey: ["keys"] });
  const create = useMutation({
    mutationFn: () => api.keys.issue({ scopes, label: `${scopes.join("+")} key` }),
    onSuccess: (k) => { setIssued(k); refresh(); toast.success("Key created. Copy it now: it is shown once."); },
  });
  const revoke = useMutation({ mutationFn: (id: string) => api.keys.revoke(id), onSuccess: () => { refresh(); toast("Key revoked"); } });
  const toggle = (s: Scope) => setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  const active = (keysQ.data ?? []).filter((k) => !k.revoked);

  return (
    <details className="rounded-md border border-border bg-surface p-5">
      <summary className="cursor-pointer font-semibold">Advanced: keys for other agents and scripts</summary>
      <div className="mt-5 space-y-6">
        <SignInGate why="to manage your keys">
          <div className="space-y-3">
            <h3 className="label-caps">Your keys</h3>
            {keysQ.isLoading ? <Skeleton className="h-16" /> : active.length === 0 ? <p className="text-sm text-muted">No active keys.</p> : (
              <ul className="space-y-2">
                {active.map((k) => (
                  <li key={k.id} className="flex items-start justify-between gap-2 rounded-md border border-border p-3 text-sm">
                    <span className="min-w-0 space-y-0.5">
                      <span className="block truncate font-mono">{k.prefix}… <span className="text-muted">{k.label === MCP_LABEL ? "Claude Code" : k.label}</span></span>
                      <span className="block text-xs text-muted">{k.scopes.join(" · ")} · {k.mcp ? `Claude Code seen ${agoText(k.mcp.lastSeenAt)}` : k.lastUsedAt ? `used ${agoText(k.lastUsedAt)}` : "never used"}</span>
                    </span>
                    <Button variant="ghost" size="sm" loading={revoke.isPending && revoke.variables === k.id} onClick={() => revoke.mutate(k.id)}>Revoke</Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="space-y-3 border-t border-border pt-5">
            <h3 className="label-caps">Make another key</h3>
            {issued ? (
              <div className="space-y-3">
                <code className="block break-all rounded-md border border-border bg-background p-3 font-mono text-xs">{issued.secret}</code>
                <p role="alert" className="flex items-center gap-2 text-sm text-warning"><AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />Shown only once. Copy it now.</p>
                <div className="flex gap-2"><CopyButton value={issued.secret} label="Copy key" /><Button variant="ghost" size="sm" onClick={() => setIssued(null)}>I copied it</Button></div>
              </div>
            ) : (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {PRESETS.map(([label, preset]) => (
                    <button key={label} type="button" onClick={() => setScopes(preset)} aria-pressed={preset.length === scopes.length && preset.every((x) => scopes.includes(x))}
                      className="cursor-pointer rounded-full border border-border px-2.5 py-0.5 text-xs text-muted hover:text-text aria-pressed:border-accent aria-pressed:text-accent">{label}</button>
                  ))}
                </div>
                <fieldset className="space-y-2">
                  <legend className="sr-only">What the key can do</legend>
                  {SCOPES.map((s) => (
                    <label key={s} className="flex cursor-pointer items-start gap-2.5 text-sm">
                      <input type="checkbox" checked={scopes.includes(s)} onChange={() => toggle(s)} className="mt-1 h-4 w-4 accent-[var(--accent)]" />
                      <span><span className="font-medium">{SCOPE_HELP[s].title}</span><span className="block text-xs text-muted">{SCOPE_HELP[s].help}</span></span>
                    </label>
                  ))}
                </fieldset>
                <Button variant="secondary" loading={create.isPending} disabled={scopes.length === 0} onClick={() => create.mutate()}>Create key</Button>
                {create.isError && <p role="alert" className="text-sm text-danger">{friendlyError(toApiError(create.error)).title}</p>}
              </>
            )}
          </div>
        </SignInGate>
      </div>
    </details>
  );
}
