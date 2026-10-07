"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";

import { AssetName } from "@/components/asset-name";
import { AssetRowsSkeleton, Bone } from "@/components/skeleton";
import { apiBaseUrl } from "@/lib/api";
import { type AssetSummary, fetchAssetPage } from "@/lib/asset-pages";
import { card, cardTitle, ghostButton, rowIndex, stamp, stampNotable } from "@/lib/ui";

/** Rows in the list; the gallery fills a 3 x 3 grid. */
const PAGE_SIZE = { list: 8, gallery: 9 } as const;

type Order = "named_first" | "active" | "newest";

/**
 * Orders are a view preference, never moderation: every asset stays listed
 * whichever is picked. "Named first" ranks by how strongly a name is
 * attested (sealed into the asset id, then an issuer label, then nothing);
 * "active" by the latest public event (issuance, burn or seal; shielded
 * transfers are invisible and never count); "newest" is chain order.
 */
const ORDERS: { value: Order; title: string; hint: string }[] = [
  {
    value: "named_first",
    title: "named first",
    hint: "Assets whose name is attested come first. Nothing is hidden.",
  },
  {
    value: "active",
    title: "active",
    hint: "Latest issuance, burn or seal first. Shielded transfers are invisible and never count.",
  },
  { value: "newest", title: "newest", hint: "Strictly newest first, as the chain records them." },
];

/** The registry's own image route for a sealed image, or a monogram. */
function Thumb({ asset, className }: { asset: AssetSummary; className: string }) {
  return asset.image_path ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={apiBaseUrl + asset.image_path}
      alt=""
      loading="lazy"
      decoding="async"
      className={`${className} object-cover`}
    />
  ) : (
    <span
      className={`${className} font-data flex items-center justify-center border border-white/10 text-[13px] text-neutral-600`}
    >
      {asset.asset_id.slice(0, 2)}
    </span>
  );
}

export function AssetList() {
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState("");
  const [order, setOrder] = useState<Order>("named_first");
  const [layout, setLayout] = useState<"list" | "gallery">("list");
  const pageSize = PAGE_SIZE[layout];
  // Filters compose with the search: supply state, and whether an asset
  // carries an attested name at all (most script mints on this testnet
  // do not).
  const [supplyFilter, setSupplyFilter] = useState<"all" | "sealed" | "open">("all");
  const [namedOnly, setNamedOnly] = useState(false);
  // The registry is asked once the typing pauses, not on every key.
  const [needle, setNeedle] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setNeedle(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  // The registry filters, orders and counts; this list holds one page.
  const view = {
    q: needle || undefined,
    supply: supplyFilter === "all" ? undefined : supplyFilter,
    resolved: namedOnly || undefined,
    order: order === "newest" ? undefined : order,
  };
  const { data, error, isPending, refetch, isFetching, isPlaceholderData } = useQuery({
    queryKey: ["assets", "page", view, page, pageSize],
    queryFn: () => fetchAssetPage({ ...view, limit: pageSize, offset: page * pageSize }),
    refetchInterval: 15_000,
    // The rows on screen stay until the next page arrives.
    placeholderData: keepPreviousData,
  });

  // With a filter on, a row's number is its rank in the result, never a
  // position in the chain.
  const filtered = needle !== "" || supplyFilter !== "all" || namedOnly;
  const total = data?.total ?? 0;
  const unresolved = data?.unresolved ?? 0;
  const registrySize = data?.registry ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const pageItems = data?.items ?? [];
  // The list shrank under the page being looked at: step back onto it.
  useEffect(() => {
    if (data && page > currentPage) setPage(currentPage);
  }, [data, page, currentPage]);

  return (
    <section className={`${card} flex h-full flex-col`}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-2.5">
          <h2 className={cardTitle}>Registry</h2>
          {data && <span className="font-data text-[13px] text-neutral-500">({total})</span>}
        </div>
        <div className="flex items-center gap-2.5">
          {registrySize > 0 && (
            <div
              role="radiogroup"
              aria-label="Layout"
              className="flex overflow-hidden rounded-md border border-white/10 bg-black/30"
            >
              {(["list", "gallery"] as const).map((value, index) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={layout === value}
                  data-testid={`list-layout-${value}`}
                  onClick={() => {
                    setLayout(value);
                    setPage(0);
                  }}
                  className={`font-data whitespace-nowrap px-3 py-1.5 text-[13px] transition ${index > 0 ? "border-l border-white/[0.07]" : ""} ${
                    layout === value
                      ? "bg-accent/[0.08] text-accent"
                      : "text-neutral-400 hover:bg-white/[0.03] hover:text-neutral-200"
                  }`}
                >
                  {value}
                </button>
              ))}
            </div>
          )}
          <button
            data-testid="list-refresh"
            className={`${ghostButton} px-3 py-1.5 text-[13px]`}
            onClick={() => refetch()}
            disabled={isFetching}
          >
            {isFetching ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {registrySize > pageSize && (
        <input
          data-testid="list-search"
          className={`mb-4 w-full rounded-md border border-white/10 bg-black/30 px-3.5 py-2 font-data text-base text-neutral-100 placeholder:text-neutral-600 outline-none transition focus:border-accent/60 sm:text-sm`}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(0);
          }}
          placeholder="Filter by name, description, asset id or issuer…"
        />
      )}

      {registrySize > 1 && (
        <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
          <div
            role="radiogroup"
            aria-label="Order"
            data-testid="list-order"
            className="flex overflow-hidden rounded-md border border-white/10 bg-black/30"
          >
            {ORDERS.map(({ value, title, hint }, index) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={order === value}
                title={hint}
                onClick={() => {
                  setOrder(value);
                  setPage(0);
                }}
                className={`font-data whitespace-nowrap px-3 py-1.5 text-[13px] transition ${index > 0 ? "border-l border-white/[0.07]" : ""} ${
                  order === value
                    ? "bg-accent/[0.08] text-accent"
                    : "text-neutral-400 hover:bg-white/[0.03] hover:text-neutral-200"
                }`}
              >
                {title}
              </button>
            ))}
          </div>
          {order === "named_first" && unresolved > 0 && (
            <span className="font-data text-[13px] text-neutral-600">
              {unresolved} without a known description, listed last
            </span>
          )}
        </div>
      )}

      {registrySize > pageSize && (
        <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
          <div
            role="radiogroup"
            aria-label="Supply state"
            data-testid="list-supply-filter"
            className="flex overflow-hidden rounded-md border border-white/10 bg-black/30"
          >
            {(
              [
                ["all", "all"],
                ["sealed", "sealed"],
                ["open", "open supply"],
              ] as const
            ).map(([value, title], index) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={supplyFilter === value}
                onClick={() => {
                  setSupplyFilter(value);
                  setPage(0);
                }}
                className={`font-data whitespace-nowrap px-3 py-1.5 text-[13px] transition ${index > 0 ? "border-l border-white/[0.07]" : ""} ${
                  supplyFilter === value
                    ? "bg-accent/[0.08] text-accent"
                    : "text-neutral-400 hover:bg-white/[0.03] hover:text-neutral-200"
                }`}
              >
                {title}
              </button>
            ))}
          </div>
          <label className="font-data flex cursor-pointer items-center gap-2 text-[13px] text-neutral-400">
            <input
              type="checkbox"
              data-testid="list-named-only"
              checked={namedOnly}
              onChange={(event) => {
                setNamedOnly(event.target.checked);
                setPage(0);
              }}
              className="accent-accent"
            />
            named assets only
          </label>
        </div>
      )}

      {isPending && (
        <>
          {/* the search and the filters, then a page of rows */}
          <Bone className="mb-4 h-[38px] w-full rounded-md" />
          <div className="mb-4 flex items-center gap-4">
            <Bone className="h-[30px] w-52 rounded-md" />
            <Bone className="h-4 w-36" />
          </div>
          <AssetRowsSkeleton rows={pageSize} />
          <div className="mt-5 flex items-center justify-between">
            <Bone className="h-[34px] w-24 rounded-md" />
            <Bone className="h-3.5 w-20" />
            <Bone className="h-[34px] w-20 rounded-md" />
          </div>
        </>
      )}
      {error && <p className="text-sm text-red-400">{error.message}</p>}
      {data && registrySize === 0 && (
        <p className="py-10 text-center text-sm text-neutral-500">
          No assets issued yet. Be the first.
        </p>
      )}
      {registrySize > 0 && total === 0 && (
        <p className="py-10 text-center text-sm text-neutral-500">
          {needle ? (
            <>Nothing matches &ldquo;{query}&rdquo; with these filters.</>
          ) : (
            "Nothing matches these filters."
          )}
        </p>
      )}

      {total > 0 && layout === "gallery" && (
        <ul
          data-testid="asset-gallery"
          className={`grid grid-cols-2 gap-3 transition-opacity duration-200 sm:grid-cols-3 ${
            isPlaceholderData ? "opacity-50" : ""
          }`}
          aria-busy={isPlaceholderData}
        >
          {pageItems.map((asset) => (
            <li key={asset.asset_id} className="min-w-0">
              <Link
                href={`/assets/${asset.asset_id}`}
                data-testid={`asset-tile-${asset.asset_id}`}
                className="group flex h-full flex-col rounded-[3px] border border-line p-2 transition hover:border-accent/50 hover:bg-white/[0.025]"
              >
                <Thumb asset={asset} className="aspect-square w-full rounded-sm" />
                <span className="mt-2 flex min-w-0 px-0.5">
                  <AssetName
                    name={asset.display_name}
                    source={asset.name_source}
                    assetId={asset.asset_id}
                  />
                </span>
                <span className="mt-1 flex items-center justify-between gap-2 px-0.5 pb-0.5">
                  <span className="font-data text-[13px] text-accent">
                    {asset.total_supply.toLocaleString("en-US")}
                  </span>
                  <span className="font-data text-[13px] text-neutral-500">
                    {asset.finalized ? "sealed" : "open"}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {total > 0 && layout === "list" && (
        <div
          className={`registry-scroll flex flex-col transition-opacity duration-200 ${
            isPlaceholderData ? "opacity-50" : ""
          }`}
          aria-busy={isPlaceholderData}
        >
          {pageItems.map((asset, index) => (
            <Link
              key={asset.asset_id}
              href={`/assets/${asset.asset_id}`}
              data-testid={`asset-row-${asset.asset_id}`}
              className="group flex items-center gap-3.5 border-b border-line py-3 pl-1 pr-1.5 transition last:border-b-0 hover:bg-white/[0.025]"
            >
              {/* The ledger index counts down from the total only in chain
                  order, where that number really is the asset's position.
                  Reordered, it would claim these are the newest; number
                  them by rank instead. */}
              <span className={rowIndex}>
                {String(
                  order !== "newest" || filtered
                    ? currentPage * pageSize + index + 1
                    : total - (currentPage * pageSize + index),
                ).padStart(2, "0")}
              </span>
              <Thumb asset={asset} className="h-9 w-9 shrink-0 rounded-sm" />
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
                    <span className="font-data text-sm text-accent">
                      {asset.total_supply.toLocaleString("en-US")}
                    </span>
                  </span>
                </div>
                <p className="mt-0.5 flex gap-3 font-data text-[13px] text-neutral-600">
                  <span className="min-w-0 truncate">{asset.asset_id}</span>
                  {order === "active" && asset.last_height != null && (
                    <span className="shrink-0" title="Height of the latest issuance, burn or seal">
                      block {asset.last_height.toLocaleString("en-US")}
                    </span>
                  )}
                </p>
              </div>
            </Link>
          ))}
        </div>
      )}

      {pageCount > 1 && (
        <div className="mt-5 flex items-center justify-between">
          <button
            className={`${ghostButton} px-3 py-1.5 text-[13px]`}
            onClick={() => setPage(currentPage - 1)}
            disabled={currentPage === 0}
          >
            ← Previous
          </button>
          <span className="text-[13px] text-neutral-500">
            Page <span className="font-data text-neutral-300">{currentPage + 1}</span> /{" "}
            <span className="font-data">{pageCount}</span>
          </span>
          <button
            className={`${ghostButton} px-3 py-1.5 text-[13px]`}
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
