"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function NavLinks() {
  const pathname = usePathname();
  // Asset detail pages belong to the console/registry world; issuer pages
  // have their own tab.
  const consoleActive = pathname.startsWith("/console") || pathname.startsWith("/assets");
  const issuersActive = pathname.startsWith("/issuers");
  const mintActive = pathname.startsWith("/mint");

  // py-2.5: the text is 21px tall, a finger needs about twice that.
  const linkClass = (active: boolean) =>
    active
      ? "py-2.5 text-accent underline decoration-accent decoration-1 underline-offset-[7px]"
      : "py-2.5 text-neutral-400 transition hover:text-accent";

  return (
    <nav className="font-data flex items-center gap-6 text-sm">
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
