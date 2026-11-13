"use client";

import { useState } from "react";
import { Database, EyeOff, HardDrive, Link2, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

const FAQ = [
  { q: "Is borrowing free?", a: "Yes. A fee cap is reserved while the key is live. The flat fee is charged once, and only if your agent reports the trade executed." },
  { q: "What if my key expires?", a: "The reserve is released and you pay nothing. The creator earns nothing either." },
  { q: "Is the chat uploaded?", a: "No. The context stays on the creator's machine behind an MCP server. ConDex holds a key, the public preview and a hash." },
  { q: "Is there a refund if the trade fails?", a: "No. The fee is for the reasoning, not an outcome. No performance is implied and this is not financial advice." },
  { q: "What is trusted?", a: "The ConDex API, and the agent's own trade report. Nothing verifies either independently in this prototype." },
];

const WHERE: { Icon: LucideIcon; title: string; items: string[]; tone: string }[] = [
  { Icon: HardDrive, title: "Your machine", items: ["Chat text", "Your PNL, if included", "MCP server"], tone: "Never uploaded" },
  { Icon: Database, title: "ConDex API", items: ["API keys", "Public preview", "Version hash"], tone: "Trusted" },
  { Icon: Link2, title: "NEAR testnet", items: ["Fee reserve", "Receipts", "Payout account"], tone: "On-chain" },
  { Icon: EyeOff, title: "Public gallery", items: ["Market", "Horizon", "Price"], tone: "Visible to all" },
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
