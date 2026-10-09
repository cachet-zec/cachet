"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import type { ListedAsset } from "@/components/asset-chip";
import { CopyButton } from "@/components/copy-button";
import { OfferSide, rate } from "@/components/swap-board";
import { api, problemMessage } from "@/lib/api";
import { explorerTxUrl } from "@/lib/site";
import { stamp } from "@/lib/ui";

const sectionTitle = "font-display text-2xl font-medium text-neutral-100";

/** What this registry knows of one asset. */
function useAsset(assetId: string) {
  return useQuery({
    queryKey: ["asset", assetId],
    queryFn: async () => {
      const { data } = await api.GET("/api/v1/assets/{asset_id}", {
        params: { path: { asset_id: assetId } },
      });
      return data ?? null;
    },
    staleTime: 60_000,
  });
}

/** An asset id, labelled with its name when this registry knows one. */
function AssetLabel({ assetId }: { assetId: string }) {
  const asset = useAsset(assetId);
  const name = asset.data?.display_name;
  return (
    <Link
      href={`/assets/${assetId}`}
      className="min-w-0 text-[17px] text-neutral-100 transition hover:text-accent"
    >
      {name ?? <span className="font-data break-all text-sm">{assetId}</span>}
    </Link>
  );
}

/**
 * The board offer this transaction filled: its terms were public on the
 * board, and the registry links the two only once the chain holds the very
 * transaction the maker countersigned.
 */
function SwapFill({
  swap,
}: {
  swap: {
    give_asset: string;
    give_amount: number;
    want_asset: string;
    want_amount: number;
  };
}) {
  const give = useAsset(swap.give_asset);
  const want = useAsset(swap.want_asset);
  return (
    <section data-testid="tx-swap">
      <h2 className={sectionTitle}>Swap</h2>
      <p className="mt-3 max-w-prose text-base leading-relaxed text-neutral-300">
        This transaction filled an offer from the swap board: both payments, in one transaction.
      </p>
      <div className="mt-5 grid gap-5 rounded-md border border-line bg-white/[0.02] p-5 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-3">
          <span className="font-data text-[12px] uppercase tracking-[0.14em] text-neutral-500">
            The maker gave
          </span>
          <OfferSide
            amount={swap.give_amount}
            id={swap.give_asset}
            asset={(give.data ?? undefined) as ListedAsset | undefined}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-3">
          <span className="font-data text-[12px] uppercase tracking-[0.14em] text-neutral-500">
            The taker gave
          </span>
          <OfferSide
            amount={swap.want_amount}
            id={swap.want_asset}
            asset={(want.data ?? undefined) as ListedAsset | undefined}
          />
        </div>
      </div>
      <p className="font-data mt-3 text-[13px] text-neutral-500">
        rate 1 : {rate(swap.give_amount, swap.want_amount)} · who the two parties are stays
        encrypted
      </p>
    </section>
  );
}

/** One line of the decoded record: what it is, and the figure. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-x-8 gap-y-1.5 border-b border-line py-4 last:border-b-0 sm:grid-cols-[13rem_minmax(0,1fr)]">
      <dt className="text-base font-medium text-neutral-100">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

/**
 * What one transaction published about ZSAs, decoded from its own bytes by
 * this registry: the issuance (issuer, assets, units, seals) and the burns.
 * Transfers stay encrypted; the page says how many actions there are and
 * nothing else about them.
 */
export function TxDetail({ txid }: { txid: string }) {
  const tx = useQuery({
    queryKey: ["tx", txid],
    queryFn: async () => {
      const { data, error } = await api.GET("/api/v1/transactions/{txid}", {
        params: { path: { txid } },
      });
      if (error) throw new Error(problemMessage(error));
      return data;
    },
    retry: false,
  });
  const explorer = explorerTxUrl(txid);

  return (
    <div className="flex flex-col gap-10">
      <header>
        <p className="font-data text-sm text-neutral-400">Transaction</p>
        <h1 className="font-data mt-2 break-all text-lg text-neutral-100 sm:text-xl">{txid}</h1>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-neutral-400">
          <CopyButton value={txid} label="Copy txid" />
          {tx.data && (
            <span className="font-data">
              {tx.data.height === null || tx.data.height === undefined
                ? "in the mempool"
                : `block ${tx.data.height.toLocaleString("en-US")}`}
              {` · v${tx.data.version}`}
            </span>
          )}
          {explorer && (
            <a
              href={explorer}
              target="_blank"
              rel="noreferrer"
              className="underline decoration-white/20 transition hover:text-accent"
            >
              Block explorer
            </a>
          )}
        </div>
      </header>

      {tx.isPending && <div className="h-40 motion-safe:animate-pulse bg-surface" />}
      {tx.isError && (
        <p role="alert" className="text-base text-red-300">
          {tx.error.message}
        </p>
      )}

      {tx.data && (
        <>
          {tx.data.swap && <SwapFill swap={tx.data.swap} />}

          <section>
            <h2 className={sectionTitle}>Issuance</h2>
            {tx.data.issuance ? (
              <dl className="mt-3">
                <Row label="Issuer">
                  <div className="flex items-start justify-between gap-3">
                    <Link
                      href={`/issuers/${tx.data.issuance.issuer}`}
                      className="font-data break-all text-sm text-neutral-300 transition hover:text-accent"
                    >
                      {tx.data.issuance.issuer}
                    </Link>
                    <CopyButton value={tx.data.issuance.issuer} />
                  </div>
                </Row>
                {tx.data.issuance.actions.map((action) => (
                  <Row
                    key={action.asset_id}
                    label={
                      action.amount > 0
                        ? `Minted ${action.amount.toLocaleString("en-US")}`
                        : action.finalize
                          ? "Sealed, no new units"
                          : "No units"
                    }
                  >
                    <AssetLabel assetId={action.asset_id} />
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {action.finalize && <span className={stamp}>supply sealed</span>}
                      {action.reference_note && (
                        <span
                          className="font-data text-[13px] text-neutral-500"
                          title="The zero-value note ZIP 227 requires on an asset's first issuance"
                        >
                          first issuance
                        </span>
                      )}
                      <span className="font-data text-[13px] text-neutral-500">
                        {action.notes} note{action.notes === 1 ? "" : "s"}
                      </span>
                    </div>
                  </Row>
                ))}
              </dl>
            ) : (
              <p className="mt-3 text-base text-neutral-400">This transaction issues nothing.</p>
            )}
          </section>

          <section>
            <h2 className={sectionTitle}>Burns</h2>
            {tx.data.burns.length > 0 ? (
              <dl className="mt-3">
                {tx.data.burns.map((burn) => (
                  <Row key={burn.asset_id} label={`Burned ${burn.amount.toLocaleString("en-US")}`}>
                    <AssetLabel assetId={burn.asset_id} />
                  </Row>
                ))}
              </dl>
            ) : (
              <p className="mt-3 text-base text-neutral-400">This transaction burns nothing.</p>
            )}
          </section>

          <section>
            <h2 className={sectionTitle}>Shielded</h2>
            <p className="mt-3 max-w-prose text-base leading-relaxed text-neutral-300">
              {tx.data.orchard_actions > 0
                ? tx.data.swap
                  ? `${tx.data.orchard_actions} Orchard actions. The terms above come from the public offer; the actions themselves stay encrypted, and so do the two parties.`
                  : `${tx.data.orchard_actions} Orchard action${tx.data.orchard_actions === 1 ? "" : "s"}. Which asset moved, how much and to whom is encrypted: nothing here can tell.`
                : "No Orchard actions."}
            </p>
            {(tx.data.transparent_inputs > 0 ||
              tx.data.transparent_outputs > 0 ||
              tx.data.sapling_spends > 0 ||
              tx.data.sapling_outputs > 0) && (
              <p className="font-data mt-2 text-[13px] text-neutral-500">
                transparent {tx.data.transparent_inputs} in / {tx.data.transparent_outputs} out ·
                sapling {tx.data.sapling_spends} spends / {tx.data.sapling_outputs} outputs
              </p>
            )}
            <p className="font-data mt-4 text-[13px] text-neutral-500">
              Decoded by this registry from the transaction&apos;s bytes. The addresses that
              received the minted units are public on chain; this page leaves them out on purpose.
            </p>
          </section>
        </>
      )}
    </div>
  );
}
