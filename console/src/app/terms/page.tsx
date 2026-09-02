import type { Metadata } from "next";
import Link from "next/link";

import { card, cardTitle, ghostButton } from "@/lib/ui";

export const metadata: Metadata = {
  title: "Terms · Cachet",
  description:
    "What this instance is, what may not be uploaded to it, what its operator does about abuse, and how to reach them. Short, because there is little to agree to.",
};

const CONTACT = "cachet_zec@proton.me";
const PRIVACY_URL = "https://github.com/cachet-zec/cachet/blob/main/docs/PRIVACY.md";
const SECURITY_URL = "https://github.com/cachet-zec/cachet/blob/main/SECURITY.md";

/**
 * The terms of this public instance. Not a contract of sale (nothing is
 * sold) and not legal advice: a plain statement of what the operator
 * hosts, refuses, and does about it - written before it is needed, so a
 * removal is the application of a rule rather than an argument.
 */
export default function TermsPage() {
  return (
    <div className="mx-auto max-w-3xl py-10">
      <p className="font-data text-[11px] uppercase tracking-[0.24em] text-[#e8b23a]">Terms</p>
      <h1 className="font-display mt-3 text-4xl font-semibold tracking-tight text-neutral-50">
        Terms and content policy
      </h1>
      <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-neutral-400">
        Cachet holds no accounts and sells nothing, so there is little to agree to. What follows is
        what this instance is, what may not be put on it, what its operator does about abuse, and
        how to reach them. Using cachetzec.com means accepting these few points.
      </p>

      <section className={`${card} mt-8`}>
        <h2 className={cardTitle}>01 · What this is</h2>
        <p className="mt-3 text-sm leading-relaxed text-neutral-300">
          A free, non-custodial tool on a public Zcash test network. Assets minted here have no
          monetary value, can disappear when the test network is reset, and are not an investment, a
          security, or a promise of anything on mainnet. Nothing here is financial advice. The
          software is published under the MIT licence and provided as is, without warranty of any
          kind; the operator may change or stop this instance at any time, and the{" "}
          <Link
            href="/continuity"
            className="text-[#e8b23a]/90 underline decoration-[#e8b23a]/30 underline-offset-4 transition hover:text-[#e8b23a]"
          >
            continuity page
          </Link>{" "}
          says what survives if it does.
        </p>
      </section>

      <section className={`${card} mt-4`}>
        <h2 className={cardTitle}>02 · What you may not upload</h2>
        <p className="mt-3 text-sm leading-relaxed text-neutral-300">
          Names, descriptions and images you seal into an asset are public and hosted by this
          instance. Do not upload content that is illegal where you or the operator are; sexual
          content involving minors; content that incites violence or harasses a person; content that
          infringes someone else&apos;s rights (trademarks, copyrighted works, private data); or
          anything designed to harm a reader&apos;s machine. You are responsible for what you mint
          and for holding the rights to it.
        </p>
      </section>

      <section className={`${card} mt-4`}>
        <h2 className={cardTitle}>03 · What the operator does about it</h2>
        <p className="mt-3 text-sm leading-relaxed text-neutral-300">
          The operator may withhold content from this instance without notice: an asset&apos;s
          bundle, a whole issuer, or a resolved description. For content that must not be kept at
          all, the bytes are deleted from this instance&apos;s storage. Moderation here is
          availability only: the chain record is never altered, the on-chain commitment stays
          exactly as the minter made it, and any other registry remains free to serve the identical
          content. A registry can withhold; it can never lie.
        </p>
      </section>

      <section className={`${card} mt-4`}>
        <h2 className={cardTitle}>04 · Privacy</h2>
        <p className="mt-3 text-sm leading-relaxed text-neutral-300">
          No accounts, no cookies, no analytics, no third-party requests from your browser. The
          server does not log client addresses. What you upload is public by construction, and
          relayed mints are announced (asset id and transaction id only) to the operator. The full,
          verifiable policy is{" "}
          <a
            href={PRIVACY_URL}
            className="text-[#e8b23a]/90 underline decoration-[#e8b23a]/30 underline-offset-4 transition hover:text-[#e8b23a]"
          >
            PRIVACY.md in the repository
          </a>
          .
        </p>
      </section>

      <section className={`${card} mt-4`}>
        <h2 className={cardTitle}>05 · Reporting content, and reaching the operator</h2>
        <p className="mt-3 text-sm leading-relaxed text-neutral-300">
          To report illegal content, a rights infringement, or anything you believe should not be
          served here, write to{" "}
          <a
            href={`mailto:${CONTACT}`}
            className="font-data text-[#e8b23a]/90 underline decoration-[#e8b23a]/30 underline-offset-4 transition hover:text-[#e8b23a]"
          >
            {CONTACT}
          </a>{" "}
          with the asset id and what is wrong with it. Reports are read and acted on within a few
          days; where the law requires it, sooner. Security issues follow the process in{" "}
          <a
            href={SECURITY_URL}
            className="text-[#e8b23a]/90 underline decoration-[#e8b23a]/30 underline-offset-4 transition hover:text-[#e8b23a]"
          >
            SECURITY.md
          </a>
          .
        </p>
      </section>

      <div className="mt-8 flex flex-wrap gap-3">
        <Link href="/console" className={ghostButton}>
          Browse the registry
        </Link>
        <Link href="/continuity" className={ghostButton}>
          Continuity
        </Link>
      </div>
    </div>
  );
}
