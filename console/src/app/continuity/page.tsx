import type { Metadata } from "next";
import Link from "next/link";

import { KeptList } from "@/components/kept-list";
import { SnapshotKey } from "@/components/snapshot-key";
import { card, cardTitle, ghostButton } from "@/lib/ui";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Continuity · Cachet",
  description:
    "What survives if this instance disappears: the chain is the source of truth, the code is MIT and self-hostable, and every snapshot is signed and independently verifiable.",
  path: "/continuity",
});

/** A shell command, shown the way the console shows data. */
function Command({ children }: { children: string }) {
  return (
    <pre className="font-data mt-3 overflow-x-auto rounded-md border border-white/[0.07] bg-black/40 px-3.5 py-2.5 text-[13px] leading-relaxed text-neutral-300">
      {children}
    </pre>
  );
}

export default function ContinuityPage() {
  return (
    <div className="mx-auto max-w-3xl py-10">
      <h1 className="font-display text-5xl font-medium text-neutral-50">
        If this instance disappears
      </h1>
      <p className="mt-4 max-w-2xl text-[15px] leading-relaxed text-neutral-400">
        Infrastructure that a whole ecosystem might depend on should not depend on one person
        staying available. This page is the answer to that question, stated as things you can check
        rather than promises: what would be lost, what would not, and how to take over without
        asking anyone.
      </p>

      <section className={`${card} mt-8`}>
        <h2 className={cardTitle}>The chain is the source of truth</h2>
        <p className="mt-3 text-sm leading-relaxed text-neutral-300">
          Cachet is an interpretation layer over public chain data. Every asset, supply, issuer and
          event it shows is folded from blocks anyone can read, so the database is a cache: deleting
          it costs about a minute of resyncing, not a single fact. There is no ownership table, no
          private ledger, and nothing that exists only because this server says so.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-neutral-300">
          The same rule holds when the chain itself changes under the registry. The public ZSA
          testnet is run by QEDIT, the team building ZSAs, not by this registry. A test network can
          be reset by its operators and start again from block zero; it happened on 10 September
          2026. Everything issued before then exists only on the abandoned chain, so this registry
          followed the node, dropped its index and re-indexed from the start within a minute, on its
          own. What was never on the chain stays: the sealed bundles are still served, and an asset
          id is derived from the issuance key and the sealed description, never assigned by a chain.
          A re-mint under the same seed with the same name, text and image, byte for byte, is
          therefore the same asset id again, on the new chain; change any of them and it is a
          different asset. One trap: an image over about 180 KB is re-encoded by the browser before
          it is sealed, and another browser may not produce the same bytes. Re-mint with the sealed
          image this registry serves, which is kept as is, rather than with the original file. A
          registry that kept showing assets its node can no longer see would be lying.
        </p>
      </section>

      <section className={`${card} mt-4`}>
        <h2 className={cardTitle}>Kept from before a reset</h2>
        <p className="mt-3 text-sm leading-relaxed text-neutral-300">
          Sealed content this registry still holds for assets the chain no longer carries. Open one
          to mint it again: the page loads the sealed name, text and image as they are, and tells
          you whether your seed gives the same asset id before anything is signed.
        </p>
        <KeptList />
      </section>

      <section className={`${card} mt-4`}>
        <h2 className={cardTitle}>Run it yourself</h2>
        <p className="mt-3 text-sm leading-relaxed text-neutral-300">
          The whole thing is MIT licensed - console, indexer, API, browser mint engine and the
          metadata specification. Self-hosting is the documented path, not an afterthought: the
          deploy script is the same file this deployment runs, and it points at nobody&apos;s
          machine by default.
        </p>
        <Command>{`git clone https://github.com/cachet-zec/cachet && cd cachet
docker compose -f infra/docker-compose.yml up -d   # chain + Postgres
pnpm install
cargo run --manifest-path server/Cargo.toml --bin cachet-server   # API
pnpm dev                                                          # console`}</Command>
        <p className="mt-3 text-sm leading-relaxed text-neutral-300">
          A fork is not a degraded copy. It indexes the same chain, verifies the same commitments,
          and signs its own snapshots under its own key.
        </p>
      </section>

      <section className={`${card} mt-4`}>
        <h2 className={cardTitle}>Mirror it, and check the mirror</h2>
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
        <div className="font-data mt-4 text-[13px] text-neutral-400">
          <SnapshotKey />
        </div>
        <p className="mt-2 text-sm leading-relaxed text-neutral-400">
          A snapshot signed by any other key is not this registry, whatever a mirror claims. The key
          is also printed in the{" "}
          <a
            href="/cachet-whitepaper.pdf"
            className="text-accent/90 underline decoration-accent/30 underline-offset-4 transition hover:text-accent"
          >
            working paper
          </a>
          , which is the durable anchor: verifying a mirror should never require trusting the
          mirror.
        </p>
      </section>

      <section className={`${card} mt-4`}>
        <h2 className={cardTitle}>Give the copy back</h2>
        <p className="mt-3 text-sm leading-relaxed text-neutral-300">
          A mirror is not an archive to look at: it rebuilds an instance. The second script sends a
          mirror to any running instance through the two routes that are open to everyone, and the
          instance checks every item against the chain itself. It needs no database access and no
          one&apos;s permission, this operator&apos;s included.
        </p>
        <Command>{`python scripts/restore.py --to https://api.new.instance --mirror ./mirror`}</Command>
      </section>

      <section className={`${card} mt-4`}>
        <h2 className={cardTitle}>Check the code this site runs</h2>
        <p className="mt-3 text-sm leading-relaxed text-neutral-300">
          A browser mint keeps the seed in the page, so what matters is the code the page runs. The
          mint worker and the wasm engines are plain files committed to the repository, with their
          hashes in{" "}
          <span className="font-data text-[13px] text-neutral-400">engine-manifest.json</span>. From
          a checkout of the release you expect, one command downloads them from a live site and
          compares every byte:
        </p>
        <Command>{`python scripts/verify-site.py --site https://cachetzec.com`}</Command>
        <p className="mt-3 text-sm leading-relaxed text-neutral-400">
          It covers the engine, where keys are derived and transactions signed. It does not cover
          the application code around it, which is not built reproducibly yet. Running the console
          from source covers both.
        </p>
      </section>

      <section className={`${card} mt-4`}>
        <h2 className={cardTitle}>Already addressable on IPFS</h2>
        <p className="mt-3 text-sm leading-relaxed text-neutral-300">
          The hash sealed into an asset is, byte for byte, the body of an IPFS content id: a CIDv1
          for a raw block is a four-byte prefix followed by the SHA-256 of the data. So every bundle
          has an IPFS address that anyone can compute from its sealed description. Nothing had to be
          uploaded for that to be true, and nobody needs this registry&apos;s permission to host a
          bundle under it.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-neutral-300">
          The mirroring script can publish what it verified to an IPFS node you run. It stores each
          bundle as a single block and refuses any whose address differs from the one derived from
          the sealed hash.
        </p>
        <Command>{`python scripts/mirror.py --ipfs                   # mirror, then pin to your local IPFS node`}</Command>
        <p className="mt-3 text-sm leading-relaxed text-neutral-400">
          IPFS keeps data only while someone pins it, so this is a way for more people to hold the
          bytes, not a promise that they are held. This site does not read from IPFS gateways: a
          gateway is a third party that would see who is looking at what.
        </p>
      </section>

      <section className={`${card} mt-4`}>
        <h2 className={cardTitle}>What would actually be lost</h2>
        <p className="mt-3 text-sm leading-relaxed text-neutral-300">
          Three tables cannot be rebuilt from the chain, and saying so is more useful than claiming
          nothing would be lost:
        </p>
        <ul className="mt-3 space-y-2.5 text-sm leading-relaxed text-neutral-300">
          <li className="border-l border-white/10 pl-3.5">
            <span className="font-data text-[13px] text-neutral-400">metadata_bundles</span> - the
            descriptions and images minters sealed. The chain commits to their hash, never their
            bytes.
          </li>
          <li className="border-l border-white/10 pl-3.5">
            <span className="font-data text-[13px] text-neutral-400">asset_descriptions</span> - the
            resolution journal. Re-derivable by anyone who knows a description, since resolution is
            permissionless and verified against the chain.
          </li>
          <li className="border-l border-white/10 pl-3.5">
            <span className="font-data text-[13px] text-neutral-400">moderation_hidden</span> - what
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
        <h2 className={cardTitle}>What was never here</h2>
        <p className="mt-3 text-sm leading-relaxed text-neutral-300">
          Most continuity risk comes from what a service holds hostage. Cachet holds nothing: no
          accounts, no custody at any phase, no allowlist, no ownership database, and no key that
          only the operator has. Assets are minted in the browser under the minter&apos;s own key,
          so nobody needs this instance to keep controlling what they issued. The mint page can hand
          over the signed transaction instead of relaying it, and any instance&apos;s relay, or any
          tool that assembles a block, can land it.
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
