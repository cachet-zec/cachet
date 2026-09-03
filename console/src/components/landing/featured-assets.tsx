"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { AssetName } from "@/components/asset-name";
import { api, apiBaseUrl } from "@/lib/api";
import { FEATURED_ASSET_IDS } from "@/lib/site";
import { rowIndex, stamp } from "@/lib/ui";

/**
 * The registry showcase: the operator's featured assets first, then the
 * newest entries whose name is actually attested, as ledger lines.
 *
 * `resolved` is asked for because most of this testnet is minted by scripts
 * under a shared demo key and carries no description at all: an unfiltered
 * showcase is five rows of hex, which says nothing about what the registry
 * does. The landing is editorial; nothing is withheld - the console lists
 * everything, and the link beside this block goes straight there.
 */
/** Rows shown on the landing. */
const FEATURED_COUNT = 5;
/** Newest attested entries fetched to fill the rows the featured list leaves. */
const FILL_LIMIT = 40;

type Row = Awaited<ReturnType<typeof fetchShowcase>>[number];

async function fetchShowcase() {
  const { data, error } = await api.GET("/api/v1/assets", {
    params: { query: { limit: FILL_LIMIT, resolved: true } },
  });
  if (error) throw new Error(error.detail);
  if (FEATURED_ASSET_IDS.length === 0) return data.slice(0, FEATURED_COUNT);

  // Featured first, in configured order. One that fell out of the newest
  // window is fetched on its own; one the API no longer serves (hidden,
  // reorganized away) is simply skipped rather than breaking the block.
  const byId = new Map(data.map((asset) => [asset.asset_id, asset]));
  const featured = await Promise.all(
    FEATURED_ASSET_IDS.map(async (id) => {
      const known = byId.get(id);
      if (known) return known;
      const single = await api.GET("/api/v1/assets/{asset_id}", {
        params: { path: { asset_id: id } },
      });
      return single.data ?? null;
    }),
  );
  const rows = featured.filter((asset) => asset !== null);
  const chosen = new Set(rows.map((asset) => asset.asset_id));
  for (const asset of data) {
    if (rows.length >= FEATURED_COUNT) break;
    if (!chosen.has(asset.asset_id)) rows.push(asset);
  }
  return rows.slice(0, FEATURED_COUNT);
}

export function FeaturedAssets() {
  // The landing shows a handful of rows: ask for a handful. Fetching the
  // whole registry here cost every visitor the full listing payload.
  const { data, error, isPending } = useQuery({
    queryKey: ["assets", "featured", "resolved", FEATURED_ASSET_IDS],
    queryFn: fetchShowcase,
    refetchInterval: 30_000,
  });

  if (isPending) {
    return (
      <div className="flex flex-col">
        {Array.from({ length: 5 }, (_, i) => (
          <div key={i} className="h-14 animate-pulse border-b border-white/[0.06]" />
        ))}
      </div>
    );
  }
  if (error) {
    return (
      <p className="border-y border-white/[0.07] py-8 text-sm text-neutral-500">
        Registry unreachable. Start the Cachet server to see live entries.
      </p>
    );
  }
  const entries: Row[] = data;
  if (entries.length === 0) {
    return (
      <p className="border-y border-white/[0.07] py-8 text-sm text-neutral-500">
        No assets on this chain yet. Open the console and mint the first one.
      </p>
    );
  }

  // The rows are a filtered subset, so number them 01..N rather than
  // counting down from a registry total they are not the tail of.
  const total = entries.length;

  return (
    <div className="border-t border-white/[0.07]">
      {entries.map((asset, index) => (
        <Link
          key={asset.asset_id}
          href={`/assets/${asset.asset_id}`}
          className="group flex items-center gap-4 border-b border-white/[0.07] py-3 pl-1 pr-2 transition hover:bg-white/[0.025]"
        >
          <span className={rowIndex}>{String(total - index).padStart(2, "0")}</span>
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
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            <AssetName
              name={asset.display_name}
              source={asset.name_source}
              assetId={asset.asset_id}
            />
            {/* Provenance carried visibly, not just by typeface: on a
                landing a reader has no way to tell a name sealed into an
                asset id from an issuer's free-text label, and the registry
                indexes both because it indexes everyone. Only unsealed
                names need the caveat, as on the asset page. */}
            {asset.name_source === "free_text" && (
              <span
                className={`${stamp} shrink-0`}
                title="Issuer-chosen free text; not a verified name"
              >
                unverified
              </span>
            )}
          </span>
          {asset.finalized && <span className={stamp}>sealed</span>}
          <span className="font-data shrink-0 text-sm text-[#e8b23a]">
            {asset.total_supply.toLocaleString("en-US")}
          </span>
          <span className="font-data shrink-0 text-neutral-600 transition group-hover:translate-x-0.5 group-hover:text-[#e8b23a]">
            →
          </span>
        </Link>
      ))}
    </div>
  );
}
