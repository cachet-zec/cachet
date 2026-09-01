import type { Metadata } from "next";
import Link from "next/link";

import { SnapshotKey } from "@/components/snapshot-key";
import { card, cardTitle, ghostButton } from "@/lib/ui";

export const metadata: Metadata = {
  title: "Continuity · Cachet",
  description:
    "What survives if this instance disappears: the chain is the source of truth, the code is MIT and self-hostable, and every snapshot is signed and independently verifiable.",
};

/** A shell command, shown the way the console shows data. */
function Command({ children }: { children: string }) {
  return (
    <pre className="font-data mt-3 overflow-x-auto rounded-md border border-white/[0.07] bg-black/40 px-3.5 py-2.5 text-[12px] leading-relaxed text-neutral-300">
      {children}
    </pre>
  );
}

export default function ContinuityPage() {
  return (
    <div className="mx-auto max-w-3xl py-10">
      <p className="font-data text-[11px] uppercase tracking-[0.24em] text-[#e8b23a]">Continuity</p>
      <h1 className="font-display mt-3 text-4xl font-semibold tracking-tight text-neutral-50">
        If this instance disappears
      </h1>
      <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-neutral-400">
        Infrastructure that a whole ecosystem might depend on should not depend on one person
        staying available. This page is the answer to that question, stated as things you can check
        rather than promises: what would be lost, what would not, and how to take over without
        asking anyone.
      </p>

      <section className={`${card} mt-8`}>
        <h2 className={cardTitle}>01 · The chain is the source of truth</h2>
        <p className="mt-3 text-sm leading-relaxed text-neutral-300">
          Cachet is an interpretation layer over public chain data. Every asset, supply, issuer and
          event it shows is folded from blocks anyone can read, so the database is a cache: deleting
          it costs about a minute of resyncing, not a single fact. There is no ownership table, no
          private ledger, and nothing that exists only because this server says so.
        </p>
      </section>

      <section className={`${card} mt-4`}>
        <h2 className={cardTitle}>02 · Run it yourself</h2>
        <p className="mt-3 text-sm leading-relaxed text-neutral-300">
          The whole thing is MIT licensed - console, indexer, API, browser mint engine and the
          metadata specification. Self-hosting is the documented path, not an afterthought: the
          deploy script is the same file this deployment runs, and it points at nobody&apos;s
          machine by default.
        </p>
        <Command>{`git clone https://github.com/cachet-zec/cachet && cd cachet
docker compose -f infra/docker-compose.yml up -d   # chain + Postgres
pnpm install && pnpm dev                            # console + API`}</Command>
        <p className="mt-3 text-sm leading-relaxed text-neutral-300">
          A fork is not a degraded copy. It indexes the same chain, verifies the same commitments,
          and signs its own snapshots under its own key.
        </p>
      </section>

      <section className={`${card} mt-4`}>
        <h2 className={cardTitle}>03 · Mirror it, and check the mirror</h2>
        <p className="mt-3 text-sm leading-relaxed text-neutral-300">
          The registry exports itself as a deterministic snapshot - sorted, timestamp-free, so the
          same chain state always produces byte-identical bytes - sealed with an Ed25519 signature.
          A mirroring script ships in the repository. It uses only the Python standard library,
          re-derives the hash of every bundle it downloads, and exits non-zero if anything fails to
          verify.
        </p>
        <Command>{`python scripts/mirror.py                          # mirror this registry
python scripts/mirror.py --api https://your.instance --out ./mirror`}</Command>
        {/* The component labels itself, so no lead-in here: prefixing it
            would read "signs with Snapshot key <key>". */}
        <div className="font-data mt-4 text-[12px] text-neutral-400">
          <SnapshotKey />
        </div>
        <p className="mt-2 text-sm leading-relaxed text-neutral-400">
          A snapshot signed by any other key is not this registry, whatever a mirror claims. The key
          is also printed in the{" "}
          <a
            href="/cachet-whitepaper.pdf"
            className="text-[#e8b23a]/90 underline decoration-[#e8b23a]/30 underline-offset-4 transition hover:text-[#e8b23a]"
          >
            working paper
          </a>
          , which is the durable anchor: verifying a mirror should never require trusting the
          mirror.
        </p>
      </section>

      <section className={`${card} mt-4`}>
        <h2 className={cardTitle}>04 · What would actually be lost</h2>
        <p className="mt-3 text-sm leading-relaxed text-neutral-300">
          Three tables cannot be rebuilt from the chain, and saying so is more useful than claiming
          nothing would be lost:
        </p>
        <ul className="mt-3 space-y-2.5 text-sm leading-relaxed text-neutral-300">
          <li className="border-l border-white/10 pl-3.5">
            <span className="font-data text-[12px] text-neutral-400">metadata_bundles</span> - the
            descriptions and images minters sealed. The chain commits to their hash, never their
            bytes.
          </li>
          <li className="border-l border-white/10 pl-3.5">
            <span className="font-data text-[12px] text-neutral-400">asset_descriptions</span> - the
            resolution journal. Re-derivable by anyone who knows a description, since resolution is
            permissionless and verified against the chain.
          </li>
          <li className="border-l border-white/10 pl-3.5">
            <span className="font-data text-[12px] text-neutral-400">moderation_hidden</span> - what
            this operator chose to withhold. A mirror that disagrees simply does not have it.
          </li>
        </ul>
        <p className="mt-4 text-sm leading-relaxed text-neutral-300">
          What that costs is <em className="not-italic text-neutral-100">availability</em>, never
          integrity: a bundle is verified against its on-chain hash in the reader&apos;s browser, so
          the store can be lost, mirrored or replaced - but never forged. Anyone holding a mirror
          holds those bytes too, which is the point of publishing the mirroring script rather than
          describing it.
        </p>
      </section>

      <section className={`${card} mt-4`}>
        <h2 className={cardTitle}>05 · What was never here</h2>
        <p className="mt-3 text-sm leading-relaxed text-neutral-300">
          Most continuity risk comes from what a service holds hostage. Cachet holds nothing: no
          accounts, no custody at any phase, no allowlist, no ownership database, and no key that
          only the operator has. Assets are minted in the browser under the minter&apos;s own key,
          so nobody needs this instance to keep controlling what they issued - and the public node
          accepts transactions directly.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-neutral-400">
          The honest remainder: this deployment&apos;s domain and its signing key belong to its
          operator. A successor cannot inherit them, and should not - they would publish their own
          key and let readers anchor it, exactly as this one does.
        </p>
      </section>

      <div className="mt-8 flex flex-wrap gap-3">
        <Link href="/console" className={ghostButton}>
          Browse the registry
        </Link>
        <a href="/cachet-whitepaper.pdf" className={ghostButton}>
          Working paper
        </a>
      </div>
    </div>
  );
}
