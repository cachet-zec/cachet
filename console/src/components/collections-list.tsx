"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { api } from "@/lib/api";
import { card, cardTitle } from "@/lib/ui";

/**
 * Every issuance key observed on the chain — the chain-level notion of a
 * collection. Exact public data: counts and supplies are computed, never
 * sampled.
 */
export function CollectionsList() {
  const { data, error, isPending } = useQuery({
    queryKey: ["collections"],
    queryFn: async () => {
      const { data, error } = await api.GET("/api/v1/collections");
      if (error) throw new Error(error.detail);
      return data;
    },
    refetchInterval: 30_000,
  });

  return (
    <div className="mx-auto max-w-3xl">
      <div className={card}>
        <h1 className={cardTitle}>Issuers on chain</h1>
        <p className="mt-3 max-w-xl text-xs leading-relaxed text-neutral-500">
          Assets grouped by issuance key (ZIP 227), the one provenance statement the chain itself
          makes. A key proves &ldquo;same issuer&rdquo;, nothing about who that issuer is in the
          real world.
        </p>

        {isPending && (
          <div className="mt-5 flex flex-col gap-2.5">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="h-14 animate-pulse rounded-md bg-white/[0.04]" />
            ))}
          </div>
        )}
        {error && <p className="mt-5 text-sm text-red-400">{error.message}</p>}

        {data && data.length === 0 && (
          <p className="mt-6 text-sm text-neutral-500">No issuers observed on this chain yet.</p>
        )}

        {data && data.length > 0 && (
          <div className="mt-5 flex flex-col border-t border-white/[0.07]">
            {data.map((collection, index) => (
              <Link
                key={collection.issuer}
                href={`/issuers/${collection.issuer}`}
                className="group flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-white/[0.07] py-3.5 pl-1 pr-1.5 transition hover:bg-white/[0.025]"
              >
                <span className="font-data w-7 shrink-0 text-xs text-neutral-600">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="font-data min-w-0 flex-1 truncate text-sm text-neutral-200">
                  {collection.issuer.slice(0, 20)}…
                </span>
                <span className="font-data shrink-0 text-[13px] text-neutral-500">
                  assets <span className="text-neutral-200">{collection.asset_count}</span>
                </span>
                <span className="font-data shrink-0 text-[13px] text-neutral-500">
                  sealed <span className="text-neutral-200">{collection.finalized_count}</span>
                </span>
                <span className="font-data shrink-0 text-[13px] text-neutral-500">
                  supply{" "}
                  <span className="text-[#e8b23a]">
                    {collection.total_supply.toLocaleString("en-US")}
                  </span>
                </span>
                <span className="font-data shrink-0 text-neutral-600 transition group-hover:text-[#e8b23a]">
                  →
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
