import Link from "next/link";

import { FeaturedAssets } from "@/components/landing/featured-assets";
import { Reveal } from "@/components/reveal";
import { LiveStats } from "@/components/landing/live-stats";
import { SealWatermark } from "@/components/seal-mark";
import { ghostButton, primaryButton } from "@/lib/ui";

const steps = [
  {
    title: "Mint",
    body: "Name your asset, set a supply, attach an image. Cachet builds a real v6 transaction with zero-knowledge proofs and commits it to the ZSA chain.",
  },
  {
    title: "Bind",
    body: "The metadata is hashed into the asset id itself, so the name and image are part of what the asset IS. Nobody, including us, can swap them afterwards - changing either would be a different asset. The registry stores it; the chain guarantees it.",
  },
  {
    title: "Verify",
    body: "Your browser recomputes the asset id from the description it was served - a registry can serve any description, but not one that derives the right id - then re-hashes the metadata against it. Trust the math, not the registry.",
  },
  {
    title: "Hold & spend",
    body: "Your browser downloads public blocks and finds your own notes inside them, on your machine. Nobody is asked which assets are yours - not even us: the registry serves the same bytes to every visitor and cannot tell what you hold.",
  },
];

export default function LandingPage() {
  return (
    <div className="flex flex-col gap-20 pt-6 sm:pt-12">
      {/* Hero — editorial, asymmetric, embossed with the seal */}
      <section className="rise relative grid items-start gap-10 lg:grid-cols-[7fr_4fr]">
        <div
          aria-hidden
          className="absolute -left-24 -top-48 -z-10 h-[440px] w-[420px] bg-[radial-gradient(closest-side,rgba(232,178,58,0.06),transparent)] sm:-left-40 sm:w-[680px]"
        />
        <SealWatermark className="absolute -right-52 -top-40 -z-10 hidden w-[620px] opacity-[0.05] lg:block" />
        <div>
          <p className="font-data text-[11px] uppercase tracking-[0.24em] text-[#e8b23a]">
            Issuance console &amp; verifiable registry
          </p>
          <h1 className="font-display mt-4 max-w-xl text-5xl font-semibold leading-[1.05] tracking-tight text-neutral-50 sm:text-6xl">
            Mint <em className="italic text-[#e8b23a]">shielded</em> assets on&nbsp;Zcash.
          </h1>
          <p className="mt-6 max-w-lg text-[15px] leading-relaxed text-neutral-400">
            Mint, transfer and burn shielded assets from your browser: your keys never leave the
            page, and the registry cannot even see which notes are yours. Public, auditable
            supplies; metadata sealed on-chain forever.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link href="/mint" className={primaryButton}>
              Mint in your browser
            </Link>
            <Link href="/console" className={ghostButton}>
              Browse the registry
            </Link>
          </div>
        </div>
        <div className="lg:justify-self-end lg:pt-10">
          <LiveStats />
        </div>
      </section>

      {/* Registry excerpt */}
      <Reveal>
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="font-display text-2xl font-medium text-neutral-100">The registry</h2>
          <Link
            href="/console"
            className="font-data text-[13px] text-neutral-400 transition hover:text-[#e8b23a]"
          >
            browse all →
          </Link>
        </div>
        <FeaturedAssets />
      </Reveal>

      {/* How it works — numbered editorial list */}
      <Reveal className="grid gap-10 lg:grid-cols-[4fr_7fr]">
        <h2 className="font-display text-2xl font-medium leading-snug text-neutral-100">
          Your keys.
          <br />
          Your assets. Verifiably.
        </h2>
        <ol className="stagger flex flex-col">
          {steps.map((step, index) => (
            <li
              key={step.title}
              className="grid grid-cols-[auto_1fr] gap-5 border-t border-white/[0.07] py-6 last:border-b"
            >
              <span className="font-data pt-0.5 text-sm text-[#e8b23a]">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div>
                <h3 className="font-display text-lg font-medium text-neutral-100">{step.title}</h3>
                <p className="mt-1.5 max-w-md text-sm leading-relaxed text-neutral-400">
                  {step.body}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </Reveal>

      {/* Honest framing: an official notice, set as ledger lines and
          stamped like a document. Facts, not prose. */}
      <Reveal className="rounded-lg border border-white/[0.08] bg-[#12100d] p-6 [background-image:linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0)_45%)] shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_1px_3px_rgba(0,0,0,0.35)] sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <h2 className="font-data text-[11px] uppercase tracking-[0.24em] text-neutral-500">
            Notice · read before believing
          </h2>
          <span
            aria-hidden
            className="font-data stamp-press select-none rounded-sm border border-[#e8b23a]/70 px-2.5 py-1 text-[11px] uppercase tracking-[0.2em] text-[#e8b23a]/90 outline outline-1 outline-offset-4 outline-[#e8b23a]/30"
          >
            testnet
          </span>
        </div>
        <dl className="mt-5 max-w-2xl">
          {[
            ["zsa on mainnet", "not yet; it ships with a future network upgrade"],
            ["this site runs on", "the public ZSA testnet, live since August 2026"],
            ["proofs, blocks, assets", "real"],
          ].map(([fact, value]) => (
            <div
              key={fact}
              className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-0.5 border-b border-white/[0.06] py-2.5 last:border-b-0"
            >
              <dt className="font-data text-[11px] uppercase tracking-[0.16em] text-neutral-500">
                {fact}
              </dt>
              <dd className="font-data text-right text-[13px] text-neutral-200">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-5 max-w-2xl text-sm leading-relaxed text-neutral-400">
          We build as if the protocol ships tomorrow. When it does, Cachet is ready. Every claim
          above is measured or checkable:{" "}
          <a
            href="/cachet-whitepaper.pdf"
            target="_blank"
            rel="noreferrer"
            className="text-[#e8b23a] underline decoration-[#e8b23a]/30 transition hover:decoration-[#e8b23a]"
          >
            read the working paper
          </a>
          .
        </p>
      </Reveal>
    </div>
  );
}
