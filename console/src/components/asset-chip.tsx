"use client";

import { apiBaseUrl } from "@/lib/api";

/** What the registry's listing says of an asset. */
export type ListedAsset = {
  asset_id: string;
  display_name?: string | null;
  name_source?: string | null;
  image_path?: string | null;
  finalized?: boolean;
  total_supply?: number;
};

export const shortId = (id: string) => `${id.slice(0, 8)}…${id.slice(-6)}`;

/** The sealed image the registry serves, or the id's first byte. */
export function AssetThumb({
  asset,
  id,
  className = "h-8 w-8",
}: {
  asset?: ListedAsset;
  id: string;
  className?: string;
}) {
  return asset?.image_path ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={apiBaseUrl + asset.image_path}
      alt=""
      loading="lazy"
      decoding="async"
      className={`${className} shrink-0 rounded-sm object-cover`}
    />
  ) : (
    <span
      className={`${className} font-data flex shrink-0 items-center justify-center rounded-sm border border-white/10 text-[13px] text-neutral-600`}
    >
      {id.slice(0, 2)}
    </span>
  );
}

/**
 * An asset's name, styled by where it comes from: sealed into the asset id,
 * typed by its issuer, or unknown to this registry.
 */
export function AssetTitle({ asset }: { asset?: ListedAsset }) {
  if (!asset?.display_name) return <span className="italic text-neutral-500">unnamed asset</span>;
  return (
    <span
      className={asset.name_source === "envelope" ? "text-neutral-100" : "italic text-neutral-300"}
      title={asset.name_source === "envelope" ? undefined : "Free-text label, not a sealed name"}
    >
      {asset.display_name}
    </span>
  );
}
