"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

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

type Event = { height: number; txid: string; kind: string; amount: number };

/**
 * The supply ledger an asset's public events add up to: everything ever
 * issued, everything burned, what remains, and where the seal landed.
 * `after` is the supply once each event (oldest first) had happened.
 */
function ledger(events: Event[]) {
  let issued = 0;
  let burned = 0;
  const after = events.map((event) => {
    if (event.kind === "issuance") issued += event.amount;
    if (event.kind === "burn") burned += event.amount;
    return issued - burned;
  });
  const sealedAt = events.find((event) => event.kind === "finalization")?.height ?? null;
  return { issued, burned, circulating: issued - burned, sealedAt, after };
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
  const book = events.data ? ledger(events.data) : null;

  return (
    <section className="mt-14">
      <h2 className="font-display text-2xl font-medium text-neutral-100">Public history</h2>
      {events.isPending && <div className="mt-5 h-16 motion-safe:animate-pulse bg-surface" />}
      {events.isError && <p className="mt-5 text-sm text-red-400">{events.error.message}</p>}
      {book && (
        <dl
          data-testid="supply-ledger"
          className="mt-4 grid grid-cols-2 border-y border-line sm:grid-cols-4"
        >
          {[
            { label: "Issued", value: book.issued.toLocaleString("en-US") },
            { label: "Burned", value: book.burned.toLocaleString("en-US") },
            { label: "In circulation", value: book.circulating.toLocaleString("en-US") },
            {
              label: "Supply",
              value: book.sealedAt === null ? "Open" : "Sealed",
              detail:
                book.sealedAt === null
                  ? "the issuer can mint more"
                  : `at block ${book.sealedAt.toLocaleString("en-US")}`,
            },
          ].map((figure) => (
            <div
              key={figure.label}
              className="border-line py-4 pr-4 max-sm:even:border-l max-sm:even:pl-4 max-sm:[&:nth-child(n+3)]:border-t sm:border-l sm:pl-5 sm:first:border-l-0 sm:first:pl-0"
            >
              <dt className="font-data text-sm text-neutral-400">{figure.label}</dt>
              <dd className="font-display mt-1 text-2xl font-medium tabular-nums text-neutral-50">
                {figure.value}
              </dd>
              {figure.detail && (
                <dd className="font-data mt-0.5 text-[13px] text-neutral-500">{figure.detail}</dd>
              )}
            </div>
          ))}
        </dl>
      )}
      {events.data && book && (
        <div className="mt-3">
          {/* The registry answers oldest first, the order things happened
              in. A reader wants what happened last: shown newest first. */}
          {events.data
            .map((event, index) => ({ event, after: book.after[index] ?? 0 }))
            .reverse()
            .map(({ event, after }, index) => (
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
                    {event.kind !== "finalization" && ` · supply ${after.toLocaleString("en-US")}`}
                  </span>
                </span>
                <span className="flex min-w-0 items-start justify-between gap-3">
                  <span className="font-data break-all text-sm leading-relaxed text-neutral-400">
                    <ExplorerLink href={explorerTxUrl(event.txid)}>{event.txid}</ExplorerLink>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <Link
                      href={`/tx/${event.txid}`}
                      className="whitespace-nowrap rounded-sm border border-white/10 px-2 py-0.5 text-[13px] text-neutral-400 transition hover:border-accent/50 hover:text-accent"
                      title="What this transaction published, decoded from its bytes"
                    >
                      Decode
                    </Link>
                    <CopyButton value={event.txid} />
                  </span>
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
