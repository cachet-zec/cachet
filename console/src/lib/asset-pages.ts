import type { paths } from "@cachet/api-client";

import { api } from "@/lib/api";

export type AssetSummary =
  paths["/api/v1/assets"]["get"]["responses"][200]["content"]["application/json"][number];

export type AssetPageQuery = {
  limit: number;
  offset: number;
  q?: string;
  issuer?: string;
  supply?: "sealed" | "open";
  resolved?: boolean;
  order?: "named_first";
};

export type AssetPage = {
  items: AssetSummary[];
  /** Assets the registry lists at all. */
  registry: number;
  /** Assets matching the filters, across every page. */
  total: number;
  /** Among those, the ones without a resolved description. */
  unresolved: number;
};

const NAME_RANK: Record<string, number> = { envelope: 0, free_text: 1 };
const rank = (source: string | null | undefined) =>
  source === null || source === undefined ? 2 : (NAME_RANK[source] ?? 2);

/**
 * One page of the registry. The registry filters, orders and counts; the
 * page only ever holds the rows it shows.
 *
 * A registry that predates paging says no totals, and cuts the listing at
 * `limit` without knowing `offset`. It is then asked for everything, once,
 * and the same view is worked out here, so the list behaves the same
 * whichever registry the visitor picked.
 */
export async function fetchAssetPage(query: AssetPageQuery): Promise<AssetPage> {
  const q = query.q?.trim() || undefined;
  const { data, error, response } = await api.GET("/api/v1/assets", {
    params: { query: { ...query, q } },
  });
  if (error) throw new Error(error.detail);

  const header = (name: string) => {
    const value = response.headers.get(name);
    return value === null ? null : Number(value);
  };
  const total = header("x-total-count");
  if (total !== null) {
    return {
      items: data,
      total,
      registry: header("x-registry-count") ?? total,
      unresolved: header("x-unresolved-count") ?? 0,
    };
  }

  const everything = await api.GET("/api/v1/assets");
  if (everything.error) throw new Error(everything.error.detail);
  const all = everything.data;

  const needle = q?.toLowerCase() ?? "";
  let kept = all.filter(
    (asset) =>
      (needle === "" ||
        asset.display_name?.toLowerCase().includes(needle) ||
        asset.description?.toLowerCase().includes(needle) ||
        asset.asset_id.startsWith(needle) ||
        asset.issuer?.startsWith(needle)) &&
      (!query.issuer || asset.issuer === query.issuer) &&
      (!query.supply || asset.finalized === (query.supply === "sealed")) &&
      (!query.resolved || Boolean(asset.name_source)),
  );
  if (query.order === "named_first") {
    // Array.sort is stable, so chain order survives inside each group.
    kept = [...kept].sort((a, b) => rank(a.name_source) - rank(b.name_source));
  }
  return {
    items: kept.slice(query.offset, query.offset + query.limit),
    total: kept.length,
    registry: all.length,
    unresolved: kept.filter((asset) => !asset.name_source).length,
  };
}

/** How many assets the registry lists, without downloading any. */
export async function fetchAssetCount(): Promise<number> {
  return (await fetchAssetPage({ limit: 0, offset: 0 })).registry;
}
