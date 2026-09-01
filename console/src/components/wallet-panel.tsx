"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { api } from "@/lib/api";
import { card, cardTitle } from "@/lib/ui";

/**
 * Spendable holdings of the server wallet's accounts. Hidden on read-only
 * deployments: the operator's shielded balances are private (the API
 * refuses the call there too).
 */
export function WalletPanel() {
  const chain = useQuery({
    queryKey: ["chain"],
    queryFn: async () => {
      const { data, error } = await api.GET("/api/v1/chain");
      if (error) throw new Error(error.detail);
      return data;
    },
  });
  const readOnly = chain.data?.read_only ?? false;
  const wallet = useQuery({
    queryKey: ["wallet"],
    enabled: chain.isSuccess && !readOnly,
    queryFn: async () => {
      const { data, error } = await api.GET("/api/v1/wallet");
      if (error) throw new Error(error.detail);
      return data;
    },
    refetchInterval: 20_000,
  });

  // Reuse the registry to resolve display names.
  const assets = useQuery({
    queryKey: ["assets"],
    queryFn: async () => {
      const { data, error } = await api.GET("/api/v1/assets");
      if (error) throw new Error(error.detail);
      return data;
    },
  });
  const nameOf = (assetId: string) =>
    assets.data?.find((asset) => asset.asset_id === assetId)?.display_name ?? null;

  if (!chain.isSuccess || readOnly) return null;

  return (
    <section className={card}>
      <h2 className={`${cardTitle} mb-3`}>Wallet</h2>
      {wallet.isPending && <div className="h-16 animate-pulse rounded-md bg-white/[0.04]" />}
      {wallet.isError && <p className="text-sm text-red-400">{wallet.error.message}</p>}
      {wallet.data && wallet.data.length === 0 && (
        <p className="text-sm text-neutral-500">No holdings yet. Mint something.</p>
      )}
      {wallet.data && wallet.data.length > 0 && (
        <div className="flex flex-col gap-3">
          {wallet.data.map((account) => (
            <div key={account.account}>
              <p className="font-data text-[11px] uppercase tracking-[0.18em] text-neutral-500">
                account:{account.account}
              </p>
              <div className="mt-1 border-t border-white/[0.07]">
                {account.holdings.map((holding) => (
                  <Link
                    key={holding.asset_id}
                    href={`/assets/${holding.asset_id}`}
                    className="flex items-baseline justify-between gap-3 border-b border-white/[0.07] py-2 text-sm transition hover:bg-white/[0.025]"
                  >
                    <span className="truncate text-neutral-300">
                      {nameOf(holding.asset_id) ?? (
                        <span className="font-data text-xs text-neutral-600">
                          {holding.asset_id.slice(0, 20)}…
                        </span>
                      )}
                    </span>
                    <span className="font-data shrink-0 text-[#e8b23a]">
                      {holding.amount.toLocaleString("en-US")}
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
