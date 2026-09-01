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

  const linkClass = (active: boolean) =>
    active
      ? "border-b border-[#e8b23a] pb-0.5 text-[#e8b23a]"
      : "text-neutral-400 transition hover:text-[#e8b23a]";

  return (
    <nav className="font-data flex items-center gap-6 text-[13px]">
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
        href="https://x.com/Cachet_zec"
        target="_blank"
        rel="noreferrer"
        aria-label="Cachet on X"
        className="text-neutral-400 transition hover:text-[#e8b23a]"
      >
        X
      </a>
      <a
        href="https://github.com/cachet-zec"
        target="_blank"
        rel="noreferrer"
        aria-label="Cachet on GitHub"
        className="text-neutral-400 transition hover:text-[#e8b23a]"
      >
        GitHub
      </a>
    </nav>
  );
}
