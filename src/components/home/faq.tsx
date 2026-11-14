"use client";

import { useState } from "react";
import { Database, EyeOff, HardDrive, Link2, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const FAQ = [
  { q: "What does reading cost?", a: "The abstract and the author's record are free. A subscription (1 test NEAR for 30 days by default) unlocks every full thesis. Trading needs no subscription." },
  { q: "When is the creator paid?", a: "Once, on the first confirmed fill of an order linked to the thesis, even a partial one. The fee is reserved when the order is placed and released if it never fills." },
  { q: "What if the thesis expires?", a: "No new fee quote or linked order is possible. Reading still works, and trades opened before the expiry still record their result when they close." },
  { q: "Is the chat public?", a: "No. The approved messages are stored privately and served only to readers with a subscription. The public record shows a fingerprint, not the text." },
  { q: "Is there a refund if the trade loses?", a: "No. The fee pays for the reasoning, not an outcome. A loss is recorded on the thesis and counts in the creator's record. This is not financial advice." },
  { q: "What is trusted?", a: "ConDex, and the execution route that confirms a fill. Orders placed outside a connected route cannot be proven, charged or scored." },
];

const WHERE: { Icon: LucideIcon; title: string; items: string[]; tone: string }[] = [
  { Icon: HardDrive, title: "Your machine", items: ["Your agent", "Your API keys", "MCP server"], tone: "Stays with you" },
  { Icon: Database, title: "ConDex API", items: ["Private messages", "Orders and fills", "Evaluations"], tone: "Trusted" },
  { Icon: Link2, title: "NEAR testnet", items: ["Thesis fingerprint", "Fee reserve", "Proofs of trade"], tone: "On-chain" },
  { Icon: EyeOff, title: "Public gallery", items: ["Market and direction", "Expiry and fee", "Author's record"], tone: "Visible to all" },
];

export function FaqSection() {
  const [i, setI] = useState(0);
  return (
    <section aria-labelledby="faq" className="space-y-10">
      <div className="space-y-1">
        <p className="label-caps">FAQ</p>
        <h2 id="faq" className="text-2xl font-semibold tracking-tight">Questions, answered.</h2>
      </div>

      <div className="grid gap-px overflow-hidden rounded-xl border border-border bg-border lg:grid-cols-[minmax(0,360px)_1fr]">
        <ul className="bg-background" role="tablist" aria-label="Questions" aria-orientation="vertical">
          {FAQ.map((f, n) => (
            <li key={f.q} role="presentation">
              <button
                role="tab"
                id={`faq-tab-${n}`}
                aria-selected={n === i}
                aria-controls="faq-panel"
                onClick={() => setI(n)}
                className={cn("flex w-full cursor-pointer items-center gap-2.5 border-b border-border px-5 py-4 text-left text-sm transition-colors last:border-b-0", n === i ? "bg-surface font-medium" : "text-muted hover:bg-surface/60 hover:text-text")}
              >
                <span className="font-mono text-xs tabular-nums text-muted">{String(n + 1).padStart(2, "0")}</span>
                {f.q}
              </button>
            </li>
          ))}
        </ul>
        <div id="faq-panel" role="tabpanel" aria-labelledby={`faq-tab-${i}`} className="flex min-h-56 flex-col justify-start gap-3 bg-surface p-6 md:p-8">
          <div className="space-y-3">
            <p className="font-mono text-xs text-muted">Q{i + 1}</p>
            <h3 className="text-xl font-semibold tracking-tight md:text-2xl">{FAQ[i].q}</h3>
            <p className="max-w-xl leading-relaxed text-muted" aria-live="polite">{FAQ[i].a}</p>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <h3 className="text-sm font-semibold">Where things live</h3>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {WHERE.map((w) => (
            <div key={w.title} className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-5">
              <div className="flex items-center justify-between">
                <w.Icon className="h-4 w-4 text-text" aria-hidden />
                <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted">{w.tone}</span>
              </div>
              <p className="font-medium">{w.title}</p>
              <ul className="space-y-1.5 text-sm text-muted">
                {w.items.map((it) => <li key={it} className="flex items-center gap-2"><span className="h-1 w-1 rounded-full bg-muted" aria-hidden />{it}</li>)}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
