"use client";

import { useQuery } from "@tanstack/react-query";

import { CopyButton } from "@/components/copy-button";
import { api } from "@/lib/api";
import { explorerBlockUrl, explorerTxUrl } from "@/lib/site";

const KIND_LABEL: Record<string, string> = {
  issuance: "Minted",
  burn: "Burned",
  finalization: "Supply sealed",
};

/** How deep an event sits under the tip, in the chain's own units. */
function depthLabel(depth: number): string {
  if (depth <= 0) return "at the tip";
  if (depth === 1) return "1 block ago";
  return `${depth.toLocaleString("en-US")} blocks ago`;
}

/** A height or txid: a link when an explorer is configured, plain text otherwise. */
function ExplorerLink({ href, children }: { href: string | null; children: React.ReactNode }) {
  if (!href) return <>{children}</>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      title="View on the block explorer"
      className="underline decoration-white/20 underline-offset-2 transition hover:text-accent hover:decoration-accent/50"
    >
      {children}
    </a>
  );
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
    <section className="mt-14">
      <h2 className="font-display text-2xl font-medium text-neutral-100">Public history</h2>
      {events.isPending && <div className="mt-5 h-16 motion-safe:animate-pulse bg-surface" />}
      {events.isError && <p className="mt-5 text-sm text-red-400">{events.error.message}</p>}
      {events.data && (
        <div className="mt-3">
          {/* The registry answers oldest first, the order things happened
              in. A reader wants what happened last: shown newest first. */}
          {[...events.data].reverse().map((event, index) => (
            <div
              key={`${event.txid}-${event.kind}-${index}`}
              className="grid gap-x-8 gap-y-1.5 border-b border-line py-4 last:border-b-0 sm:grid-cols-[13rem_minmax(0,1fr)]"
            >
              <span className="text-base font-medium text-neutral-100">
                {KIND_LABEL[event.kind] ?? event.kind}
                {event.amount > 0 && (
                  <span className="font-data ml-2.5 font-normal text-accent">
                    {event.amount.toLocaleString("en-US")}
                  </span>
                )}
                <span className="font-data block text-[13px] font-normal text-neutral-500">
                  <ExplorerLink href={explorerBlockUrl(event.height)}>
                    block {event.height.toLocaleString("en-US")}
                  </ExplorerLink>
                  {tipHeight !== undefined && ` · ${depthLabel(tipHeight - event.height)}`}
                </span>
              </span>
              <span className="flex min-w-0 items-start justify-between gap-3">
                <span className="font-data break-all text-sm leading-relaxed text-neutral-400">
                  <ExplorerLink href={explorerTxUrl(event.txid)}>{event.txid}</ExplorerLink>
                </span>
                <CopyButton value={event.txid} />
              </span>
            </div>
          ))}
        </div>
      )}
      <p className="font-data mt-4 text-[13px] text-neutral-500">
        Transfers are shielded: they never appear here.
      </p>
    </section>
  );
}
