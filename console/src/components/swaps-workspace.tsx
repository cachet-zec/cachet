"use client";

import { useEffect, useState } from "react";

import { SeedCard } from "@/components/seed-card";
import { SwapBoard } from "@/components/swap-board";
import { SwapPanel } from "@/components/swap-panel";
import { useBrowserWallet } from "@/lib/browser-wallet";

/**
 * The swaps page: the public board, and under it everything needed to
 * trade, so nobody has to find the swap form at the end of another page.
 * `?take=<offer id>` loads an offer, `?want=<asset id>` starts an offer
 * asking for that asset (the asset page links here with it).
 */
export function SwapsWorkspace() {
  const { seedSaved, issuer, warm } = useBrowserWallet();
  const ready = issuer !== null && seedSaved;
  const [takeId, setTakeId] = useState<string | null>(null);
  const [wantId, setWantId] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const take = params.get("take")?.toLowerCase() ?? null;
    const want = params.get("want")?.toLowerCase() ?? null;
    if (take && /^[0-9a-f]{32}$/.test(take)) setTakeId(take);
    if (want && /^[0-9a-f]{64}$/.test(want)) setWantId(want);
  }, []);

  // Compile the engine while the visitor reads the board.
  useEffect(() => warm(), [warm]);

  const take = (id: string) => {
    setTakeId(id);
    window.history.replaceState(null, "", `/swaps?take=${id}#trade`);
    document.getElementById("trade")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div className="flex flex-col gap-12">
      <SwapBoard onTake={take} takingId={takeId} />

      <section id="trade" className="scroll-mt-8" aria-labelledby="trade-title">
        <h2
          id="trade-title"
          className="font-display text-3xl font-medium leading-tight text-neutral-50"
        >
          Trade
        </h2>
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-neutral-400">
          Your seed holds what you trade. It stays in this page&apos;s memory, the same one the mint
          page uses, and is gone on reload.
        </p>
        <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-start">
          <SeedCard
            title="1 · Your wallet"
            savedNote="It holds what you trade: lose it and those units are gone."
          />
          {ready ? (
            <SwapPanel takeId={takeId} wantId={wantId} />
          ) : (
            <div
              data-testid="swap-needs-wallet"
              className="rounded-[3px] border border-dashed border-line-strong px-5 py-6 text-sm leading-relaxed text-neutral-400"
            >
              <p className="text-base text-neutral-200">2 · Make or take an offer</p>
              <p className="mt-1.5">
                {takeId
                  ? "Open your wallet to take this offer: generate a seed, or enter the one holding the asset the offer asks for."
                  : "Open your wallet first: generate a seed, or enter the one that holds your assets. Mint some on the mint page if you have none."}
              </p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
