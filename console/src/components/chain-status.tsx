"use client";

import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { Bone } from "@/components/skeleton";

/** Slim, full-width chain readout: network, tip, connection state. */
export function ChainStatus() {
  const { data, error, isPending } = useQuery({
    queryKey: ["chain"],
    queryFn: async () => {
      const { data, error } = await api.GET("/api/v1/chain");
      if (error) throw new Error(error.detail);
      return data;
    },
    refetchInterval: 10_000,
  });

  return (
    <div className="font-data flex flex-wrap items-center gap-x-5 gap-y-1 rounded-lg border border-white/[0.08] bg-surface px-4 py-2.5 text-sm">
      <span className="flex items-center gap-2">
        <span
          className={`h-2 w-2 rounded-full ${
            error ? "bg-red-400" : data ? "pulse-dot bg-accent" : "bg-neutral-600"
          }`}
        />
        <span className="text-[13px] uppercase tracking-[0.18em] text-neutral-500">Node</span>
      </span>
      {isPending && (
        <span role="status" aria-label="Connecting" className="flex items-center gap-5">
          <Bone className="h-3.5 w-24" />
          <Bone className="h-3.5 w-20" />
        </span>
      )}
      {error && <span className="text-red-400">unreachable: {error.message}</span>}
      {data && (
        <>
          <span className="text-neutral-100">{data.network}</span>
          <span className="text-neutral-500">
            tip <span className="text-accent">#{data.tip_height}</span>
          </span>
          {data.read_only && (
            <span className="rounded-sm border border-neutral-500/50 px-1.5 py-0.5 text-[13px] uppercase tracking-[0.14em] text-neutral-400">
              read-only
            </span>
          )}
        </>
      )}
    </div>
  );
}
