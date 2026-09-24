import type { Metadata } from "next";

import { AssetDetail } from "@/components/asset-detail";
import { apiBaseUrl } from "@/lib/api";
import { pageMetadata } from "@/lib/seo";

/**
 * Server-side title: the asset's safe display name when the API is
 * reachable, a neutral fallback otherwise (the page itself renders
 * client-side either way).
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  // Only a well-formed id gets a canonical URL: anything else is a 404 page.
  const path = /^[0-9a-f]{64}$/i.test(id) ? `/assets/${id.toLowerCase()}` : "/console";
  const wellFormed = path.startsWith("/assets/");
  const fallback = pageMetadata({
    title: `Asset ${id.slice(0, 8)}… · Cachet`,
    path,
    card: wellFormed
      ? { url: `${path}/opengraph-image`, alt: "A Zcash Shielded Asset on the ZSA testnet" }
      : undefined,
  });
  try {
    const response = await fetch(`${apiBaseUrl}/api/v1/assets/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(2_000),
      cache: "no-store",
    });
    if (!response.ok) return fallback;
    const asset = (await response.json()) as {
      display_name?: string | null;
      total_supply?: string | number;
      finalized?: boolean;
    };
    if (!asset.display_name) return fallback;
    const state = asset.finalized ? "sealed forever" : "open supply";
    return pageMetadata({
      card: {
        url: `${path}/opengraph-image`,
        alt: `${asset.display_name}, a Zcash Shielded Asset`,
      },
      title: `${asset.display_name} · Cachet`,
      description: `A Zcash Shielded Asset on the public ZSA testnet. Supply ${String(asset.total_supply ?? "?")}, ${state}. Metadata sealed on chain and verified in your browser.`,
      path,
    });
  } catch {
    return fallback;
  }
}

export default async function AssetPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ just?: string }>;
}) {
  const { id } = await params;
  const { just } = await searchParams;
  return (
    <div className="rise">
      <AssetDetail assetId={id} justMinted={just === "minted"} />
    </div>
  );
}
