"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Skeleton } from "@/components/ui/skeleton";
import { formatNear } from "@/lib/utils";

const FLIP_EVERY_MS = 5500;

interface Card { label: string; value?: string; unit?: string; note: string }

/** Three figures in an even row. All three cards turn over together, front to back and back again. */
export function Stats() {
  const q = useQuery({ queryKey: ["stats"], queryFn: () => api.insights.getStats() });
  const [flipped, setFlipped] = useState(false);
  const [paused, setPaused] = useState(false);
  const [still, setStill] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setStill(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (paused || still) return;
    const id = setInterval(() => setFlipped((f) => !f), FLIP_EVERY_MS);
    return () => clearInterval(id);
  }, [paused, still]);

  // The backend can leave a figure out. It is then shown as unknown, never as a made-up number.
  const near = q.data ? (q.data.paid_to_creators === null ? ["n/a"] : formatNear(q.data.paid_to_creators).split(" ")) : [];
  const known = (n: number | null | undefined) => (n === undefined ? undefined : n === null ? "n/a" : String(n));
  const cards: Card[] = [
    { label: "Theses", value: known(q.data?.insights_listed), note: "Reasoning published and still open to trade" },
    { label: "Trades today", value: known(q.data?.trades_today), note: "Orders linked to a thesis in the last 24 hours" },
    { label: "Paid out", value: near[0], unit: near.slice(1).join(" "), note: "Earned by creators, only when a linked order fills" },
  ];

  return (
    <dl
      className="grid grid-cols-1 gap-4 sm:grid-cols-3"
      onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}
    >
      {cards.map((c, i) => (
        <div key={c.label} className="h-36 [perspective:1100px] sm:h-44">
          <div
            className="relative h-full w-full transition-transform duration-[900ms] ease-[cubic-bezier(.4,.1,.2,1)] [transform-style:preserve-3d] motion-reduce:transition-none"
            style={{ transform: flipped ? "rotateX(180deg)" : "rotateX(0deg)" }}
          >
            {/* Front: the figure. */}
            <div className="absolute inset-0 rounded-xl border border-border bg-surface p-5 [backface-visibility:hidden]">
              <dt className="label-caps flex items-center justify-between">
                {c.label}
                <span className="font-mono text-[10px] tracking-widest text-muted/60">{String(i + 1).padStart(2, "0")}/03</span>
              </dt>
              {/* Centred on the seam, so the line runs through the middle of the figure like a split-flap digit. */}
              <dd className="absolute inset-x-5 top-1/2 flex -translate-y-[46%] items-baseline gap-2 font-mono">
                {q.isError ? <span className="text-2xl text-muted">n/a</span> : c.value === undefined ? <Skeleton className="h-10 w-24" /> : (
                  <>
                    <span className="text-5xl font-semibold leading-none tracking-tight sm:text-6xl">{c.value}</span>
                    {c.unit && <span className="text-sm tracking-widest text-muted">{c.unit}</span>}
                  </>
                )}
              </dd>
              <Seam />
            </div>
            {/* Back: what the figure means. */}
            <div aria-hidden="true" className="absolute inset-0 rounded-xl border border-border bg-surface-2 p-5 [backface-visibility:hidden] [transform:rotateX(180deg)]">
              <span className="label-caps">{c.label}</span>
              <p className="absolute inset-x-5 top-1/2 max-w-[16rem] -translate-y-1/2 text-lg leading-snug text-text">{c.note}</p>
              <Seam />
            </div>
          </div>
        </div>
      ))}
    </dl>
  );
}

/** The thin line across the middle of a split-flap card. */
function Seam() {
  return <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-1/2 h-px bg-border/70" />;
}
