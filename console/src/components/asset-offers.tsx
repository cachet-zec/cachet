"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { api, problemMessage } from "@/lib/api";
import { ghostButton } from "@/lib/ui";

const sectionTitle = "font-display text-2xl font-medium text-neutral-100";

/**
 * The swap board, seen from one asset: the open offers that give it or
 * ask for it, and a way to ask for it. The whole board is fetched, the
 * same request for every page, so the registry does not learn which asset
 * a visitor looks at for trading.
 */
export function AssetOffers({ assetId }: { assetId: string }) {
  const offers = useQuery({
    queryKey: ["swaps"],
    queryFn: async () => {
      const { data, error } = await api.GET("/api/v1/swaps");
      if (error) throw new Error(problemMessage(error));
      return data;
    },
    refetchInterval: 30_000,
  });
  const names = useQuery({
    queryKey: ["assets", "names"],
    queryFn: async () => {
      const { data } = await api.GET("/api/v1/assets");
      return Object.fromEntries((data ?? []).map((a) => [a.asset_id, a.display_name ?? ""]));
    },
    staleTime: 60_000,
  });
  const nameOf = (id: string) =>
    id === assetId ? "this asset" : names.data?.[id] || `${id.slice(0, 12)}…`;

  const mine = (offers.data ?? []).filter(
    (offer) => offer.give_asset === assetId || offer.want_asset === assetId,
  );

  return (
    <section className="mt-14" data-testid="asset-offers">
      <h2 className={sectionTitle}>On the swap board</h2>
      {offers.isError && <p className="mt-3 text-sm text-red-400">{offers.error.message}</p>}
      {offers.data && mine.length === 0 && (
        <p className="mt-3 text-base text-neutral-400">No open offer gives or asks for it.</p>
      )}
      {mine.length > 0 && (
        <ul className="mt-3">
          {mine.map((offer) => (
            <li
              key={offer.id}
              className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line py-3.5 last:border-b-0"
            >
              <p className="min-w-0 flex-1 basis-64 text-base text-neutral-300">
                <span className="font-display text-xl tabular-nums text-neutral-50">
                  {offer.give_amount.toLocaleString("en-US")}
                </span>{" "}
                {offer.give_asset === assetId ? (
                  nameOf(offer.give_asset)
                ) : (
                  <Link
                    href={`/assets/${offer.give_asset}`}
                    className="text-neutral-100 transition hover:text-accent"
                  >
                    {nameOf(offer.give_asset)}
                  </Link>
                )}
                <span className="mx-2 text-neutral-500">for</span>
                <span className="font-display text-xl tabular-nums text-neutral-50">
                  {offer.want_amount.toLocaleString("en-US")}
                </span>{" "}
                {offer.want_asset === assetId ? (
                  nameOf(offer.want_asset)
                ) : (
                  <Link
                    href={`/assets/${offer.want_asset}`}
                    className="text-neutral-100 transition hover:text-accent"
                  >
                    {nameOf(offer.want_asset)}
                  </Link>
                )}
              </p>
              <Link href={`/swaps?take=${offer.id}#trade`} className={ghostButton}>
                Take
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Link
        href={`/swaps?want=${assetId}#trade`}
        data-testid="asset-ask-swap"
        className="mt-4 inline-block text-sm text-accent/90 underline decoration-accent/30 underline-offset-4 transition hover:text-accent"
      >
        Ask for this asset in a swap
      </Link>
    </section>
  );
}
