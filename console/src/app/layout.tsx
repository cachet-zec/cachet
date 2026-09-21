import type { Metadata } from "next";
import { Bodoni_Moda, DM_Mono, Hanken_Grotesk } from "next/font/google";
import Link from "next/link";

import { NavLinks } from "@/components/nav-links";
import { RegistrySwitch } from "@/components/registry-switch";
import { SnapshotKey } from "@/components/snapshot-key";
import { SealMark } from "@/components/seal-mark";
import { SITE_URL } from "@/lib/site";

import { Providers } from "./providers";

import "./globals.css";

const display = Bodoni_Moda({
  subsets: ["latin"],
  variable: "--font-display",
  axes: ["opsz"],
});
const sans = Hanken_Grotesk({ subsets: ["latin"], variable: "--font-sans" });
const mono = DM_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "Cachet · shielded asset issuance on Zcash",
  description:
    "Mint, verify and track Zcash Shielded Assets (ZSA) with cryptographically sealed metadata. Testnet.",
  openGraph: {
    title: "Cachet · shielded asset issuance on Zcash",
    description:
      "Issuance console & verifiable registry for Zcash Shielded Assets. Private balances, public supplies, metadata sealed into the asset id. Testnet.",
    siteName: "Cachet",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Cachet · shielded asset issuance on Zcash",
    description:
      "Issuance console & verifiable registry for Zcash Shielded Assets. Private balances, public supplies, metadata sealed into the asset id. Testnet.",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body className="min-h-screen antialiased">
        <Providers>
          <div className="mx-auto flex min-h-screen max-w-5xl flex-col px-6">
            <header className="relative z-10 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-5">
              <Link href="/" className="flex items-center gap-2.5">
                <SealMark />
                <span className="font-display text-xl font-semibold tracking-tight text-neutral-100">
                  Cachet
                </span>
                <span className="font-data mt-0.5 text-[13px] uppercase tracking-[0.2em] text-accent">
                  testnet
                </span>
              </Link>
              <NavLinks />
            </header>
            {/* Ledger double rule under the header, like a totals line. */}
            <div className="thread" />
            <div className="mt-[3px] h-px bg-white/[0.05]" />
            <main className="flex-1 py-8">{children}</main>
            <footer className="border-t border-white/[0.06] pb-6 pt-10">
              <div className="grid gap-10 sm:grid-cols-[5fr_3fr_3fr]">
                {/* Brand */}
                <div>
                  <div className="flex items-center gap-3">
                    <SealMark size={30} />
                    <span className="font-display text-lg font-semibold tracking-tight text-neutral-100">
                      Cachet
                    </span>
                  </div>
                  <p className="mt-3 max-w-xs text-sm leading-relaxed text-neutral-500">
                    Issuance console &amp; verifiable registry for Zcash Shielded Assets.
                  </p>
                  <p className="font-data mt-4 text-[13px] uppercase tracking-[0.2em] text-accent">
                    Testnet only
                  </p>
                  <p className="font-data mt-4 text-[13px]">
                    <Link
                      href="/support"
                      className="text-accent/90 underline decoration-accent/30 underline-offset-4 transition hover:text-accent"
                    >
                      Support the project
                    </Link>
                  </p>
                  <RegistrySwitch />
                </div>

                {/* Explore */}
                <div>
                  <h3 className="font-data text-[13px] uppercase tracking-[0.24em] text-neutral-500">
                    Explore
                  </h3>
                  <ul className="mt-3 flex flex-col gap-2 text-sm">
                    <li>
                      <Link
                        href="/console"
                        className="text-neutral-400 transition hover:text-accent"
                      >
                        Registry &amp; console
                      </Link>
                    </li>
                    <li>
                      <Link href="/mint" className="text-neutral-400 transition hover:text-accent">
                        Mint in your browser
                      </Link>
                    </li>
                    <li>
                      <Link
                        href="/issuers"
                        className="text-neutral-400 transition hover:text-accent"
                      >
                        Issuers &amp; collections
                      </Link>
                    </li>
                    <li>
                      <a
                        href="https://x.com/Cachet_zec"
                        target="_blank"
                        rel="noreferrer"
                        className="text-neutral-400 transition hover:text-accent"
                      >
                        @Cachet_zec on X
                      </a>
                    </li>
                    <li>
                      <a
                        href="https://github.com/cachet-zec/cachet"
                        target="_blank"
                        rel="noreferrer"
                        className="text-neutral-400 transition hover:text-accent"
                      >
                        GitHub
                      </a>
                    </li>
                  </ul>
                </div>

                {/* Verify */}
                <div>
                  <h3 className="font-data text-[13px] uppercase tracking-[0.24em] text-neutral-500">
                    Verify
                  </h3>
                  <ul className="mt-3 flex flex-col gap-2 text-sm">
                    <li>
                      <a
                        href="/cachet-whitepaper.pdf"
                        target="_blank"
                        rel="noreferrer"
                        className="text-neutral-400 transition hover:text-accent"
                      >
                        Working paper
                      </a>
                    </li>
                    <li>
                      <Link
                        href="/reference"
                        className="text-neutral-400 transition hover:text-accent"
                      >
                        API reference
                      </Link>
                    </li>
                    <li>
                      <Link
                        href="/continuity"
                        className="text-neutral-400 transition hover:text-accent"
                      >
                        If this instance disappears
                      </Link>
                    </li>
                    <li>
                      <Link href="/terms" className="text-neutral-400 transition hover:text-accent">
                        Terms and content policy
                      </Link>
                    </li>
                    <li className="text-neutral-400">
                      <SnapshotKey />
                    </li>
                  </ul>
                </div>
              </div>

              {/* Signature line, ledger-style. The name is already at the top
                  of the footer: only what it promises is said here. */}
              <p className="font-data mt-10 text-[13px] uppercase tracking-[0.16em] text-neutral-600">
                No telemetry · no tracking · MIT
              </p>
            </footer>
          </div>
        </Providers>
      </body>
    </html>
  );
}
