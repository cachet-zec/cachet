"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { api } from "@/lib/api";
import { Bone } from "@/components/skeleton";

/** One row of the issuers register: same columns as its heading. */
const columns =
  "grid items-baseline gap-x-6 gap-y-1 sm:grid-cols-[2.5rem_minmax(0,1fr)_5rem_5rem_10rem_1rem]";

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
    <div>
      <h1 className="font-display text-4xl font-medium leading-[1.08] text-neutral-50 sm:text-5xl">
        Issuers on chain
      </h1>
      <p className="mt-4 max-w-2xl text-lg leading-relaxed text-neutral-300">
        Assets grouped by issuance key (ZIP 227), the one provenance statement the chain itself
        makes. A key proves &ldquo;same issuer&rdquo;, nothing about who that issuer is in the real
        world.
      </p>

      {isPending && (
        <div role="status" aria-label="Loading" className="mt-8 flex flex-col">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="border-b border-line py-4 last:border-b-0">
              <Bone className="h-4 w-11/12 sm:w-3/5" />
              <Bone className="mt-2.5 h-3.5 w-48" />
            </div>
          ))}
        </div>
      )}
      {error && <p className="mt-8 text-sm text-red-400">{error.message}</p>}

      {data && data.length === 0 && (
        <p className="mt-8 text-base text-neutral-400">No issuers observed on this chain yet.</p>
      )}

      {data && data.length > 0 && (
        <div className="mt-8">
          <div
            className={`${columns} font-data hidden border-b border-line-strong px-1 pb-2.5 text-[13px] text-neutral-500 sm:grid`}
          >
            <span />
            <span>Issuance key</span>
            <span className="text-right">Assets</span>
            <span className="text-right">Sealed</span>
            <span className="text-right">Supply</span>
            <span />
          </div>
          {data.map((collection, index) => (
            <Link
              key={collection.issuer}
              href={`/issuers/${collection.issuer}`}
              className={`${columns} group border-b border-line px-1 py-4 transition last:border-b-0 hover:bg-white/[0.025]`}
            >
              <span className="font-data hidden text-[13px] text-neutral-600 sm:block">
                {String(index + 1).padStart(2, "0")}
              </span>
              <span
                className="font-data min-w-0 truncate text-sm text-neutral-100 transition group-hover:text-accent"
                title={collection.issuer}
              >
                {collection.issuer}
              </span>
              <span className="font-data text-sm text-neutral-200 sm:text-right">
                <span className="text-neutral-500 sm:hidden">assets </span>
                {collection.asset_count}
              </span>
              <span className="font-data text-sm text-neutral-200 sm:text-right">
                <span className="text-neutral-500 sm:hidden">sealed </span>
                {collection.finalized_count}
              </span>
              <span className="font-data text-sm text-accent sm:text-right">
                <span className="text-neutral-500 sm:hidden">supply </span>
                {collection.total_supply.toLocaleString("en-US")}
              </span>
              <span className="font-data hidden text-neutral-600 transition group-hover:text-accent sm:block">
                →
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
