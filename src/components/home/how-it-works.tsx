"use client";

import { useEffect, useRef, useState } from "react";
import { Bot, Cpu, Database, Laptop, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type NodeId = "creator" | "api" | "agent" | "near";
// Hub layout: the API sits in the middle, NEAR below it.
const NODES: Record<NodeId, { label: string; sub: string; Icon: LucideIcon; x: string; y: number }> = {
  creator: { label: "Creator", sub: "Claude Code + MCP", Icon: Laptop, x: "17%", y: 62 },
  api: { label: "ConDex API", sub: "keys · previews", Icon: Database, x: "50%", y: 62 },
  agent: { label: "Borrower", sub: "scoped key", Icon: Bot, x: "83%", y: 62 },
  near: { label: "NEAR", sub: "reserve · receipts", Icon: Cpu, x: "50%", y: 200 },
};

interface Edge { from: NodeId; to: NodeId; label: string }
const STEPS: { title: string; short: string; body: string; edges: Edge[]; code: string; stage: number; amount: string }[] = [
  {
    title: "Publish", short: "Creator publishes a thesis",
    body: "Claude Code publishes through the MCP server: the market, direction, entry, invalidation, an expiry and a fee. The approved messages stay private. A fingerprint of the thesis is minted on NEAR.",
    edges: [{ from: "creator", to: "api", label: "thesis + expiry" }, { from: "api", to: "near", label: "mint" }],
    code: '> condex_publish_insight({ market: "ETH-USD", direction: "short",\n    expiry_date: "2026-11-20", fee_near: "0.1" })\n< { token_id: "ins_…-v1", mint: { tx: "…" } }',
    stage: 0, amount: "Nothing charged",
  },
  {
    title: "Read", short: "Agent reads the thesis",
    body: "The abstract and the author's record are free. A subscription unlocks the full thesis for the agent: its conditions and conversation, checked against the fingerprint.",
    edges: [{ from: "agent", to: "api", label: "GET thesis" }],
    code: "GET /v1/tokens/ins_…-v1\nAuthorization: Bearer cdx_…\n< { conditions, messages, integrity: { matches: true } }",
    stage: 1, amount: "Subscription, not per read",
  },
  {
    title: "Trade", short: "Agent links an order",
    body: "To act on it, the agent asks for a fee quote and places an order in the thesis's market and direction, before the expiry. The fee is reserved, not charged.",
    edges: [{ from: "agent", to: "api", label: "quote + order" }, { from: "api", to: "near", label: "reserve" }],
    code: 'POST /v1/quotes  { "token_id": "ins_…-v1" }\nPOST /v1/orders  { "quote_id": "…", "side": "sell",\n  "quantity": "2", "authorise_fee": true }',
    stage: 2, amount: "0.1 NEAR reserved",
  },
  {
    title: "Pay and prove", short: "First fill pays the creator",
    body: "On the order's first confirmed fill the fee is paid to the creator once, and a proof of trade is recorded. Closing the trade adds its result. No fill, no fee.",
    edges: [{ from: "agent", to: "api", label: "fill confirmed" }, { from: "api", to: "near", label: "settle" }],
    code: '< { settlement: { status: "settled" },\n    trade: { status: "closed", result: { pnl: "400", outcome: "win" } } }',
    stage: 3, amount: "0.1 NEAR paid to creator",
  },
];
const STAGES = ["Read", "Reserved", "Paid once"];

function Diagram({ edges }: { edges: Edge[] }) {
  const active = new Set(edges.flatMap((e) => [e.from, e.to]));
  const lines: [NodeId, NodeId][] = [["creator", "api"], ["api", "agent"], ["api", "near"]];
  const edgeFor = (a: NodeId, b: NodeId) => edges.find((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a));
  return (
    <div className="relative h-[270px] w-full overflow-hidden rounded-lg border border-border bg-background" style={{ backgroundImage: "radial-gradient(var(--border) 1px, transparent 1px)", backgroundSize: "18px 18px" }} aria-hidden>
      <svg className="absolute inset-0 h-full w-full">
        {lines.map(([a, b]) => {
          const e = edgeFor(a, b);
          const rev = e ? e.from !== a : false;
          const [p, q] = rev ? [NODES[b], NODES[a]] : [NODES[a], NODES[b]];
          return (
            <g key={a + b}>
              <line x1={NODES[a].x} y1={NODES[a].y} x2={NODES[b].x} y2={NODES[b].y} stroke="var(--border)" strokeWidth="1" />
              {e && <line x1={p.x} y1={p.y} x2={q.x} y2={q.y} stroke="var(--text)" strokeWidth="1.5" strokeDasharray="3 7" strokeLinecap="round" style={{ animation: "flow 0.9s linear infinite" }} />}
            </g>
          );
        })}
      </svg>
      {edges.map((e) => {
        const a = NODES[e.from], b = NODES[e.to];
        const vertical = a.x === b.x;
        const style: React.CSSProperties = vertical
          ? { left: a.x, top: (a.y + b.y) / 2, transform: "translate(14px,-50%)" }
          : { left: `calc((${a.x} + ${b.x}) / 2)`, top: a.y - 14, transform: "translate(-50%,-100%)" };
        return <span key={e.label} className={cn("absolute whitespace-nowrap rounded-full border border-border bg-surface px-2 py-0.5 font-mono text-[10px] text-text", !vertical && "hidden sm:block")} style={style}>{e.label}</span>;
      })}
      {(Object.keys(NODES) as NodeId[]).map((id) => {
        const n = NODES[id];
        const on = active.has(id);
        return (
          <div key={id} className={cn("absolute flex w-[74px] -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1 rounded-lg border bg-surface px-1 py-2 text-center sm:px-2 sm:py-2.5 transition-all duration-300 sm:w-32", on ? "border-text shadow-[0_0_0_4px_color-mix(in_srgb,var(--text)_8%,transparent)]" : "border-border opacity-45")} style={{ left: n.x, top: n.y }}>
            <n.Icon className="h-4 w-4" />
            <span className="text-[11px] font-medium sm:text-xs">{n.label}</span>
            <span className="hidden text-[10px] leading-tight text-muted sm:block">{n.sub}</span>
          </div>
        );
      })}
    </div>
  );
}

function Terminal({ code }: { code: string }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-background">
      <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
        <span className="h-2 w-2 rounded-full bg-border" /><span className="h-2 w-2 rounded-full bg-border" /><span className="h-2 w-2 rounded-full bg-border" />
        <span className="ml-2 font-mono text-[10px] uppercase tracking-wider text-muted">request</span>
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-[12.5px] leading-relaxed"><code>{code.split("\n").map((l, i) => (
        <span key={i} className={cn("block", l.startsWith("<") ? "text-muted" : "text-text")}>{l}</span>
      ))}</code></pre>
    </div>
  );
}

export function HowItWorks() {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const reduced = useRef(false);

  useEffect(() => {
    reduced.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);
  useEffect(() => {
    if (paused || reduced.current) return;
    const t = setInterval(() => setI((n) => (n + 1) % STEPS.length), 5000);
    return () => clearInterval(t);
  }, [paused]);

  const s = STEPS[i];
  return (
    <section aria-labelledby="how" className="space-y-6" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
      <div className="flex items-end justify-between gap-4">
        <div className="space-y-1">
          <p className="label-caps">How it works</p>
          <h2 id="how" className="text-2xl font-semibold tracking-tight">Four steps, one fee.</h2>
        </div>
        <p className="hidden font-mono text-xs text-muted sm:block">{String(i + 1).padStart(2, "0")} / {String(STEPS.length).padStart(2, "0")}</p>
      </div>

      <div className="grid gap-px overflow-hidden rounded-xl border border-border bg-border lg:grid-cols-[minmax(0,320px)_1fr]">
        <ol className="flex flex-col bg-background" aria-label="Steps">
          {STEPS.map((st, n) => (
            <li key={st.title} className="flex-1">
              <button
                onClick={() => setI(n)}
                aria-current={n === i ? "step" : undefined}
                className={cn("group relative flex h-full w-full cursor-pointer items-start gap-4 border-b border-border px-5 py-5 text-left last:border-b-0 transition-colors", n === i ? "bg-surface" : "hover:bg-surface/60")}
              >
                <span className={cn("font-mono text-xs tabular-nums", n === i ? "text-text" : "text-muted")}>{String(n + 1).padStart(2, "0")}</span>
                <span className="space-y-1">
                  <span className={cn("block font-medium", n !== i && "text-muted group-hover:text-text")}>{st.title}</span>
                  <span className="block text-xs text-muted">{st.short}</span>
                </span>
                {n === i && !paused && !reduced.current && <span key={i} className="absolute bottom-0 left-0 h-px bg-text" style={{ animation: "progress 5s linear forwards" }} />}
                {n === i && <span className="absolute inset-y-0 left-0 w-0.5 bg-text" />}
              </button>
            </li>
          ))}
        </ol>

        <div className="space-y-5 bg-surface p-4 md:p-6">
          <Diagram edges={s.edges} />
          <div className="grid gap-5 md:grid-cols-2">
            <div className="flex flex-col justify-between gap-5">
              <p className="text-sm leading-relaxed text-muted" aria-live="polite">{s.body}</p>
              <div className="space-y-3">
                <div className="flex items-center gap-1.5" role="list" aria-label="Fee stages">
                  {STAGES.map((st, n) => (
                    <div key={st} role="listitem" className="flex-1 space-y-1.5">
                      <div className={cn("h-1 rounded-full transition-colors duration-500", n < s.stage || (s.stage === 3) ? "bg-text" : "bg-border")} />
                      <p className={cn("font-mono text-[10px] uppercase tracking-wider", n < s.stage || s.stage === 3 ? "text-text" : "text-muted")}>{st}</p>
                    </div>
                  ))}
                </div>
                <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                  <span className="label-caps">Fee</span>
                  <span className={cn("font-mono text-xs", s.stage === 3 ? "text-text" : s.stage === 0 ? "text-muted" : "text-warning")}>{s.amount}</span>
                </div>
              </div>
            </div>
            <Terminal code={s.code} />
          </div>
          <p className="text-[11px] text-muted">Expires without a trade? The reserve is released and nothing is charged.</p>
        </div>
      </div>
    </section>
  );
}
