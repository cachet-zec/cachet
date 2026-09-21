"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { AssetName } from "@/components/asset-name";
import { AssetRowsSkeleton } from "@/components/skeleton";
import { apiBaseUrl } from "@/lib/api";
import { fetchKeptPage } from "@/lib/kept";
import { ghostButton } from "@/lib/ui";

const PAGE_SIZE = 8;

/**
 * Sealed content this registry kept for assets the chain no longer
 * carries. Each row leads to the asset's page, which offers to mint it
 * again. Says so plainly when there is nothing to list.
 */
export function KeptList() {
  const [page, setPage] = useState(0);
  const { data, error, isPending } = useQuery({
    queryKey: ["kept", "page", page],
    queryFn: () => fetchKeptPage(PAGE_SIZE, page * PAGE_SIZE),
    placeholderData: keepPreviousData,
  });

  if (isPending) return <AssetRowsSkeleton rows={3} index={false} className="mt-4" />;
  if (error) return <p className="mt-4 text-sm text-red-400">{error.message}</p>;
  if (data.total === 0) {
    return (
      <p data-testid="kept-empty" className="mt-4 text-sm text-neutral-400">
        Nothing right now: every asset this registry holds content for is on the chain it follows.
      </p>
    );
  }
  const pageCount = Math.ceil(data.total / PAGE_SIZE);
  if (page >= pageCount) setPage(pageCount - 1);

  return (
    <div data-testid="kept-list" className="mt-4">
      <p className="font-data text-[13px] text-neutral-500">
        {data.total.toLocaleString("en-US")} kept
      </p>
      <div className="mt-2 flex flex-col">
        {data.items.map((asset) => (
          <Link
            key={asset.asset_id}
            href={`/assets/${asset.asset_id}`}
            className="group flex items-center gap-3.5 border-b border-line py-3 transition last:border-b-0 hover:bg-white/[0.025]"
          >
            {asset.image_path ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={apiBaseUrl + asset.image_path}
                alt=""
                loading="lazy"
                decoding="async"
                className="h-9 w-9 shrink-0 rounded-sm object-cover"
              />
            ) : (
              <span className="font-data flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border border-white/10 text-[13px] text-neutral-600">
                {asset.asset_id.slice(0, 2)}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <AssetName
                name={asset.display_name}
                source={asset.name_source}
                assetId={asset.asset_id}
              />
              <p className="mt-0.5 truncate font-data text-[13px] text-neutral-600">
                {asset.asset_id}
              </p>
            </div>
          </Link>
        ))}
      </div>
      {pageCount > 1 && (
        <div className="mt-4 flex items-center justify-between">
          <button
            className={`${ghostButton} px-3 py-1.5 text-[13px]`}
            onClick={() => setPage(page - 1)}
            disabled={page === 0}
          >
            ← Previous
          </button>
          <span className="font-data text-[13px] text-neutral-500">
            page {page + 1} of {pageCount}
          </span>
          <button
            className={`${ghostButton} px-3 py-1.5 text-[13px]`}
            onClick={() => setPage(page + 1)}
            disabled={page >= pageCount - 1}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
