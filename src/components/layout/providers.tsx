"use client";

import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryProvider } from "@/lib/query";
import { ThemeProvider, useTheme } from "@/lib/theme";
import { WalletProvider } from "@/lib/near/connector";

function Toasts() {
  const { theme } = useTheme();
  return <Toaster position="bottom-right" theme={theme} toastOptions={{ className: "font-mono text-xs" }} />;
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
    <QueryProvider>
      <WalletProvider>
        <TooltipProvider>
          {children}
          <Toasts />
        </TooltipProvider>
      </WalletProvider>
    </QueryProvider>
    </ThemeProvider>
  );
}
