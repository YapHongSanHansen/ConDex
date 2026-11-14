"use client";

import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Lock, LockOpen } from "lucide-react";
import { api, friendlyError, toApiError } from "@/lib/api";
import type { InsightDetail } from "@/lib/api/types";
import type { Order, Quote, ReadInsight } from "@/lib/api/wire";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
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

/** Test NEAR is only deposited this way on the mock ledger. On NEAR the account deposits to the contract itself. */
function Subscribe({ account }: { account: string }) {
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
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["subscription"] }); qc.invalidateQueries({ queryKey: ["balances"] }); },
  });
  if (sub.isLoading) return <p className="text-sm text-muted">Checking your subscription…</p>;
  if (sub.isError) return <ErrorLine error={sub.error} />;
  const s = sub.data!;
  if (s.active) return <p className="text-sm text-muted">Subscribed until <span className="font-mono text-text">{formatDate(s.subscribed_until!)}</span>. Every full thesis is open to you.</p>;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">The abstract is free. A subscription ({formatNear(Number(s.terms.fee.near))} for {s.terms.period_days} days, paid to ConDex) unlocks every full thesis. Trading needs none.</p>
      <p className="font-mono text-xs text-muted">Balance: {bal.data ? formatNear(Number(bal.data.available.near)) : "…"}</p>
      <Button variant="secondary" loading={pay.isPending} onClick={() => pay.mutate()}>Subscribe · {formatNear(Number(s.terms.fee.near))}</Button>
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
      <div className="space-y-2 border-t border-border pt-3">
        <p className="label-caps">Conversation · {r.messages.length} messages</p>
        <ul className="max-h-64 space-y-2 overflow-y-auto">
          {r.messages.map((m, i) => (
            <li key={i} className="rounded-md bg-surface-2 p-2"><span className="font-mono text-[11px] uppercase text-muted">{m.role}</span><p className="whitespace-pre-wrap">{m.content}</p></li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Trade({ insight, account }: { insight: InsightDetail; account: string }) {
  const qc = useQueryClient();
  const bal = useQuery({ queryKey: ["balances", account], queryFn: () => api.trading.balances(account) });
  const addFunds = useMutation({
    mutationFn: () => api.trading.deposit(String(Math.max(1, Math.ceil(insight.price)))),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["balances"] }),
  });
  const short = !!bal.data && Number(bal.data.available.near) < insight.price;
  const [qty, setQty] = useState("1");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [placed, setPlaced] = useState<Order | null>(null);
  const side = insight.direction === "long" ? "buy" : "sell";
  const qtyError = !qty || !(Number(qty) > 0) ? "Enter a quantity above 0." : null;

  const getQuote = useMutation({ mutationFn: () => api.trading.quote(insight.id), onSuccess: setQuote });
  const place = useMutation({
    mutationFn: () => api.trading.placeOrder({ quote_id: quote!.quote_id, side, quantity: qty, authorise_fee: true }),
    onSuccess: (o) => { setPlaced(o); setQuote(null); qc.invalidateQueries({ queryKey: ["orders"] }); qc.invalidateQueries({ queryKey: ["proof"] }); },
  });
  const sim = useMutation({
    mutationFn: () => api.trading.simulate!(placed!.id, "fill"),
    onSuccess: async () => { setPlaced(await api.trading.getOrder(placed!.id)); qc.invalidateQueries({ queryKey: ["orders"] }); qc.invalidateQueries({ queryKey: ["proof"] }); qc.invalidateQueries({ queryKey: ["balances"] }); },
  });

  // The venue confirms the fill later, so the order is checked again every few seconds.
  const live = useQuery({ queryKey: ["order", placed?.id], queryFn: () => api.trading.getOrder(placed!.id), enabled: !!placed, refetchInterval: 3000 });
  if (placed) {
    const o = live.data ?? placed;
    return (
      <div className="space-y-3 rounded-md border border-border p-4 text-sm" role="status">
        <div className="flex items-center justify-between gap-2"><p className="font-mono">{o.id}</p><StatusBadge status={o.status} /></div>
        <p className="text-muted">{o.side} {o.quantity} {o.market}. Fee {formatNear(Number(o.fee.near))}: {o.settlement.status === "settled" ? "charged once and paid to the creator." : "reserved, and charged once when the order first fills."}</p>
        {o.status === "awaiting_approval" && <p className="text-warning">Approve the fee in your wallet to submit this order.</p>}
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="secondary" size="sm"><Link href="/keys#orders">Your orders</Link></Button>
          {USE_MOCKS && api.trading.simulate && o.status !== "filled" && (
            <Button variant="ghost" size="sm" loading={sim.isPending} onClick={() => sim.mutate()}>Simulate a fill (demo)</Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => setPlaced(null)}>New order</Button>
        </div>
        {sim.isError && <ErrorLine error={sim.error} />}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">A {insight.direction} opens with a <span className="font-mono text-text">{side}</span>. The fee, <span className="text-text">{formatNear(insight.price)}</span>, is reserved when you place the order and charged once, when it first fills. No fill, no fee.</p>
      <p className="font-mono text-xs text-muted">Balance: {bal.data ? formatNear(Number(bal.data.available.near)) : "…"}</p>
      {short && (
        <div className="space-y-2 rounded-md border border-warning/50 p-3 text-sm">
          <p className="text-warning">Your balance is below the fee, so the order can&apos;t reserve it.</p>
          <Button variant="secondary" size="sm" loading={addFunds.isPending} onClick={() => addFunds.mutate()}>Add {formatNear(Math.max(1, Math.ceil(insight.price)))} test NEAR</Button>
          {addFunds.isError && <ErrorLine error={addFunds.error} />}
        </div>
      )}
      <Field label="Quantity" htmlFor="qty" error={qtyError}>
        <Input id="qty" inputMode="decimal" value={qty} onChange={(e) => { setQty(e.target.value); setQuote(null); }} aria-invalid={!!qtyError} />
      </Field>
      {!quote ? (
        <Button variant="primary" className="w-full" loading={getQuote.isPending} disabled={!!qtyError || insight.status !== "live"} onClick={() => getQuote.mutate()}>Get fee quote</Button>
      ) : (
        <div className="space-y-3 rounded-md border border-border p-3 text-sm">
          <p>Fee <span className="font-mono">{formatNear(Number(quote.fee.near))}</span> to <span className="font-mono">{quote.payout_account}</span>. Quote valid until {formatDate(quote.expires_at)}.</p>
          <p className="text-xs text-muted">{quote.fee_rule}</p>
          <Button variant="primary" className="w-full" loading={place.isPending} onClick={() => place.mutate()}>Authorise the fee and place the {side} order</Button>
        </div>
      )}
      {insight.status !== "live" && <p role="status" className="text-sm text-warning">This thesis is {insight.status}, so no new trade can be linked.</p>}
      {(getQuote.isError || place.isError) && <ErrorLine error={getQuote.error ?? place.error} />}
    </div>
  );
}

export function TradePanel({ insight }: { insight: InsightDetail }) {
  const { accountId, signedIn, signingIn, signIn, connect, connecting } = useWallet();
  const [shown, setShown] = useState(false);
  const readQ = useQuery({
    queryKey: ["read", insight.id, accountId],
    queryFn: () => api.trading.read(insight.id),
    enabled: shown && signedIn,
    retry: false,
  });
  return (
    <aside className="space-y-6 rounded-md border border-border bg-surface p-6 lg:sticky lg:top-20" aria-label="Read and trade">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Read &amp; trade</h2>
        <span className="font-mono text-xl" title="Usage fee per filled linked order">{formatNear(insight.price)}</span>
      </div>

      {!accountId ? (
        <Button variant="primary" size="lg" className="w-full" loading={connecting} onClick={() => connect()}>Connect wallet</Button>
      ) : !signedIn ? (
        <div className="space-y-2">
          <p className="text-sm text-muted">Sign ConDex&apos;s message with {accountId} to read and trade. It costs nothing.</p>
          <Button variant="primary" size="lg" className="w-full" loading={signingIn} onClick={() => signIn()}>Sign in</Button>
        </div>
      ) : (
        <>
          <section className="space-y-3" aria-label="Read the full thesis">
            <h3 className="label-caps flex items-center gap-2"><Lock className="h-3.5 w-3.5" aria-hidden />Read the full thesis</h3>
            <Subscribe account={accountId} />
            <Button variant="secondary" loading={readQ.isFetching} onClick={() => { setShown(true); if (shown) readQ.refetch(); }}>{readQ.data ? "Read again" : "Read the full thesis"}</Button>
            {readQ.isError && <ErrorLine error={readQ.error} />}
            {readQ.data && <Thesis r={readQ.data} />}
          </section>
          <section className="space-y-3 border-t border-border pt-5" aria-label="Trade">
            <h3 className="label-caps">Trade on it</h3>
            <Trade insight={insight} account={accountId} />
          </section>
        </>
      )}
      <p className="text-xs text-muted">Testnet only. {DISCLAIMER}</p>
    </aside>
  );
}
