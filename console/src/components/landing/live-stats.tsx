"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { CountUp } from "@/components/count-up";
import { api } from "@/lib/api";
import { fetchAssetCount } from "@/lib/asset-pages";

/** A terse, ledger-style readout of the live chain. */
export function LiveStats() {
  const chain = useQuery({
    queryKey: ["chain"],
    queryFn: async () => {
      const { data, error } = await api.GET("/api/v1/chain");
      if (error) throw new Error(error.detail);
      return data;
    },
    refetchInterval: 15_000,
  });
  // A figure is shown, so a figure is asked for: no rows travel.
  const assets = useQuery({
    queryKey: ["assets", "count"],
    queryFn: fetchAssetCount,
    refetchInterval: 30_000,
  });

  const rows = [
    ["network", chain.data?.network ?? "-"],
    ["chain tip", chain.data ? `#${chain.data.tip_height}` : "-"],

    // Exact: issuance is public (issuer, amount, first recipient address),
    // everything after it is not. Kept short enough to stay on one line.
    ["balances, transfers", "shielded"],
  ];

  return (
    <div className="w-full max-w-sm">
      <p className="font-data text-sm text-accent">Assets on the register</p>
      <p className="font-display mt-1 text-6xl font-medium leading-none text-neutral-50 tabular-nums">
        {assets.data !== undefined ? <CountUp value={assets.data} /> : "-"}
      </p>
      <div className="font-data mt-6 text-sm">
        {rows.map(([key, value]) => (
          <div key={key} className="flex items-baseline justify-between gap-4 py-1.5">
            <span className="text-neutral-400">{key}</span>
            <span className="whitespace-nowrap text-right text-neutral-100">{value}</span>
          </div>
        ))}
      </div>
      <p className="font-data mt-3 flex items-center gap-2 text-[13px] text-neutral-500">
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            chain.isError ? "bg-red-400" : "pulse-dot bg-accent"
          }`}
        />
        live from the public ZSA testnet
      </p>
      {chain.data?.mints_paused && (
        <p className="mt-3 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-[13px] leading-snug text-accent">
          Minting is paused by the operator. What was sealed here stays, and can be minted again
          with the same seed once it is lifted.{" "}
          <Link href="/continuity" className="underline decoration-accent/40">
            What survives a reset
          </Link>
        </p>
      )}
    </div>
  );
}
