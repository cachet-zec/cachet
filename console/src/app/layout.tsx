import type { Metadata } from "next";
import { Fraunces, IBM_Plex_Mono, Inter } from "next/font/google";
import Link from "next/link";

import { CopyButton } from "@/components/copy-button";
import { NavLinks } from "@/components/nav-links";
import { SnapshotKey } from "@/components/snapshot-key";
import { SealMark } from "@/components/seal-mark";
import { SITE_URL } from "@/lib/site";

/** Shielded unified address for donations — balances stay shielded, as everything here. */
const DONATION_ADDRESS =
  "u1rkcc55ajpuvwxlml7rnk9lx9gu54hzzyzr356n7czrtral9p2zdcw5sm3htj9pvrl2mzx036qkejt7pkjk90kvedk6x9nghdqxv892w4wqdtxmagxsj8pynu9pr9al540dx4jg9saekeea5dmafaa09fqvcdgptxffre68uxdsu674u8";

import { Providers } from "./providers";

import "./globals.css";

const display = Fraunces({
  subsets: ["latin"],
  variable: "--font-display",
  style: ["normal", "italic"],
  axes: ["opsz"],
});
const sans = Inter({ subsets: ["latin"], variable: "--font-sans" });
const mono = IBM_Plex_Mono({
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
      "Issuance console & verifiable registry for Zcash Shielded Assets. Private balances, public supplies, metadata sealed on-chain.",
    siteName: "Cachet",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Cachet · shielded asset issuance on Zcash",
    description:
      "Issuance console & verifiable registry for Zcash Shielded Assets. Private balances, public supplies, metadata sealed on-chain.",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body className="min-h-screen antialiased">
        <Providers>
          <div className="mx-auto flex min-h-screen max-w-5xl flex-col px-6">
            <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-5">
              <Link href="/" className="flex items-center gap-2.5">
                <SealMark />
                <span className="font-display text-xl font-semibold tracking-tight text-neutral-100">
                  Cachet
                </span>
                <span className="font-data mt-0.5 hidden text-[10px] uppercase tracking-[0.2em] text-[#e8b23a]/80 sm:inline">
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
                  <p className="mt-3 max-w-xs text-[13px] leading-relaxed text-neutral-500">
                    Issuance console &amp; verifiable registry for Zcash Shielded Assets. Your keys
                    never leave your browser.
                  </p>
                  <p className="font-data mt-4 text-[10px] uppercase tracking-[0.2em] text-[#e8b23a]/70">
                    Testnet · no mainnet claims
                  </p>
                  <p className="font-data mt-4 flex items-center gap-2 text-[11px] text-neutral-500">
                    <span>
                      Support the project · <span className="text-neutral-400">zcash</span>{" "}
                      {DONATION_ADDRESS.slice(0, 8)}…
                    </span>
                    <CopyButton value={DONATION_ADDRESS} />
                  </p>
                </div>

                {/* Explore */}
                <div>
                  <h3 className="font-data text-[10px] uppercase tracking-[0.24em] text-neutral-500">
                    Explore
                  </h3>
                  <ul className="mt-3 flex flex-col gap-2 text-[13px]">
                    <li>
                      <Link
                        href="/console"
                        className="text-neutral-400 transition hover:text-[#e8b23a]"
                      >
                        Registry &amp; console
                      </Link>
                    </li>
                    <li>
                      <Link
                        href="/mint"
                        className="text-neutral-400 transition hover:text-[#e8b23a]"
                      >
                        Mint in your browser
                      </Link>
                    </li>
                    <li>
                      <Link
                        href="/issuers"
                        className="text-neutral-400 transition hover:text-[#e8b23a]"
                      >
                        Issuers &amp; collections
                      </Link>
                    </li>
                    <li>
                      <a
                        href="https://x.com/Cachet_zec"
                        target="_blank"
                        rel="noreferrer"
                        className="text-neutral-400 transition hover:text-[#e8b23a]"
                      >
                        @Cachet_zec on X
                      </a>
                    </li>
                    <li>
                      <a
                        href="https://github.com/cachet-zec/cachet"
                        target="_blank"
                        rel="noreferrer"
                        className="text-neutral-400 transition hover:text-[#e8b23a]"
                      >
                        Cachet on GitHub
                      </a>
                    </li>
                  </ul>
                </div>

                {/* Verify */}
                <div>
                  <h3 className="font-data text-[10px] uppercase tracking-[0.24em] text-neutral-500">
                    Verify
                  </h3>
                  <ul className="mt-3 flex flex-col gap-2 text-[13px]">
                    <li>
                      <a
                        href="/cachet-whitepaper.pdf"
                        target="_blank"
                        rel="noreferrer"
                        className="text-neutral-400 transition hover:text-[#e8b23a]"
                      >
                        Working paper
                      </a>
                    </li>
                    <li>
                      <a
                        href={`${process.env.NEXT_PUBLIC_CACHET_API_URL ?? "http://localhost:8080"}/api/docs`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-neutral-400 transition hover:text-[#e8b23a]"
                      >
                        API reference
                      </a>
                    </li>
                    <li>
                      <Link
                        href="/continuity"
                        className="text-neutral-400 transition hover:text-[#e8b23a]"
                      >
                        If this instance disappears
                      </Link>
                    </li>
                    <li className="text-neutral-400">
                      <SnapshotKey />
                    </li>
                  </ul>
                </div>
              </div>

              {/* Signature line, ledger-style */}
              <div className="mt-10 border-t border-white/[0.05] pt-4">
                <div className="font-data flex flex-wrap items-center justify-between gap-x-6 gap-y-1.5 text-[10px] uppercase tracking-[0.16em] text-neutral-600">
                  <span>Cachet</span>
                  <span>No telemetry · no tracking · MIT</span>
                </div>
              </div>
            </footer>
          </div>
        </Providers>
      </body>
    </html>
  );
}
