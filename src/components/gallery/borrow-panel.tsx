"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Circle, Loader2 } from "lucide-react";
import { api, friendlyError, toApiError } from "@/lib/api";
import type { InsightDetail } from "@/lib/api/types";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/input";
import { Hint } from "@/components/ui/tooltip";
import { DISCLAIMER } from "@/components/layout/page-header";
import { reserveFee } from "@/lib/near/contract";
import { useWallet } from "@/lib/near/connector";
import { formatDate, formatNear } from "@/lib/utils";

type Step = "idle" | "reserving" | "issuing" | "ready";
const STEPS: { id: Exclude<Step, "idle">; label: string }[] = [
  { id: "reserving", label: "Reserving" },
  { id: "issuing", label: "Issuing key" },
  { id: "ready", label: "Ready" },
];

function Stepper({ step }: { step: Step }) {
  const idx = STEPS.findIndex((s) => s.id === step);
  return (
    <ol className="space-y-2" aria-live="polite">
      {STEPS.map((s, i) => {
        const done = i < idx || step === "ready";
        const current = i === idx && step !== "ready";
        return (
          <li key={s.id} className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider">
            {done ? <Check className="h-4 w-4 text-accent" aria-hidden /> : current ? <Loader2 className="h-4 w-4 animate-spin text-accent" aria-hidden /> : <Circle className="h-4 w-4 text-muted" aria-hidden />}
            <span className={done || current ? "text-text" : "text-muted"}>{s.label}{done ? " · done" : current ? " · in progress" : ""}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function BorrowPanel({ insight }: { insight: InsightDetail }) {
  const { accountId, connect, getWallet, connecting } = useWallet();
  const qc = useQueryClient();
  const [cap, setCap] = useState(String(insight.price));
  const [step, setStep] = useState<Step>("idle");
  // The key lives in component memory only. Never in storage, cookies or URLs.
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [borrowId, setBorrowId] = useState<string | null>(null);

  const capNum = Number(cap);
  const capError = !cap || Number.isNaN(capNum) ? "Enter a number." : capNum < insight.price ? `The fee cap can't be below the listed fee (${formatNear(insight.price)}).` : null;
  const unavailable = insight.status !== "live";

  const borrow = useMutation({
    mutationFn: async () => {
      setStep("reserving");
      const wallet = await getWallet().catch(() => null);
      const reservationId = crypto.randomUUID();
      const tx = await reserveFee(wallet, { borrowId: reservationId, insightId: insight.id, capNear: capNum });
      setStep("issuing");
      return api.borrows.createBorrow(insight.id, { fee_cap: capNum, reserve_tx_hash: tx.txHash });
    },
    onSuccess: (r) => {
      setStep("ready");
      setApiKey(r.api_key);
      setBorrowId(r.borrow.id);
      qc.invalidateQueries({ queryKey: ["borrows"] });
    },
    onError: () => setStep("idle"),
  });

  const closeKey = () => { setApiKey(null); setBorrowId(null); setStep("idle"); };
  const err = borrow.isError ? friendlyError(toApiError(borrow.error)) : null;

  return (
    <aside className="space-y-5 rounded-md border border-border bg-surface p-6 lg:sticky lg:top-20" aria-label="Borrow">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Borrow <Hint label="A borrow gives your agent a key to read this insight. Nothing is charged until your agent reports a trade executed." /></h2>
        <span className="font-mono text-xl">{formatNear(insight.price)}</span>
      </div>
      <p className="text-sm leading-relaxed text-muted">
        Reserved now: up to <span className="text-text">{formatNear(capNum > 0 ? Math.max(capNum, insight.price) : insight.price)}</span>. Charged only if your agent reports a trade. Released if the key expires first.
      </p>
      <Field label="Fee cap (NEAR)" htmlFor="fee-cap" help="Most you approve. Minimum is the listed fee." error={capError}>
        <Input id="fee-cap" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} aria-invalid={!!capError} aria-describedby={capError ? "fee-cap-err" : "fee-cap-help"} disabled={step !== "idle" && step !== "ready"} />
      </Field>
      <dl className="space-y-1 border-t border-border pt-4 text-xs">
        <div className="flex justify-between"><dt className="text-muted">Key expires</dt><dd className="font-mono">{formatDate(insight.expires_at)}</dd></div>
        <div className="flex justify-between"><dt className="text-muted">Scope</dt><dd className="font-mono">v{insight.version} only</dd></div>
        <div className="flex justify-between"><dt className="text-muted">Network</dt><dd className="font-mono">NEAR testnet</dd></div>
      </dl>

      {step !== "idle" && step !== "ready" && <Stepper step={step} />}
      {err && (
        <div role="alert" className="space-y-1 rounded-md border border-danger/50 p-3 text-sm">
          <p className="flex items-center gap-2 text-danger"><AlertTriangle className="h-4 w-4" aria-hidden />{err.title}</p>
          <p className="text-muted">{err.next}</p>
        </div>
      )}
      {unavailable && <p role="status" className="text-sm text-warning">This insight is {insight.status}, so it can&apos;t be borrowed.</p>}

      {accountId ? (
        <Button variant="primary" size="lg" className="w-full" loading={borrow.isPending} disabled={!!capError || unavailable} onClick={() => borrow.mutate()}>
          Borrow
        </Button>
      ) : (
        <Button variant="primary" size="lg" className="w-full" loading={connecting} disabled={unavailable} onClick={() => connect()}>Connect wallet to borrow</Button>
      )}
      <p className="text-xs text-muted">{DISCLAIMER}</p>

      <Dialog open={!!apiKey} onOpenChange={(o) => { if (!o) closeKey(); }}>
        <DialogContent title="Your key is ready" description="Fee reserved. Charged only if your agent reports a trade.">
          <Stepper step="ready" />
          <div className="mt-4 space-y-3">
            <p className="label-caps">API key</p>
            <code className="block break-all rounded-md border border-border bg-background p-3 font-mono text-xs">{apiKey}</code>
            <div className="flex items-center justify-between gap-3">
              <p role="alert" className="flex items-center gap-2 text-sm text-warning"><AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />Shown only once. Store it now.</p>
              <CopyButton value={apiKey ?? ""} label="Copy key" />
            </div>
            <div className="flex flex-wrap gap-2 pt-2">
              <Button asChild variant="secondary"><Link href="/keys">Go to Connect your API</Link></Button>
              <Button variant="ghost" onClick={closeKey}>I stored it</Button>
            </div>
            {borrowId && <p className="font-mono text-[11px] text-muted">borrow_id: {borrowId}</p>}
          </div>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
