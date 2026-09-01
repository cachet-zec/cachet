"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { AssetName } from "@/components/asset-name";
import { api, apiBaseUrl } from "@/lib/api";
import { card, cardTitle, ghostButton, rowIndex, stamp, stampNotable } from "@/lib/ui";

const PAGE_SIZE = 8;

/**
 * How strongly a name is attested, best first: sealed into the asset id,
 * then an on-chain machine identifier, then an unverified issuer label,
 * then nothing at all. Ordering by this is a view preference, not
 * moderation - every asset stays listed either way.
 */
const NAME_RANK: Record<string, number> = { envelope: 0, zmd1: 1, free_text: 2 };
const rank = (source: string | null | undefined) =>
  source === null || source === undefined ? 3 : (NAME_RANK[source] ?? 3);

export function AssetList() {
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState("");
  const [attestedFirst, setAttestedFirst] = useState(true);
  const { data, error, isPending, refetch, isFetching } = useQuery({
    queryKey: ["assets"],
    queryFn: async () => {
      const { data, error } = await api.GET("/api/v1/assets");
      if (error) throw new Error(error.detail);
      return data;
    },
    refetchInterval: 15_000,
  });

  // Client-side filter over everything identifying: name, raw description,
  // asset id, issuer key.
  const needle = query.trim().toLowerCase();
  const filtered =
    data?.filter(
      (asset) =>
        needle === "" ||
        asset.display_name?.toLowerCase().includes(needle) ||
        asset.description?.toLowerCase().includes(needle) ||
        asset.asset_id.startsWith(needle) ||
        asset.issuer?.startsWith(needle),
    ) ?? [];
  // Array.sort is stable, so chain order survives inside each group.
  const ordered = attestedFirst
    ? [...filtered].sort((a, b) => rank(a.name_source) - rank(b.name_source))
    : filtered;
  const total = ordered.length;
  const unresolved = ordered.filter((asset) => !asset.name_source).length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageItems = ordered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  return (
    <section className={`${card} flex h-full flex-col`}>
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-baseline gap-2.5">
          <h2 className={cardTitle}>Registry</h2>
          {data && <span className="font-data text-[11px] text-neutral-500">({total})</span>}
          {data && unresolved > 0 && (
            <button
              data-testid="list-order"
              onClick={() => {
                setAttestedFirst(!attestedFirst);
                setPage(0);
              }}
              title={
                attestedFirst
                  ? `Assets whose name is attested are shown first. Nothing is hidden: all ${total} are listed, ${unresolved} of them without a resolved description. Click for strict chain order.`
                  : "Strictly newest first, as the chain records them. Click to bring attested names to the front."
              }
              className="font-data text-[10px] uppercase tracking-[0.14em] text-neutral-500 underline decoration-dotted decoration-neutral-700 underline-offset-4 transition hover:text-[#e8b23a]"
            >
              {attestedFirst ? "named first" : "chain order"}
            </button>
          )}
        </div>
        <button
          data-testid="list-refresh"
          className={`${ghostButton} px-3 py-1.5 text-xs`}
          onClick={() => refetch()}
          disabled={isFetching}
        >
          {isFetching ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {data && data.length > PAGE_SIZE && (
        <input
          data-testid="list-search"
          className={`mb-4 w-full rounded-md border border-white/10 bg-black/30 px-3.5 py-2 font-data text-base text-neutral-100 placeholder:text-neutral-600 outline-none transition focus:border-[#e8b23a]/60 sm:text-[13px]`}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(0);
          }}
          placeholder="Filter by name, description, asset id or issuer…"
        />
      )}

      {isPending && (
        <div className="flex flex-col gap-2.5">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="h-16 animate-pulse rounded-md bg-white/[0.04]" />
          ))}
        </div>
      )}
      {error && <p className="text-sm text-red-400">{error.message}</p>}
      {data && data.length === 0 && (
        <p className="py-10 text-center text-sm text-neutral-500">
          No assets issued yet. Be the first.
        </p>
      )}
      {data && data.length > 0 && total === 0 && (
        <p className="py-10 text-center text-sm text-neutral-500">
          Nothing matches &ldquo;{query}&rdquo;.
        </p>
      )}

      {total > 0 && (
        <div className="registry-scroll flex flex-col border-t border-white/[0.07]">
          {pageItems.map((asset, index) => (
            <Link
              key={asset.asset_id}
              href={`/assets/${asset.asset_id}`}
              data-testid={`asset-row-${asset.asset_id}`}
              className="group flex items-center gap-3.5 border-b border-white/[0.07] py-3 pl-1 pr-1.5 transition hover:bg-white/[0.025]"
            >
              {/* The ledger index counts down from the total only in chain
                  order, where that number really is the asset's position.
                  Reordered, it would claim these are the newest; number
                  them by rank instead. */}
              <span className={rowIndex}>
                {String(
                  attestedFirst
                    ? currentPage * PAGE_SIZE + index + 1
                    : total - (currentPage * PAGE_SIZE + index),
                ).padStart(2, "0")}
              </span>
              {asset.image_path ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={apiBaseUrl + asset.image_path}
                  alt=""
                  className="h-9 w-9 shrink-0 rounded-sm object-cover"
                />
              ) : (
                <span className="font-data flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border border-white/10 text-[10px] text-neutral-600">
                  {asset.asset_id.slice(0, 2)}
                </span>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <AssetName
                    name={asset.display_name}
                    source={asset.name_source}
                    assetId={asset.asset_id}
                  />
                  <span className="flex shrink-0 items-center gap-2">
                    {asset.finalized ? (
                      <span className={stamp} title="Finalized: no further units, ever">
                        sealed
                      </span>
                    ) : (
                      <span
                        className={stampNotable}
                        title="Not finalized: the issuer can still mint more units of this asset"
                      >
                        open supply
                      </span>
                    )}
                    <span className="font-data text-sm text-[#e8b23a]">
                      {asset.total_supply.toLocaleString("en-US")}
                    </span>
                  </span>
                </div>
                <p className="mt-0.5 truncate font-data text-[11px] text-neutral-600">
                  {asset.asset_id}
                </p>
              </div>
            </Link>
          ))}
        </div>
      )}

      {pageCount > 1 && (
        <div className="mt-4 flex items-center justify-between border-t border-white/5 pt-4">
          <button
            className={`${ghostButton} px-3 py-1.5 text-xs`}
            onClick={() => setPage(currentPage - 1)}
            disabled={currentPage === 0}
          >
            ← Previous
          </button>
          <span className="text-xs text-neutral-500">
            Page <span className="font-data text-neutral-300">{currentPage + 1}</span> /{" "}
            <span className="font-data">{pageCount}</span>
          </span>
          <button
            className={`${ghostButton} px-3 py-1.5 text-xs`}
            onClick={() => setPage(currentPage + 1)}
            disabled={currentPage >= pageCount - 1}
          >
            Next →
          </button>
        </div>
      )}
    </section>
  );
}
