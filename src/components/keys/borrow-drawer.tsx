"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle } from "lucide-react";
import { api, friendlyError, toApiError } from "@/lib/api";
import type { Borrow } from "@/lib/api/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/status-badge";
import { USE_MOCKS } from "@/lib/config";
import { formatDate, formatNear } from "@/lib/utils";

function Timeline({ b }: { b: Borrow }) {
  const retrieved = b.status === "retrieved" || b.status === "traded";
  const end =
    b.status === "traded" ? { label: "Trade executed", detail: `Fee charged once: ${formatNear(b.charged)} and paid to the creator. Receipt ${b.receipt_id}.`, at: b.retrieved_at, done: true }
    : b.status === "expired" ? { label: "Expired", detail: "Reserve released. Zero charge.", at: b.expires_at, done: true }
    : b.status === "revoked" ? { label: "Revoked", detail: "Key blocked for new requests. Reserve released.", at: null, done: true }
    : { label: "Waiting for a trade report", detail: `If the agent executes the trade it reports it and the fee is charged once. Otherwise the reserve is released at ${formatDate(b.expires_at)}.`, at: null, done: false };
  const rows = [
    { label: "Reserved", detail: `Up to ${formatNear(b.fee_cap)} reserved. Nothing charged yet.`, at: b.created_at, done: true },
    { label: "Retrieved", detail: retrieved ? "Context fetched. Retrieval is free and retry-safe." : "Not fetched yet.", at: retrieved ? b.retrieved_at : null, done: retrieved },
    end,
  ];
  return (
    <ol className="space-y-4 border-l border-border pl-5">
      {rows.map((r) => (
        <li key={r.label} className="relative">
          <span className="absolute -left-[31px] top-0.5 bg-surface">{r.done ? <CheckCircle2 className="h-4 w-4 text-accent" aria-hidden /> : <Circle className="h-4 w-4 text-muted" aria-hidden />}</span>
          <p className="font-medium">{r.label}</p>
          <p className="text-sm text-muted">{r.detail}</p>
          {r.at && <p className="font-mono text-[11px] text-muted">{formatDate(r.at)}</p>}
        </li>
      ))}
    </ol>
  );
}

export function BorrowDrawer({ borrow, onClose }: { borrow: Borrow | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [key, setKey] = useState(""); // held in memory only, cleared on close
  const retrieve = useMutation({
    mutationFn: () => api.borrows.retrieveInsight(borrow!.id, key.trim()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["borrows"] }),
  });
  const trade = useMutation({
    mutationFn: () => api.borrows.reportTrade(borrow!.id, key.trim()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["borrows"] }),
  });
  const expire = useMutation({
    mutationFn: () => api.borrows.simulateExpiry!(borrow!.id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["borrows"] }); onClose(); },
  });
  const close = () => { setKey(""); retrieve.reset(); trade.reset(); onClose(); };
  const err = retrieve.isError ? friendlyError(toApiError(retrieve.error)) : trade.isError ? friendlyError(toApiError(trade.error)) : null;

  return (
    <Dialog open={!!borrow} onOpenChange={(o) => { if (!o) close(); }}>
      {borrow && (
        <DialogContent side="right" title={`${borrow.market} · v${borrow.insight_version}`} description={`Borrow ${borrow.id}`}>
          <div className="space-y-6">
            <div className="flex items-center gap-2"><StatusBadge status={borrow.status} /></div>
            <Timeline b={borrow} />
            <p className="rounded-md border border-border p-3 text-sm text-muted">Fetching again is free. Only a reported trade charges the fee, once.</p>

            {borrow.status === "active" || borrow.status === "retrieved" || borrow.status === "traded" ? (
              <div className="space-y-3 border-t border-border pt-5">
                <h3 className="label-caps">Test retrieval</h3>
                <label htmlFor="test-key" className="text-sm text-muted">Paste the key. It is not stored.</label>
                <Input id="test-key" type="password" autoComplete="off" placeholder="cdx_test_…" value={key} onChange={(e) => setKey(e.target.value)} />
                <Button variant="primary" loading={retrieve.isPending} disabled={!key.trim()} onClick={() => retrieve.mutate()}>Test retrieval</Button>
                {retrieve.isSuccess && (
                  <div role="status" className="space-y-2 rounded-md border border-accent/50 p-3">
                    <p className="text-sm font-medium text-accent">Success · {retrieve.data.repeat ? "repeat delivery" : "first delivery"}, nothing charged</p>
                    <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed">{retrieve.data.text}</pre>
                  </div>
                )}
                {err && (
                  <div role="alert" className="rounded-md border border-danger/50 p-3 text-sm"><p className="text-danger">{err.title}</p><p className="text-muted">{err.next}</p></div>
                )}
                {trade.isSuccess && <p role="status" className="text-sm text-accent">{trade.data.charged ? `Trade reported. Fee charged once: ${formatNear(trade.data.borrow.charged)}.` : "Already reported. Nothing more charged."}</p>}
                {borrow.status !== "traded" && (
                  <div className="space-y-2 rounded-md border border-border p-3">
                    <p className="text-sm text-muted">Only if your agent really traded. Charges the fee once. Cannot be undone.</p>
                    <Button variant="secondary" size="sm" loading={trade.isPending} disabled={!key.trim()} onClick={() => trade.mutate()}>Report trade executed</Button>
                  </div>
                )}
                {USE_MOCKS && api.borrows.simulateExpiry && borrow.status === "active" && (
                  <Button variant="secondary" size="sm" loading={expire.isPending} onClick={() => expire.mutate()}>Simulate expiry (demo)</Button>
                )}
              </div>
            ) : null}
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
