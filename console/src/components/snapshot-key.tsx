"use client";

import { useQuery } from "@tanstack/react-query";

import { CopyButton } from "@/components/copy-button";
import { api } from "@/lib/api";

/**
 * The instance's snapshot signing key (Ed25519 public key), shown in the
 * footer as the on-site anchor for snapshot verification. The operator
 * also publishes it out of band (working paper, posts): a mirror serving
 * a snapshot signed by any other key is not this registry.
 */
export function SnapshotKey() {
  const { data } = useQuery({
    queryKey: ["chain"],
    queryFn: async () => {
      const { data, error } = await api.GET("/api/v1/chain");
      if (error) throw new Error(error.detail);
      return data;
    },
    refetchInterval: 10_000,
  });

  const key = data?.snapshot_public_key;
  if (!key) return null;

  return (
    <span className="flex items-center gap-1.5" title={`snapshot signing key ${key}`}>
      <span>
        Snapshot key <span className="text-neutral-500">{key.slice(0, 8)}…</span>
      </span>
      <CopyButton value={key} />
    </span>
  );
}
