"use client";

import { useQuery } from "@tanstack/react-query";

import { CopyButton } from "@/components/copy-button";
import { api } from "@/lib/api";
import { cardTitle } from "@/lib/ui";

const KIND_LABEL: Record<string, string> = {
  issuance: "Minted",
  burn: "Burned",
  finalization: "Sealed: supply made permanent",
};

/** How deep an event sits under the tip, in the chain's own units. */
function depthLabel(depth: number): string {
  if (depth <= 0) return "at the tip";
  if (depth === 1) return "1 block ago";
  return `${depth.toLocaleString("en-US")} blocks ago`;
}

/** Public history of an asset. Transfers are shielded: never listed. */
export function AssetEvents({ assetId }: { assetId: string }) {
  // The chain's own block timestamps are synthetic on this network (block 1
  // reads 2011-02-03), so a date here would be fiction. Depth is the honest
  // answer to "how recent is this?": it comes from the chain, and every
  // mirror computes the same number from the same chain state.
  const chain = useQuery({
    queryKey: ["chain"],
    queryFn: async () => {
      const { data, error } = await api.GET("/api/v1/chain");
      if (error) throw new Error(error.detail);
      return data;
    },
    refetchInterval: 30_000,
  });

  const events = useQuery({
    queryKey: ["events", assetId],
    queryFn: async () => {
      const { data, error } = await api.GET("/api/v1/assets/{asset_id}/events", {
        params: { path: { asset_id: assetId } },
      });
      if (error) throw new Error(error.detail);
      return data;
    },
  });

  const tipHeight = chain.data?.tip_height;

  return (
    <div className="mt-6 border-t border-white/5 pt-5">
      <h2 className={cardTitle}>Public history</h2>
      {events.isPending && <div className="mt-3 h-16 animate-pulse rounded-md bg-white/[0.04]" />}
      {events.isError && <p className="mt-3 text-sm text-red-400">{events.error.message}</p>}
      {events.data && (
        <>
          <div className="mt-2">
            {events.data.map((event, index) => (
              <div
                key={`${event.txid}-${event.kind}-${index}`}
                className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-white/[0.06] py-2.5 last:border-b-0"
              >
                <span className="font-data w-24 shrink-0 text-xs text-neutral-500">
                  #{event.height}
                  {tipHeight !== undefined && (
                    <span className="block text-[10px] text-neutral-600">
                      {depthLabel(tipHeight - event.height)}
                    </span>
                  )}
                </span>
                <span className="min-w-32 text-sm text-neutral-200">
                  {KIND_LABEL[event.kind] ?? event.kind}
                  {event.amount > 0 && (
                    <span className="font-data ml-2 text-[#e8b23a]">
                      {event.amount.toLocaleString("en-US")}
                    </span>
                  )}
                </span>
                <span className="flex min-w-0 flex-1 items-center justify-end gap-2">
                  <span className="font-data truncate text-[11px] text-neutral-600">
                    {event.txid}
                  </span>
                  <CopyButton value={event.txid} />
                </span>
              </div>
            ))}
          </div>
          <p className="font-data mt-3 text-[11px] uppercase tracking-[0.14em] text-neutral-600">
            Transfers are shielded. They never appear here.
          </p>
        </>
      )}
    </div>
  );
}
