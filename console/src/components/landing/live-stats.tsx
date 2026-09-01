"use client";

import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

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
  const assets = useQuery({
    queryKey: ["assets"],
    queryFn: async () => {
      const { data, error } = await api.GET("/api/v1/assets");
      if (error) throw new Error(error.detail);
      return data;
    },
    refetchInterval: 30_000,
  });

  const rows = [
    ["network", chain.data?.network ?? "-"],
    ["chain tip", chain.data ? `#${chain.data.tip_height}` : "-"],
    ["assets registered", assets.data ? String(assets.data.length) : "-"],
    // Zero is the feature, not missing data: balances are shielded, so a
    // registry cannot count holders. Kept short enough to stay on one line.
    ["holders visible", "0 (shielded)"],
  ];

  return (
    <div className="font-data w-full max-w-sm text-[13px]">
      {rows.map(([key, value]) => (
        <div
          key={key}
          className="flex items-baseline justify-between gap-4 border-b border-white/[0.07] py-2.5"
        >
          <span className="uppercase tracking-[0.16em] text-neutral-500">{key}</span>
          <span className="whitespace-nowrap text-right text-neutral-200">{value}</span>
        </div>
      ))}
      <p className="mt-3 flex items-center gap-2 text-[11px] uppercase tracking-[0.14em] text-neutral-600">
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            chain.isError ? "bg-red-400" : "pulse-dot bg-[#e8b23a]"
          }`}
        />
        live from the public ZSA testnet
      </p>
    </div>
  );
}
