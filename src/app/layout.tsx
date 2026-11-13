import type { Metadata } from "next";
import { Geist, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { THEME_INIT_SCRIPT } from "@/lib/theme";
import { Providers } from "@/components/layout/providers";
import { Nav } from "@/components/layout/nav";
import { Footer } from "@/components/layout/footer";

const sans = Geist({ variable: "--font-sans-stack", subsets: ["latin"] });
const mono = JetBrains_Mono({ variable: "--font-mono-stack", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "ConDex",
  description: "Borrow trading insights from AI conversations. The creator is paid only if the trade executes.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} /></head>
      <body className="min-h-screen font-sans">
        <Providers>
          <Nav />
          <main>{children}</main>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
