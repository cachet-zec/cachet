"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { api, problemMessage } from "@/lib/api";
import { card, cardTitle, ghostButton, input } from "@/lib/ui";

export function AssetLookup() {
  const [assetId, setAssetId] = useState("");

  const lookup = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.GET("/api/v1/assets/{asset_id}", {
        params: { path: { asset_id: assetId.trim() } },
      });
      if (error) throw new Error(problemMessage(error));
      return data;
    },
  });

  return (
    <section className={card}>
      <h2 className={`${cardTitle} mb-4`}>Look up an asset</h2>
      <form
        className="flex gap-2.5"
        onSubmit={(event) => {
          event.preventDefault();
          lookup.mutate();
        }}
      >
        <input
          data-testid="lookup-asset-id"
          className={input}
          value={assetId}
          onChange={(event) => setAssetId(event.target.value)}
          placeholder="asset id (64 hex chars)"
          required
        />
        <button
          data-testid="lookup-submit"
          className={`${ghostButton} shrink-0`}
          type="submit"
          disabled={lookup.isPending}
        >
          Fetch
        </button>
      </form>
      {lookup.isSuccess && (
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 rounded-md border border-white/[0.07] p-3.5 text-sm">
          <dt className="text-neutral-400">Supply</dt>
          <dd data-testid="lookup-supply" className="font-data text-[#e8b23a]">
            {lookup.data.total_supply}
          </dd>
          <dt className="text-neutral-400">Finalized</dt>
          <dd className="font-data text-neutral-200">{lookup.data.finalized ? "yes" : "no"}</dd>
        </dl>
      )}
      {lookup.isError && <p className="mt-3 text-sm text-red-400">{lookup.error.message}</p>}
    </section>
  );
}
