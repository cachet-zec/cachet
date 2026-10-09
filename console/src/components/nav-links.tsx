"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { useSwapMaker } from "@/lib/swap-maker";

export function NavLinks() {
  const pathname = usePathname();
  // An offer of this tab is live, or was just filled: say so on every page.
  const { listing, done, unseen } = useSwapMaker();
  const offerLive = listing !== null && !done;
  const offerFilled = done && unseen > 0;
  // Asset detail pages belong to the console/registry world; issuer pages
  // have their own tab.
  const consoleActive = pathname.startsWith("/console") || pathname.startsWith("/assets");
  const issuersActive = pathname.startsWith("/issuers");
  const mintActive = pathname.startsWith("/mint");
  const swapsActive = pathname.startsWith("/swaps");

  // py-2.5: the text is 21px tall, a finger needs about twice that.
  const linkClass = (active: boolean) =>
    active
      ? "py-2.5 text-accent underline decoration-accent decoration-1 underline-offset-[7px]"
      : "py-2.5 text-neutral-400 transition hover:text-accent";

  return (
    <nav className="font-data flex items-center gap-4 text-sm sm:gap-6">
      <Link
        href="/console"
        aria-current={consoleActive ? "page" : undefined}
        className={linkClass(consoleActive)}
      >
        Console
      </Link>
      <Link
        href="/mint"
        aria-current={mintActive ? "page" : undefined}
        className={linkClass(mintActive)}
      >
        Mint
      </Link>
      <Link
        href={offerLive || offerFilled ? "/swaps#trade" : "/swaps"}
        aria-current={swapsActive ? "page" : undefined}
        className={`${linkClass(swapsActive)} relative`}
        title={
          offerLive
            ? "Your offer is live: this tab answers takers"
            : offerFilled
              ? "Your offer was filled"
              : undefined
        }
      >
        Swaps
        {(offerLive || offerFilled) && (
          <span
            data-testid="nav-offer-live"
            className={`absolute -right-2.5 top-2 h-2 w-2 rounded-full ${
              offerLive ? "bg-accent motion-safe:animate-pulse" : "bg-emerald-300"
            }`}
          >
            <span className="sr-only">{offerLive ? " (offer live)" : " (offer filled)"}</span>
          </span>
        )}
      </Link>
      <Link
        href="/issuers"
        aria-current={issuersActive ? "page" : undefined}
        className={linkClass(issuersActive)}
      >
        Issuers
      </Link>
      <a
        href="https://github.com/cachet-zec/cachet"
        target="_blank"
        rel="noreferrer"
        aria-label="Cachet on GitHub"
        className="py-2.5 text-neutral-400 transition hover:text-accent"
      >
        GitHub
      </a>
    </nav>
  );
}
