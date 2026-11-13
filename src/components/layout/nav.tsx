"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { ChevronDown, Copy, ExternalLink, LogOut, Menu, Moon, Plus, Sun, Wallet } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { DropdownContent, DropdownItem, DropdownMenu, DropdownTrigger } from "@/components/ui/dropdown";
import { useTheme } from "@/lib/theme";
import { useWallet } from "@/lib/near/connector";
import { EXPLORER_ACCOUNT_URL } from "@/lib/config";
import { cn, truncateAccount } from "@/lib/utils";

const LINKS = [
  { href: "/", label: "Home" },
  { href: "/gallery", label: "Gallery" },
  { href: "/keys", label: "Connect your API" },
  { href: "/payouts", label: "Payouts" },
];

function Logo() {
  return (
    <Link href="/" className="text-[19px] font-semibold tracking-tight" aria-label="ConDex home">
      Con<span className="font-light text-muted">Dex</span>
    </Link>
  );
}

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <Button variant="ghost" size="icon" onClick={toggle} aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} className="h-9 w-9 rounded-full">
      {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </Button>
  );
}

function WalletButton({ onDone }: { onDone?: () => void }) {
  const { accountId, connect, disconnect, connecting, ready } = useWallet();
  if (!accountId) {
    return (
      <Button variant="primary" className="h-9 rounded-full px-4" loading={connecting} disabled={!ready} onClick={async () => { await connect(); onDone?.(); }}>
        <Wallet className="h-4 w-4" aria-hidden /> Connect wallet
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownTrigger asChild>
        <Button variant="secondary" className="h-9 rounded-full" aria-label={`Wallet menu for ${accountId}`}>
          <span className="h-1.5 w-1.5 rounded-full bg-positive" aria-hidden />
          <span className="font-mono text-xs">{truncateAccount(accountId, 10, 8)}</span>
          <Badge tone="muted" className="hidden sm:inline-flex">testnet</Badge>
          <ChevronDown className="h-3.5 w-3.5" aria-hidden />
        </Button>
      </DropdownTrigger>
      <DropdownContent>
        <DropdownItem onSelect={async () => { await navigator.clipboard.writeText(accountId).catch(() => {}); toast.success("Account id copied"); }}>
          <Copy className="h-4 w-4" /> Copy account id
        </DropdownItem>
        <DropdownItem asChild>
          <a href={`${EXPLORER_ACCOUNT_URL}${accountId}`} target="_blank" rel="noreferrer"><ExternalLink className="h-4 w-4" /> View on explorer</a>
        </DropdownItem>
        <DropdownItem onSelect={() => { void disconnect(); }}>
          <LogOut className="h-4 w-4" /> Disconnect
        </DropdownItem>
      </DropdownContent>
    </DropdownMenu>
  );
}

export function Nav() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const active = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/80 backdrop-blur-xl">
      <div className="container-wide grid h-16 grid-cols-[1fr_auto_1fr] items-center gap-4">
        <Logo />
        <nav aria-label="Main" className="hidden items-center gap-0.5 rounded-full border border-border bg-surface/70 p-1.5 lg:flex">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} aria-current={active(l.href) ? "page" : undefined}
              className={cn("rounded-full px-6 py-2 text-sm font-medium text-muted transition-colors hover:text-text", active(l.href) && "bg-text text-background hover:text-background")}>
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="col-start-3 flex items-center justify-end gap-1.5">
          <div className="hidden items-center gap-1.5 lg:flex">
            <ThemeToggle />
            <Button asChild variant="ghost" className="h-9 rounded-full"><Link href="/publish"><Plus className="h-4 w-4" aria-hidden /> Publish</Link></Button>
            <WalletButton />
          </div>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open menu"><Menu className="h-5 w-5" /></Button>
            </DialogTrigger>
            <DialogContent side="right" title="Menu">
              <nav aria-label="Mobile" className="flex flex-col gap-1">
                {LINKS.map((l) => (
                  <Link key={l.href} href={l.href} onClick={() => setOpen(false)} className={cn("rounded-md px-3 py-3 text-sm font-medium hover:bg-surface-2", active(l.href) && "bg-surface-2")}>{l.label}</Link>
                ))}
                <Link href="/publish" onClick={() => setOpen(false)} className="rounded-md px-3 py-3 text-sm font-medium hover:bg-surface-2">Publish</Link>
              </nav>
              <div className="mt-6 flex items-center gap-2"><WalletButton onDone={() => setOpen(false)} /><ThemeToggle /></div>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </header>
  );
}
