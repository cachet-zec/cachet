"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { api, problemMessage } from "@/lib/api";
import { ghostButton } from "@/lib/ui";

/** Time left before an offer comes down, in plain words. */
function remaining(expiresAt: number): string {
  const seconds = expiresAt - Math.floor(Date.now() / 1000);
  if (seconds <= 0) return "expiring";
  const hours = Math.floor(seconds / 3600);
  return hours >= 1 ? `${hours} h left` : `${Math.max(1, Math.floor(seconds / 60))} min left`;
}

/**
 * The public swap board: every open offer, with the names this registry
 * knows for its assets. Taking one loads it into the trade panel below;
 * the swap itself is built, proved and signed in the taker's browser.
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
  // Names from the whole listing, one request for every visitor.
  const names = useQuery({
    queryKey: ["assets", "names"],
    queryFn: async () => {
      const { data } = await api.GET("/api/v1/assets");
      return Object.fromEntries((data ?? []).map((a) => [a.asset_id, a.display_name ?? ""]));
    },
    staleTime: 60_000,
  });
  const nameOf = (assetId: string) => (
    <Link
      href={`/assets/${assetId}`}
      className="text-neutral-100 transition hover:text-accent"
      title={assetId}
    >
      {names.data?.[assetId] || `${assetId.slice(0, 12)}…`}
    </Link>
  );

  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="font-display text-4xl font-medium leading-[1.08] text-neutral-50 sm:text-5xl">
          Swaps
        </h1>
        <p className="mt-3 max-w-prose text-base leading-relaxed text-neutral-300">
          Open offers to trade one asset for another. Each trade is one shielded transaction: both
          payments land together or not at all, and nobody holds anything in between. Keys never
          leave each person&apos;s browser.
        </p>
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-neutral-500">
          Testnet only. These assets have no value, and the chain can be reset at any time.
        </p>
        <a href="#trade" className={`${ghostButton} mt-4 inline-block`}>
          Make an offer
        </a>
      </header>

      {offers.isPending && <div className="h-24 motion-safe:animate-pulse bg-surface" />}
      {offers.isError && <p className="text-sm text-red-400">{offers.error.message}</p>}
      {offers.data && offers.data.length === 0 && (
        <p className="text-base text-neutral-400">No open offer right now.</p>
      )}
      {offers.data && offers.data.length > 0 && (
        <ul data-testid="swap-board">
          {offers.data.map((offer) => (
            <li
              key={offer.id}
              data-testid={`swap-offer-${offer.id}`}
              aria-current={takingId === offer.id ? "true" : undefined}
              className={`flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line py-4 last:border-b-0 ${
                takingId === offer.id ? "-mx-3 rounded-[3px] bg-accent/[0.06] px-3" : ""
              }`}
            >
              <p className="min-w-0 flex-1 basis-72 text-base text-neutral-300">
                <span className="font-display text-xl tabular-nums text-neutral-50">
                  {offer.give_amount.toLocaleString("en-US")}
                </span>{" "}
                {nameOf(offer.give_asset)}
                <span className="mx-2 text-neutral-500">for</span>
                <span className="font-display text-xl tabular-nums text-neutral-50">
                  {offer.want_amount.toLocaleString("en-US")}
                </span>{" "}
                {nameOf(offer.want_asset)}
              </p>
              <span className="font-data text-[13px] text-neutral-500">
                {remaining(offer.expires_at)}
              </span>
              <button
                type="button"
                data-testid="swap-take-link"
                className={ghostButton}
                onClick={() => onTake(offer.id)}
              >
                {takingId === offer.id ? "Taking" : "Take"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
