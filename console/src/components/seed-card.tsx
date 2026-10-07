"use client";

import { useState } from "react";

import { CopyButton } from "@/components/copy-button";
import { useBrowserWallet } from "@/lib/browser-wallet";
import { card, cardTitle, ghostButton, input } from "@/lib/ui";

const quietLink =
  "text-[13px] text-neutral-500 underline decoration-white/20 underline-offset-2 transition hover:text-neutral-300";

/**
 * The seed, for the pages that use keys. Generated or pasted here, held in
 * the browser wallet's memory only; the same phrase serves minting and
 * swapping, so it carries from one page to the other until a reload.
 */
export function SeedCard({
  title,
  savedNote,
  busy = false,
  className = "",
}: {
  title: string;
  /** What the visitor confirms by ticking "saved". */
  savedNote: string;
  busy?: boolean;
  className?: string;
}) {
  const { seed, setSeed, seedSaved, setSeedSaved, issuer, generateSeed } = useBrowserWallet();
  // Masked by default: a phrase on screen is on every screenshot and
  // stream. Copy works while masked, so revealing is never required.
  const [revealed, setRevealed] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);

  const generate = () => {
    setRevealed(false);
    void generateSeed();
  };

  return (
    <section className={`${card} ${className}`}>
      <h2 className={`${cardTitle} mb-3`}>{title}</h2>
      {/* Empty state: two clearly separate paths. */}
      {!seed && !pasteOpen && (
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className={ghostButton} onClick={generate} disabled={busy}>
            Generate a new seed
          </button>
          <button
            type="button"
            className="text-sm text-neutral-300 underline decoration-white/20 underline-offset-2 transition hover:text-neutral-300"
            onClick={() => setPasteOpen(true)}
          >
            I already have one
          </button>
        </div>
      )}

      {/* Generated: the phrase is a credential being issued, not a form —
      a numbered, read-only word grid. */}
      {seed !== "" && !pasteOpen && (
        <>
          <ol
            data-testid="mint-seed-grid"
            // As many columns as the card has room for: four on the mint page,
            // three beside the swap form.
            className="grid grid-cols-[repeat(auto-fill,minmax(6.25rem,1fr))] gap-x-4 gap-y-1.5 rounded-md border border-white/10 bg-black/30 p-3.5 shadow-[inset_0_1px_2px_rgba(0,0,0,0.35)]"
          >
            {seed
              .trim()
              .split(/\s+/)
              .map((word, index) => (
                <li
                  key={`${index}-${word}`}
                  className="font-data flex items-baseline gap-1.5 text-sm text-neutral-200"
                >
                  <span className="w-4 shrink-0 text-right text-[13px] text-neutral-600">
                    {index + 1}
                  </span>
                  {/* Fixed-width mask: even word lengths stay private. */}
                  {revealed ? word : <span className="text-neutral-500">••••••</span>}
                </li>
              ))}
          </ol>
          <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <CopyButton value={seed} label="Copy phrase" />
            <button
              type="button"
              data-testid="mint-seed-reveal"
              aria-pressed={revealed}
              title="Copy works while hidden: the clipboard gets the real phrase either way."
              className={quietLink}
              onClick={() => setRevealed(!revealed)}
            >
              {revealed ? "hide words" : "show words"}
            </button>
            <button type="button" className={quietLink} onClick={generate} disabled={busy}>
              generate another
            </button>
            <button
              type="button"
              className={quietLink}
              onClick={() => {
                setSeed("");
                setSeedSaved(false);
                setPasteOpen(true);
              }}
              disabled={busy}
            >
              use my own instead
            </button>
            <span className="font-data text-[13px] uppercase tracking-[0.16em] text-accent">
              testnet identity
            </span>
          </div>
        </>
      )}

      {/* Import: the one case where typing makes sense. */}
      {pasteOpen && (
        <>
          <textarea
            data-testid="mint-seed"
            className={`${input} min-h-20 resize-y`}
            value={seed}
            onChange={(event) => {
              setSeed(event.target.value);
              setSeedSaved(false);
            }}
            placeholder="12 or 24 words…"
            spellCheck={false}
            autoFocus
          />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
            <p className="text-[13px] text-neutral-600">
              Testnet only - never paste a seed that guards real funds.
            </p>
            <button
              type="button"
              className={quietLink}
              onClick={() => {
                setPasteOpen(false);
                generate();
              }}
              disabled={busy}
            >
              generate a new one instead
            </button>
          </div>
        </>
      )}

      {seed && (issuer || !pasteOpen) && (
        <label className="mt-3 flex cursor-pointer items-start gap-2 text-[13px] leading-relaxed text-neutral-400">
          <input
            type="checkbox"
            data-testid="mint-seed-saved"
            className="mt-0.5 h-4 w-4 accent-accent"
            checked={seedSaved}
            onChange={(event) => setSeedSaved(event.target.checked)}
          />
          <span>
            I saved this phrase somewhere safe. {savedNote} This site keeps it in memory only, for
            the mint and swap pages, and forgets it on reload.
          </span>
        </label>
      )}
      {issuer && (
        <p className="font-data mt-3 break-all text-[13px] text-neutral-500">
          issuer key <span className="text-neutral-300">{issuer}</span>
        </p>
      )}
      {pasteOpen && seed !== "" && !issuer && (
        <p className="mt-3 text-[13px] text-neutral-500">Enter a valid 12 or 24-word phrase.</p>
      )}
    </section>
  );
}
