"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { AssetThumb, AssetTitle, type ListedAsset, shortId } from "@/components/asset-chip";
import { api, problemMessage } from "@/lib/api";
import { ghostButton, primaryButton } from "@/lib/ui";

/** Time left before an offer comes down, in plain words. */
function remaining(expiresAt: number): string {
  const seconds = expiresAt - Math.floor(Date.now() / 1000);
  if (seconds <= 0) return "expiring";
  const hours = Math.floor(seconds / 3600);
  return hours >= 1 ? `${hours} h left` : `${Math.max(1, Math.floor(seconds / 60))} min left`;
}

/** Units asked per unit offered, short. */
export function rate(give: number, want: number): string {
  const value = want / give;
  return value >= 100 ? value.toFixed(0) : value >= 1 ? value.toFixed(2) : value.toPrecision(3);
}

/** The registry's whole listing, by asset id: one request for every visitor. */
export function useListedAssets() {
  return useQuery({
    queryKey: ["assets", "listed"],
    queryFn: async () => {
      const { data } = await api.GET("/api/v1/assets");
      return new Map((data ?? []).map((asset) => [asset.asset_id, asset as ListedAsset]));
    },
    staleTime: 60_000,
  });
}

/** One side of an offer: how much of which asset. */
export function OfferSide({
  amount,
  id,
  asset,
  compact = false,
}: {
  amount: number;
  id: string;
  asset?: ListedAsset;
  /** Leave the supply state out, where the room is short. */
  compact?: boolean;
}) {
  return (
    <Link href={`/assets/${id}`} className="group flex min-w-0 items-center gap-3" title={id}>
      <AssetThumb asset={asset} id={id} className="h-11 w-11" />
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="font-display text-2xl tabular-nums text-neutral-50">
            {amount.toLocaleString("en-US")}
          </span>
          <span className="truncate text-sm transition group-hover:text-accent">
            <AssetTitle asset={asset} />
          </span>
        </span>
        <span className="font-data truncate text-[12px] text-neutral-500">
          {shortId(id)}
          {asset && !compact ? (asset.finalized ? " · sealed supply" : " · open supply") : ""}
        </span>
      </span>
    </Link>
  );
}

const columns = "sm:grid-cols-[minmax(0,1fr)_4.5rem_minmax(0,1fr)_6.5rem_5.5rem]";

/**
 * The public swap board: every open offer, each side shown with what this
 * registry knows of its asset. Taking one loads it into the trade panel
 * below; the swap itself is built, proved and signed in the taker's browser.
 */
export function SwapBoard({
  onTake,
  takingId,
}: {
  onTake: (id: string) => void;
  /** The offer the trade panel holds, if any. */
  takingId: string | null;
}) {
  const offers = useQuery({
    queryKey: ["swaps"],
    queryFn: async () => {
      const { data, error } = await api.GET("/api/v1/swaps");
      if (error) throw new Error(problemMessage(error));
      return data;
    },
    refetchInterval: 15_000,
  });
  const listed = useListedAssets();
  const open = offers.data?.length ?? 0;

  return (
    <div className="flex flex-col gap-7">
      <header className="flex flex-wrap items-end justify-between gap-x-10 gap-y-5">
        <div className="max-w-2xl">
          <p className="font-data text-[13px] uppercase tracking-[0.18em] text-accent">
            Swap board
          </p>
          <h1 className="font-display mt-2 text-4xl font-medium leading-[1.08] text-neutral-50 sm:text-5xl">
            Swaps
          </h1>
          <p className="mt-3 text-base leading-relaxed text-neutral-300">
            Trade one asset for another in a single shielded transaction. Both sides land together
            or not at all, and the keys never leave each person&apos;s browser.
          </p>
        </div>
        <div className="flex items-center gap-4">
          {offers.data && (
            <span className="font-data text-[13px] text-neutral-500">
              {open} open {open === 1 ? "offer" : "offers"}
            </span>
          )}
          <a href="#trade" className={`${primaryButton} !px-5 !py-2.5 !text-sm`}>
            Make an offer
          </a>
        </div>
      </header>

      <section aria-label="Open offers" className="border-t border-line-strong">
        <div
          className={`font-data hidden gap-x-5 border-b border-line py-2.5 text-[12px] uppercase tracking-[0.14em] text-neutral-500 sm:grid ${columns}`}
        >
          <span>Offered</span>
          <span className="text-center">Rate</span>
          <span>Asked</span>
          <span>Expires</span>
          <span />
        </div>

        {offers.isPending && <div className="mt-3 h-20 motion-safe:animate-pulse bg-surface" />}
        {offers.isError && <p className="py-6 text-sm text-red-400">{offers.error.message}</p>}
        {offers.data && open === 0 && (
          <div className="py-10 text-center">
            <p className="text-base text-neutral-300">No open offer right now.</p>
            <p className="mt-1.5 text-sm text-neutral-500">
              Post the first one below: it shows here for anyone to take.
            </p>
          </div>
        )}
        {offers.data && open > 0 && (
          <ul data-testid="swap-board">
            {offers.data.map((offer) => {
              const taking = takingId === offer.id;
              return (
                <li
                  key={offer.id}
                  data-testid={`swap-offer-${offer.id}`}
                  aria-current={taking ? "true" : undefined}
                  className={`grid grid-cols-1 items-center gap-x-5 gap-y-3 border-b border-line py-4 ${columns} ${
                    taking ? "bg-accent/[0.05] shadow-[inset_2px_0_0_var(--color-accent)]" : ""
                  }`}
                >
                  <OfferSide
                    amount={offer.give_amount}
                    id={offer.give_asset}
                    asset={listed.data?.get(offer.give_asset)}
                  />
                  <span
                    className="flex items-center gap-2 text-accent sm:flex-col sm:gap-0.5"
                    title={`${rate(offer.give_amount, offer.want_amount)} asked per unit offered`}
                  >
                    <span aria-hidden className="text-lg leading-none">
                      →
                    </span>
                    <span className="font-data text-[12px] text-neutral-500">
                      1 : {rate(offer.give_amount, offer.want_amount)}
                    </span>
                  </span>
                  <OfferSide
                    amount={offer.want_amount}
                    id={offer.want_asset}
                    asset={listed.data?.get(offer.want_asset)}
                  />
                  {/* One row on a phone; two cells beside the offer on a wider screen. */}
                  <div className="flex items-center justify-between gap-4 sm:contents">
                    <span className="font-data text-[13px] text-neutral-500">
                      {remaining(offer.expires_at)}
                    </span>
                    <button
                      type="button"
                      data-testid="swap-take-link"
                      className={`${ghostButton} !px-4 !py-2 !text-sm sm:justify-self-end`}
                      onClick={() => onTake(offer.id)}
                    >
                      {taking ? "Taking" : "Take"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <p className="font-data text-[12px] uppercase tracking-[0.14em] text-neutral-600">
        Testnet only · test assets have no value · no fee · the chain can be reset
      </p>
    </div>
  );
}
