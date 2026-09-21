"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { AssetName } from "@/components/asset-name";
import { CopyButton } from "@/components/copy-button";
import { AssetRowsSkeleton, Bone } from "@/components/skeleton";
import { api, apiBaseUrl } from "@/lib/api";
import { fetchAssetPage } from "@/lib/asset-pages";
import { rowIndex, stamp } from "@/lib/ui";

const PAGE_SIZE = 10;

const pagerButton =
  "rounded-[2px] border border-line-strong px-3 py-1.5 text-sm text-neutral-200 transition " +
  "hover:border-accent/60 hover:text-accent disabled:opacity-40";

/**
 * Every asset minted under one issuance key — the chain-level notion of a
 * collection, and the only provenance statement the chain itself makes.
 */
export function IssuerAssets({ issuer }: { issuer: string }) {
  const [page, setPage] = useState(0);
  const { data, error, isPending } = useQuery({
    queryKey: ["assets", "issuer", issuer, page],
    queryFn: () => fetchAssetPage({ issuer, limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });
  // The figures cover every asset of the key, not the page in view: the
  // registry already sums them per issuer.
  const collections = useQuery({
    queryKey: ["collections"],
    queryFn: async () => {
      const { data, error } = await api.GET("/api/v1/collections");
      if (error) throw new Error(error.detail);
      return data;
    },
  });
  const figures = collections.data?.find((collection) => collection.issuer === issuer);

  const total = data?.total ?? 0;
  const sealed = figures?.finalized_count ?? 0;
  const supply = figures?.total_supply ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageItems = data?.items ?? [];

  return (
    <div>
      <Link
        href="/issuers"
        className="font-data text-sm text-neutral-400 transition hover:text-accent"
      >
        ← All issuers
      </Link>

      <h1 className="font-display mt-6 text-4xl font-medium leading-[1.08] text-neutral-50 sm:text-5xl">
        Issuer
      </h1>
      <div className="mt-4 flex items-start gap-3">
        <span className="font-data break-all text-sm leading-relaxed text-neutral-200">
          {issuer}
        </span>
        <CopyButton value={issuer} />
      </div>
      <p className="mt-4 max-w-2xl text-base leading-relaxed text-neutral-400">
        The issuance validating key (ZIP 227). Assets listed here provably share an issuer, the one
        provenance fact the chain itself states. It says nothing about who the issuer is in the real
        world.
      </p>

      {isPending && (
        <>
          <div role="status" aria-label="Loading" className="mt-8 grid grid-cols-2 sm:grid-cols-3">
            {[0, 1, 2].map((figure) => (
              <div key={figure} className="py-5 pr-4">
                <Bone className="h-3.5 w-24" />
                <Bone className="mt-3 h-8 w-20" />
              </div>
            ))}
          </div>
          <AssetRowsSkeleton rows={PAGE_SIZE} thumb="h-11 w-11" className="mt-8" />
        </>
      )}
      {error && <p className="mt-8 text-sm text-red-400">{error.message}</p>}

      {data && (
        <>
          {/* Two figures side by side on a phone, the long one on its own line. */}
          <dl className="mt-8 grid grid-cols-2 sm:grid-cols-3">
            {[
              ["Assets", total.toLocaleString("en-US")],
              ["Sealed", sealed.toLocaleString("en-US")],
              ["Circulating supply", supply.toLocaleString("en-US")],
            ].map(([figureLabel, value]) => (
              <div
                key={figureLabel}
                className="border-line py-5 pr-4 max-sm:last:col-span-2 max-sm:last:border-t max-sm:even:border-l max-sm:even:pl-5 sm:[&:not(:first-child)]:border-l sm:[&:not(:first-child)]:pl-8"
              >
                <dt className="font-data text-sm text-neutral-400">{figureLabel}</dt>
                <dd className="font-display mt-1.5 text-3xl font-medium leading-none tabular-nums text-neutral-50 [overflow-wrap:anywhere] sm:text-4xl">
                  {value}
                </dd>
              </div>
            ))}
          </dl>

          {total === 0 && (
            <p className="mt-8 text-base text-neutral-400">
              No assets from this issuer on the indexed chain.
            </p>
          )}

          {total > 0 && (
            <div className="mt-8 flex flex-col">
              {pageItems.map((asset, index) => (
                <Link
                  key={asset.asset_id}
                  href={`/assets/${asset.asset_id}`}
                  className="group flex items-center gap-4 border-b border-line px-1 py-3.5 transition last:border-b-0 hover:bg-white/[0.025]"
                >
                  <span className={rowIndex}>
                    {String(currentPage * PAGE_SIZE + index + 1).padStart(2, "0")}
                  </span>
                  {asset.image_path ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={apiBaseUrl + asset.image_path}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      className="h-11 w-11 shrink-0 border border-line-strong bg-ground object-cover"
                    />
                  ) : (
                    <span className="font-data flex h-11 w-11 shrink-0 items-center justify-center border border-line text-[13px] text-neutral-500">
                      {asset.asset_id.slice(0, 2)}
                    </span>
                  )}
                  <div className="flex min-w-0 flex-1 items-baseline justify-between gap-3">
                    <AssetName
                      name={asset.display_name}
                      source={asset.name_source}
                      assetId={asset.asset_id}
                    />
                    <span className="flex shrink-0 items-center gap-3">
                      {asset.finalized && <span className={stamp}>sealed</span>}
                      <span className="font-data text-sm text-accent">
                        {asset.total_supply.toLocaleString("en-US")}
                      </span>
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}

          {pageCount > 1 && (
            <div className="mt-5 flex items-center justify-between">
              <button
                className={pagerButton}
                onClick={() => setPage(currentPage - 1)}
                disabled={currentPage === 0}
              >
                ← Previous
              </button>
              <span className="font-data text-[13px] text-neutral-500">
                page {currentPage + 1} of {pageCount}
              </span>
              <button
                className={pagerButton}
                onClick={() => setPage(currentPage + 1)}
                disabled={currentPage >= pageCount - 1}
              >
                Next →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
