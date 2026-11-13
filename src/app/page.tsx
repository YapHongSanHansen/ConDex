import Link from "next/link";
import { Button } from "@/components/ui/button";
import { DotBoard } from "@/components/home/dot-board";
import { Stats } from "@/components/home/stats";
import { LiveBoard } from "@/components/home/live-board";
import { FaqSection } from "@/components/home/faq";
import { HowItWorks } from "@/components/home/how-it-works";
import { KeyCapabilities } from "@/components/home/sections";

export default function HomePage() {
  return (
    <div className="container-wide space-y-20 overflow-x-clip py-6 md:py-8">
      <section className="bleed relative grid items-center lg:min-h-[calc(100vh-9rem)] lg:grid-cols-[1.25fr_1fr]">
        <div className="h-[340px] sm:h-[420px] lg:h-full lg:min-h-[560px]"><DotBoard /></div>
        <div className="space-y-5 px-[var(--gutter)] pb-4 lg:pl-4">
          <h1 className="text-4xl font-semibold leading-[1.08] tracking-tight md:text-5xl">Borrow the reasoning. Pay only when it&apos;s used.</h1>
          <p className="max-w-md leading-relaxed text-muted">
            Traders export reasoning from Claude Code. Your agent borrows it. The creator is paid only if the trade executes.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button asChild variant="primary" size="lg"><Link href="/gallery">Browse the gallery</Link></Button>
            <Button asChild variant="secondary" size="lg"><Link href="/publish">Publish an insight</Link></Button>
          </div>
          <Stats />
        </div>
      </section>
      <HowItWorks />
      <LiveBoard />
      <KeyCapabilities />
      <FaqSection />
    </div>
  );
}
