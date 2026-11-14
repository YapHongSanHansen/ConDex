"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Lock, LockOpen } from "lucide-react";
import { toast } from "sonner";
import { api, friendlyError, toApiError } from "@/lib/api";
import type { InsightDetail } from "@/lib/api/types";
import type { Order, Quote, ReadInsight } from "@/lib/api/wire";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { SignInGate } from "@/components/ui/sign-in-gate";
import { StatusBadge } from "@/components/ui/status-badge";
import { DISCLAIMER } from "@/components/layout/page-header";
import { USE_MOCKS } from "@/lib/config";
import { useWallet } from "@/lib/near/connector";
import { formatDate, formatNear } from "@/lib/utils";

function ErrorLine({ error }: { error: unknown }) {
  const e = friendlyError(toApiError(error));
  return (
    <div role="alert" className="space-y-1 rounded-md border border-danger/50 p-3 text-sm">
      <p className="flex items-center gap-2 text-danger"><AlertTriangle className="h-4 w-4" aria-hidden />{e.title}</p>
      <p className="text-muted">{e.next}</p>
    </div>
  );
}

/** Pays for a subscription from the balance, adding test NEAR first on the mock ledger when the balance is short. */
function Subscribe({ account, onDone }: { account: string; onDone: () => void }) {
  const qc = useQueryClient();
  const sub = useQuery({ queryKey: ["subscription", account], queryFn: () => api.trading.subscription() });
  const bal = useQuery({ queryKey: ["balances", account], queryFn: () => api.trading.balances(account) });
  const pay = useMutation({
    mutationFn: async () => {
      const fee = sub.data!.terms.fee;
      const have = Number(bal.data?.available.near ?? 0);
      if (have < Number(fee.near)) await api.trading.deposit(String(Number(fee.near) - have));
      return api.trading.subscribe();
    },
    onSuccess: () => {
      toast.success("Subscribed. Every full thesis is open to you.");
      qc.invalidateQueries({ queryKey: ["subscription"] });
      qc.invalidateQueries({ queryKey: ["balances"] });
      onDone();
    },
  });
  if (sub.isLoading) return <Skeleton className="h-24" />;
  if (sub.isError) return <ErrorLine error={sub.error} />;
  const fee = Number(sub.data!.terms.fee.near);
  return (
    <div className="space-y-3 rounded-md border border-border p-4">
      <p className="flex items-center gap-2 font-medium"><Lock className="h-4 w-4" aria-hidden />The full thesis is locked</p>
      <p className="text-sm text-muted">The entry, invalidation and conversation unlock with a ConDex subscription: {formatNear(fee)} for {sub.data!.terms.period_days} days, for every thesis. Trading below needs no subscription.</p>
      <Button variant="primary" className="w-full" loading={pay.isPending} onClick={() => pay.mutate()}>Subscribe · {formatNear(fee)}</Button>
      <p className="text-center font-mono text-[11px] text-muted">Balance {bal.data ? formatNear(Number(bal.data.available.near)) : "…"} · paid to {sub.data!.terms.paid_to}</p>
      {pay.isError && <ErrorLine error={pay.error} />}
    </div>
  );
}

function Thesis({ r }: { r: ReadInsight }) {
  const c = r.conditions;
  return (
    <div className="space-y-3 rounded-md border border-accent/40 p-4 text-sm" role="region" aria-label="Full thesis">
      <p className="flex items-center gap-2 text-accent"><LockOpen className="h-4 w-4" aria-hidden />Full thesis · {r.integrity.matches ? "matches its fingerprint" : "DOES NOT match its fingerprint"}</p>
      <dl className="space-y-2">
        {([["Entry", c.entry], ["Invalidation", c.invalidation], ...(c.target ? [["Target", c.target]] : [])] as const).map(([k, v]) => (
          <div key={k}><dt className="label-caps">{k}</dt><dd className="mt-0.5">{v}</dd></div>
        ))}
      </dl>
      <details className="border-t border-border pt-3">
        <summary className="label-caps cursor-pointer hover:text-text">Conversation · {r.messages.length} messages</summary>
        <ul className="mt-2 max-h-64 space-y-2 overflow-y-auto">
          {r.messages.map((m, i) => (
            <li key={i} className="rounded-md bg-surface-2 p-2"><span className="font-mono text-[11px] uppercase text-muted">{m.role}</span><p className="whitespace-pre-wrap">{m.content}</p></li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function Trade({ insight, account }: { insight: InsightDetail; account: string }) {
  const qc = useQueryClient();
  const [qty, setQty] = useState("1");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [placed, setPlaced] = useState<Order | null>(null);
  const side = insight.direction === "long" ? "buy" : "sell";
  const qtyError = !qty || !(Number(qty) > 0) ? "Enter a quantity above 0." : null;
  const own = insight.creator === account;
  const bal = useQuery({ queryKey: ["balances", account], queryFn: () => api.trading.balances(account) });
  const addFunds = useMutation({
    mutationFn: () => api.trading.deposit(String(Math.max(1, Math.ceil(insight.price)))),
    onSuccess: () => { toast.success("Test NEAR added to your balance"); qc.invalidateQueries({ queryKey: ["balances"] }); },
  });
  const short = !!bal.data && Number(bal.data.available.near) < insight.price;

  const getQuote = useMutation({ mutationFn: () => api.trading.quote(insight.id), onSuccess: setQuote });
  const place = useMutation({
    mutationFn: () => api.trading.placeOrder({ quote_id: quote!.quote_id, side, quantity: qty, authorise_fee: true }),
    onSuccess: (o) => {
      toast.success("Order placed. The fee is reserved until it fills.");
      setPlaced(o); setQuote(null);
      for (const k of ["orders", "proof", "balances"]) qc.invalidateQueries({ queryKey: [k] });
    },
  });
  const sim = useMutation({
    mutationFn: () => api.trading.simulate!(placed!.id, "fill"),
    onSuccess: async () => { setPlaced(await api.trading.getOrder(placed!.id)); for (const k of ["orders", "proof", "balances"]) qc.invalidateQueries({ queryKey: [k] }); },
  });
  // The venue confirms the fill later, so the order is checked again every few seconds.
  const live = useQuery({ queryKey: ["order", placed?.id], queryFn: () => api.trading.getOrder(placed!.id), enabled: !!placed, refetchInterval: 3000 });

  if (own) return <p className="rounded-md border border-border p-3 text-sm text-muted">This is your own thesis. A creator can read it free, but cannot link an order to it.</p>;
  if (placed) {
    const o = live.data ?? placed;
    const filled = Number(o.filled_quantity) > 0;
    return (
      <div className="space-y-3 rounded-md border border-border p-4 text-sm" role="status">
        <div className="flex items-center justify-between gap-2"><p className="font-mono">{o.id}</p><StatusBadge status={o.status} /></div>
        <p className="text-muted">{o.side} {o.quantity} {o.market}. Fee {formatNear(Number(o.fee.near))}: {o.settlement.status === "settled" ? "charged once and paid to the creator." : "reserved, and charged once when the order first fills. No fill, no fee."}</p>
        {o.status === "awaiting_approval" && <p className="text-warning">Approve the fee in your wallet to submit this order.</p>}
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="primary" size="sm"><Link href="/keys?tab=orders">{filled ? "Close the trade" : "Track it in Your orders"}</Link></Button>
          {USE_MOCKS && api.trading.simulate && o.status !== "filled" && <Button variant="ghost" size="sm" loading={sim.isPending} onClick={() => sim.mutate()}>Simulate a fill (demo)</Button>}
          <Button variant="ghost" size="sm" onClick={() => setPlaced(null)}>New order</Button>
        </div>
        {sim.isError && <ErrorLine error={sim.error} />}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">A {insight.direction} opens with a <span className="font-mono text-text">{side}</span>. The fee, <span className="text-text">{formatNear(insight.price)}</span>, is reserved when you place the order and charged once, when it first fills. No fill, no fee.</p>
      <Field label="Quantity" htmlFor="qty" error={qtyError}>
        <Input id="qty" inputMode="decimal" value={qty} onChange={(e) => { setQty(e.target.value); setQuote(null); }} aria-invalid={!!qtyError} />
      </Field>
      {short && (
        <div className="space-y-2 rounded-md border border-warning/50 p-3 text-sm">
          <p className="text-warning">Your balance ({bal.data ? formatNear(Number(bal.data.available.near)) : "…"}) is below the fee.</p>
          <Button variant="secondary" size="sm" loading={addFunds.isPending} onClick={() => addFunds.mutate()}>Add {formatNear(Math.max(1, Math.ceil(insight.price)))} test NEAR</Button>
          {addFunds.isError && <ErrorLine error={addFunds.error} />}
        </div>
      )}
      {!quote ? (
        <Button variant="primary" className="w-full" loading={getQuote.isPending} disabled={!!qtyError || insight.status !== "live"} onClick={() => getQuote.mutate()}>Review the fee</Button>
      ) : (
        <div className="space-y-3 rounded-md border border-accent/40 p-3 text-sm">
          <p className="font-medium">{side} {qty} {insight.market}</p>
          <p>Fee <span className="font-mono">{formatNear(Number(quote.fee.near))}</span> to <span className="font-mono">{quote.payout_account}</span>. Quote valid until {formatDate(quote.expires_at)}.</p>
          <p className="text-xs text-muted">{quote.fee_rule}</p>
          <div className="flex gap-2">
            <Button variant="primary" className="flex-1" loading={place.isPending} disabled={short} onClick={() => place.mutate()}>Place the {side} order</Button>
            <Button variant="ghost" onClick={() => setQuote(null)}>Cancel</Button>
          </div>
        </div>
      )}
      {insight.status !== "live" && <p role="status" className="text-sm text-warning">This thesis is {insight.status}, so no new trade can be linked.</p>}
      {(getQuote.isError || place.isError) && <ErrorLine error={getQuote.error ?? place.error} />}
    </div>
  );
}

export function TradePanel({ insight }: { insight: InsightDetail }) {
  const { accountId, signedIn } = useWallet();
  const qc = useQueryClient();
  const own = !!accountId && insight.creator === accountId;
  const subQ = useQuery({ queryKey: ["subscription", accountId], queryFn: () => api.trading.subscription(), enabled: signedIn });
  // Reading is asked for only when it will work: the visitor subscribes, or the thesis is their own.
  const canRead = signedIn && (own || subQ.data?.active === true);
  const readQ = useQuery({ queryKey: ["read", insight.id, accountId], queryFn: () => api.trading.read(insight.id), enabled: canRead, retry: false });
  const locked = signedIn && !own && subQ.data?.active === false;
  return (
    <aside className="space-y-6 rounded-md border border-border bg-surface p-6 lg:sticky lg:top-20 lg:col-start-2 lg:row-span-2 lg:row-start-1" aria-label="Read and trade">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Read &amp; trade</h2>
        <span className="text-right"><span className="block font-mono text-xl" title="Usage fee per filled linked order">{formatNear(insight.price)}</span><span className="label-caps">per filled trade</span></span>
      </div>

      <SignInGate why="to read the full thesis and trade on it">
        {accountId && (
          <>
            <section className="space-y-3" aria-label="Full thesis">
              {(subQ.isLoading || readQ.isLoading) && <Skeleton className="h-24" />}
              {subQ.isError && <ErrorLine error={subQ.error} />}
              {locked && <Subscribe account={accountId} onDone={() => qc.invalidateQueries({ queryKey: ["read"] })} />}
              {readQ.isError && <ErrorLine error={readQ.error} />}
              {readQ.data && <Thesis r={readQ.data} />}
            </section>
            <section className="space-y-3 border-t border-border pt-5" aria-label="Trade">
              <h3 className="label-caps">Trade on it</h3>
              <Trade insight={insight} account={accountId} />
            </section>
          </>
        )}
      </SignInGate>
      <p className="text-xs text-muted">Testnet only. {DISCLAIMER}</p>
    </aside>
  );
}
