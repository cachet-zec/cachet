import type { Metadata } from "next";
import Link from "next/link";

import { FeaturedAssets } from "@/components/landing/featured-assets";
import { Reveal } from "@/components/reveal";
import { LiveStats } from "@/components/landing/live-stats";
import { SealWatermark } from "@/components/seal-mark";
import { ghostButton, primaryButton } from "@/lib/ui";
import { pageMetadata } from "@/lib/seo";

export const metadata: Metadata = pageMetadata({
  title: "Cachet · shielded asset issuance on Zcash",
  path: "/",
});

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
          className="pointer-events-none absolute -left-24 -top-48 -z-10 h-[440px] w-[420px] bg-[radial-gradient(closest-side,rgba(213,154,124,0.06),transparent)] sm:-left-40 sm:w-[680px]"
        />
        <SealWatermark className="absolute -right-64 -top-72 -z-10 w-[560px] sm:w-[760px] lg:-right-[26rem]" />
        <div>
          <h1 className="font-display max-w-2xl text-5xl font-medium leading-[1.02] text-neutral-50 sm:text-7xl">
            Issue shielded assets on&nbsp;Zcash.
          </h1>
          <p className="mt-7 max-w-xl text-lg leading-relaxed text-neutral-300">
            Create an asset, issue its supply, send it or burn it, all from your browser. The supply
            is public and anyone can check it. The holders stay shielded, the name and image are
            sealed into the asset id.
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
            className="font-data text-sm text-neutral-400 transition hover:text-accent"
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
        <div className="relative pl-7">
          <span aria-hidden className="steps-thread">
            <span className="steps-thread-fill" />
          </span>
          <ol className="stagger flex flex-col">
            {steps.map((step, index) => (
              <li key={step.title} className="grid grid-cols-[auto_1fr] gap-5 py-5">
                <span className="step-num font-display pt-0.5 text-lg text-accent">
                  {index + 1}
                </span>
                <div>
                  <h3 className="font-display text-2xl font-medium text-neutral-100">
                    {step.title}
                  </h3>
                  <p className="mt-2 max-w-lg text-base leading-relaxed text-neutral-300">
                    {step.body}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </Reveal>

      {/* Honest framing: an official notice, set as ledger lines and
          stamped like a document. */}
      <Reveal className="rounded-lg border border-white/[0.08] bg-surface p-6 [background-image:linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0)_45%)] shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_1px_3px_rgba(0,0,0,0.35)] sm:p-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <h2 className="font-display text-2xl font-medium text-neutral-100">
            Read before believing
          </h2>
          <span
            aria-hidden
            className="font-data stamp-press select-none rounded-sm border border-accent/70 px-2.5 py-1 text-[13px] uppercase tracking-[0.2em] text-accent/90 outline outline-1 outline-offset-4 outline-accent/30"
          >
            testnet
          </span>
        </div>
        {/* The questions a visitor actually has, each with its answer under it. */}
        <dl className="stagger mt-6 grid gap-x-10 gap-y-6 sm:grid-cols-2">
          {[
            ["Are ZSAs on mainnet?", "Not yet, and not scheduled. It takes a network upgrade."],
            ["What does this site run on?", "The public ZSA testnet, run by QEDIT, not by Cachet."],
            [
              "What if that testnet is reset?",
              "Every asset on it is gone; it has happened once. What you sealed is kept, and your seed mints it back under the same asset id.",
            ],
            ["So what is real here?", "The proofs, the blocks and the assets: all of it."],
          ].map(([question, answer]) => (
            <div key={question}>
              <dt className="text-base font-semibold text-neutral-50">{question}</dt>
              <dd className="mt-1 text-base leading-relaxed text-neutral-300">{answer}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-7 max-w-2xl text-sm leading-relaxed text-neutral-400">
          We build as if the protocol could ship tomorrow. If it does, Cachet is ready. Every claim
          above is measured or checkable:{" "}
          <a
            href="/cachet-whitepaper.pdf"
            target="_blank"
            rel="noreferrer"
            className="text-accent underline decoration-accent/30 transition hover:decoration-accent"
          >
            read the working paper
          </a>
          .
        </p>
      </Reveal>
    </div>
  );
}
