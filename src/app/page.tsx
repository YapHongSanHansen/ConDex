import Link from "next/link";
import { Button } from "@/components/ui/button";
import { FlipBoard } from "@/components/home/flip-board";
import { Stats } from "@/components/home/stats";
import { LiveBoard } from "@/components/home/live-board";
import { FaqSection } from "@/components/home/faq";
import { HowItWorks } from "@/components/home/how-it-works";
import { KeyCapabilities } from "@/components/home/sections";

export default function HomePage() {
  return (
    <>
      {/* The words and figures are on the board. This keeps the title and the sentence as real page text. */}
      <h1 className="sr-only">Borrow the reasoning. Pay only when it&apos;s used.</h1>
      <p className="sr-only">Creators publish their reasoning from Claude Code. Your agent reads it and trades on it. The creator is paid only when a linked order fills.</p>
      <FlipBoard>
        <div className="flex flex-wrap justify-center gap-3">
          <Button asChild variant="primary" size="lg"><Link href="/gallery">Browse the gallery</Link></Button>
          <Button asChild variant="secondary" size="lg" className="bg-background"><Link href="/publish">Publish a thesis</Link></Button>
        </div>
      </FlipBoard>
      <div className="container-wide space-y-20 overflow-x-clip py-10 md:py-14">
        <Stats />
        <HowItWorks />
        <LiveBoard />
        <KeyCapabilities />
        <FaqSection />
      </div>
    </>
  );
}
