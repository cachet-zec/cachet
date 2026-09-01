import type { Metadata } from "next";

import { AssetDetail } from "@/components/asset-detail";
import { apiBaseUrl } from "@/lib/api";

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
  const fallback = { title: `Asset ${id.slice(0, 8)}… · Cachet` };
  try {
    const response = await fetch(`${apiBaseUrl}/api/v1/assets/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(2_000),
      cache: "no-store",
    });
    if (!response.ok) return fallback;
    const asset = (await response.json()) as { display_name?: string | null };
    return asset.display_name ? { title: `${asset.display_name} · Cachet` } : fallback;
  } catch {
    return fallback;
  }
}

export default async function AssetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="rise">
      <AssetDetail assetId={id} />
    </div>
  );
}
