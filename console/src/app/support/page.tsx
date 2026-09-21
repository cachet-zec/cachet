import type { Metadata } from "next";
import Link from "next/link";

import { CopyButton } from "@/components/copy-button";
import { DONATION_ADDRESS } from "@/lib/site";
import { ghostButton } from "@/lib/ui";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Support · Cachet",
  description:
    "Cachet is free and has no fees, accounts or tracking. It runs on donations, shielded: the address, and what a donation does not buy.",
  path: "/support",
});

const REPO_URL = "https://github.com/cachet-zec/cachet";

const linkClass =
  "text-accent/90 underline decoration-accent/30 underline-offset-4 transition hover:text-accent";

/**
 * How to fund the project. Says what a donation does not buy, and says
 * loudly that this is mainnet ZEC on a testnet site.
 */
export default function SupportPage() {
  return (
    <div className="rise">
      <h1 className="font-display text-4xl font-medium leading-[1.08] text-neutral-50 sm:text-5xl">
        Support the project
      </h1>
      <p className="mt-4 max-w-2xl text-lg leading-relaxed text-neutral-300">
        Cachet charges nothing: no fee on a mint, no account, no token of its own, no ads and no
        tracking. It is open source under the MIT license and it runs on donations.
      </p>

      <div className="mt-10 max-w-2xl">
        <div className="min-w-0">
          <section>
            <h2 className="font-display text-2xl font-medium text-neutral-100">
              Send shielded ZEC
            </h2>
            {/* The one place on this site where real funds are involved. */}
            <p className="mt-3 max-w-prose rounded-[3px] border border-accent/40 px-4 py-3 text-base leading-relaxed text-neutral-200">
              This is a <span className="text-accent">mainnet</span> address. Everything else on
              this site is testnet; a donation is real ZEC. Do not send testnet coins to it.
            </p>
            <div className="mt-5 flex items-start gap-3 rounded-[3px] bg-surface px-4 py-3.5">
              <span
                data-testid="donation-address"
                className="font-data min-w-0 flex-1 break-all text-sm leading-relaxed text-neutral-100"
              >
                {DONATION_ADDRESS}
              </span>
              <CopyButton value={DONATION_ADDRESS} />
            </div>
          </section>

          <section className="mt-12">
            <h2 className="font-display text-2xl font-medium text-neutral-100">
              What it does not buy
            </h2>
            <p className="mt-3 max-w-prose text-base leading-relaxed text-neutral-300">
              Anything. No perks, no priority, no badge, no say in what the registry lists. The site
              works the same for everyone, and a shielded donation cannot even be attributed. If
              that is not a good enough reason to give, it is a good enough reason not to.
            </p>
          </section>

          <section className="mt-12">
            <h2 className="font-display text-2xl font-medium text-neutral-100">
              Other ways to help
            </h2>
            <p className="mt-3 max-w-prose text-base leading-relaxed text-neutral-300">
              Run a mirror, so the registry does not depend on one server: the{" "}
              <Link href="/continuity" className={linkClass}>
                continuity page
              </Link>{" "}
              has the commands. Report what breaks, or send a fix, on{" "}
              <a href={REPO_URL} target="_blank" rel="noreferrer" className={linkClass}>
                GitHub
              </a>
              . Mint something and tell us what was unclear.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link href="/mint" className={ghostButton}>
                Mint in your browser
              </Link>
              <Link href="/continuity" className={ghostButton}>
                Continuity
              </Link>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
