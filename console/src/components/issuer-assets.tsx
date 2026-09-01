"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { AssetName } from "@/components/asset-name";
import { CopyButton } from "@/components/copy-button";
import { api, apiBaseUrl } from "@/lib/api";
import { card, cardTitle, ghostButton, rowIndex, stamp } from "@/lib/ui";

const PAGE_SIZE = 10;

/**
 * Every asset minted under one issuance key — the chain-level notion of a
 * collection, and the only provenance statement the chain itself makes.
 */
export function IssuerAssets({ issuer }: { issuer: string }) {
  const [page, setPage] = useState(0);
  const { data, error, isPending } = useQuery({
    queryKey: ["assets"],
    queryFn: async () => {
      const { data, error } = await api.GET("/api/v1/assets");
      if (error) throw new Error(error.detail);
      return data;
    },
  });

  const assets = data?.filter((asset) => asset.issuer === issuer) ?? [];
  const total = assets.length;
  const sealed = assets.filter((asset) => asset.finalized).length;
  const supply = assets.reduce((sum, asset) => sum + asset.total_supply, 0);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const pageItems = assets.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href="/console"
        className="font-data text-[13px] text-neutral-400 transition hover:text-[#e8b23a]"
      >
        ← Back to console
      </Link>

      <div className={`${card} mt-4`}>
        <h1 className={cardTitle}>Issuer</h1>
        <div className="mt-2 flex items-center gap-2">
          <span className="font-data break-all text-xs text-neutral-300">{issuer}</span>
          <CopyButton value={issuer} />
        </div>
        <p className="mt-3 text-xs leading-relaxed text-neutral-500">
          The issuance validating key (ZIP 227). Assets listed here provably share an issuer, the
          one provenance fact the chain itself states. It says nothing about who the issuer is in
          the real world.
        </p>

        {isPending && <div className="mt-5 h-32 animate-pulse rounded-md bg-white/[0.04]" />}
        {error && <p className="mt-5 text-sm text-red-400">{error.message}</p>}

        {data && (
          <>
            <div className="font-data mt-5 flex flex-wrap gap-x-6 gap-y-1 border-t border-white/[0.07] pt-4 text-[13px]">
              <span className="text-neutral-500">
                assets <span className="text-neutral-200">{total}</span>
              </span>
              <span className="text-neutral-500">
                sealed <span className="text-neutral-200">{sealed}</span>
              </span>
              <span className="text-neutral-500">
                circulating supply{" "}
                <span className="text-[#e8b23a]">{supply.toLocaleString("en-US")}</span>
              </span>
            </div>

            {total === 0 && (
              <p className="mt-6 text-sm text-neutral-500">
                No assets from this issuer on the indexed chain.
              </p>
            )}

            {total > 0 && (
              <div className="mt-4 flex flex-col border-t border-white/[0.07]">
                {pageItems.map((asset, index) => (
                  <Link
                    key={asset.asset_id}
                    href={`/assets/${asset.asset_id}`}
                    className="group flex items-center gap-3.5 border-b border-white/[0.07] py-3 pl-1 pr-1.5 transition hover:bg-white/[0.025]"
                  >
                    <span className={rowIndex}>
                      {String(currentPage * PAGE_SIZE + index + 1).padStart(2, "0")}
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
                    <div className="flex min-w-0 flex-1 items-baseline justify-between gap-3">
                      <AssetName
                        name={asset.display_name}
                        source={asset.name_source}
                        assetId={asset.asset_id}
                      />
                      <span className="flex shrink-0 items-center gap-2">
                        {asset.finalized && <span className={stamp}>sealed</span>}
                        <span className="font-data text-sm text-[#e8b23a]">
                          {asset.total_supply.toLocaleString("en-US")}
                        </span>
                      </span>
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
          </>
        )}
      </div>
    </div>
  );
}
