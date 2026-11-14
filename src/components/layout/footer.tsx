import Link from "next/link";

const REPO = "https://github.com/YapHongSanHansen/ConDex";
const COLUMNS: { title: string; links: { label: string; href: string; external?: boolean }[] }[] = [
  { title: "Product", links: [{ label: "Gallery", href: "/gallery" }, { label: "Publish a thesis", href: "/publish" }, { label: "Keys & orders", href: "/keys" }, { label: "Payouts", href: "/payouts" }] },
  { title: "Developers", links: [{ label: "How it works", href: "/#how" }, { label: "MCP setup", href: "/keys?tab=keys" }, { label: "Backend README", href: `${REPO}/tree/backend#readme`, external: true }, { label: "GitHub", href: REPO, external: true }] },
  { title: "Protocol", links: [{ label: "NEAR testnet", href: "https://testnet.nearblocks.io", external: true }, { label: "Contract", href: `${REPO}/tree/backend/contract`, external: true }, { label: "Wallet connector", href: "https://github.com/hot-dao/near-selector", external: true }] },
  { title: "Legal", links: [{ label: "Disclaimer", href: "#disclaimer" }] },
];

export function Footer() {
  return (
    <footer className="relative mt-24 overflow-hidden border-t border-border">
      <div className="container-wide relative z-10 pt-14 pb-10">
        <div className="grid gap-10 lg:grid-cols-[1.4fr_2.6fr]">
          <div className="space-y-4">
            <Link href="/" className="inline-block text-[19px] font-semibold tracking-tight">Con<span className="font-light text-muted">Dex</span></Link>
            <p className="max-w-xs text-sm leading-relaxed text-muted">Trading reasoning from AI chats. The creator is paid only when a linked order fills.</p>
            <p className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 font-mono text-[11px] text-muted">
              <span className="h-1.5 w-1.5 rounded-full bg-text" aria-hidden />NEAR testnet · prototype
            </p>
          </div>
          <nav aria-label="Footer" className="grid grid-cols-2 gap-8 sm:grid-cols-4">
            {COLUMNS.map((c) => (
              <div key={c.title} className="space-y-3">
                <p className="label-caps">{c.title}</p>
                <ul className="space-y-2 text-sm">
                  {c.links.map((l) => (
                    <li key={l.label}>
                      {l.href.startsWith("/") ? <Link href={l.href} className="text-muted transition-colors hover:text-text">{l.label}</Link>
                        : <a href={l.href} {...(l.external ? { target: "_blank", rel: "noreferrer" } : {})} className="text-muted transition-colors hover:text-text">{l.label}</a>}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </div>

        <div id="disclaimer" className="mt-12 grid gap-3 border-t border-border py-6 text-xs text-muted md:grid-cols-[1fr_auto] md:items-center">
          <p className="max-w-3xl leading-relaxed">Theses are reasoning shared by creators, not financial advice. No performance is implied. Fills come from the execution route ConDex is connected to, and ConDex itself is trusted in this prototype. Testnet only: never use real funds.</p>
          <p className="font-mono">© 2026 ConDex · v0.1.0</p>
        </div>
      </div>
      <div aria-hidden className="pointer-events-none relative z-0 -mt-2 select-none overflow-hidden text-center font-semibold leading-[0.8] tracking-tighter" style={{ fontSize: "clamp(110px, 24vw, 380px)", height: "0.72em", color: "transparent", WebkitTextStroke: "1px color-mix(in srgb, var(--text) 9%, transparent)", maskImage: "linear-gradient(to bottom, transparent 0%, #000 40%, #000 100%)" }}>
        ConDex
      </div>
    </footer>
  );
}
