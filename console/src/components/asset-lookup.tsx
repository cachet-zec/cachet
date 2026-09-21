"use client";

import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { AssetName } from "@/components/asset-name";
import { api, apiBaseUrl, problemMessage } from "@/lib/api";
import { fetchKept } from "@/lib/kept";
import { card, cardTitle, ghostButton, input, stamp } from "@/lib/ui";

/** An asset id typed, pasted, or sitting inside a pasted link. */
function assetIdIn(text: string): string | null {
  // No lookbehind: older Safari does not parse one.
  return text.toLowerCase().match(/(?:^|[^0-9a-f])([0-9a-f]{64})(?![0-9a-f])/)?.[1] ?? null;
}

/**
 * Find one asset by its id. The answer is the same row the registry list
 * shows, and it leads to the asset's page, where everything is checked. An
 * asset the chain no longer carries but whose sealed content is kept is
 * found too, and says so.
 */
export function AssetLookup() {
  const [typed, setTyped] = useState("");

  const lookup = useMutation({
    mutationFn: async () => {
      const assetId = assetIdIn(typed);
      if (!assetId) throw new Error("An asset id is 64 hexadecimal characters.");
      const { data, error, response } = await api.GET("/api/v1/assets/{asset_id}", {
        params: { path: { asset_id: assetId } },
      });
      if (data) return { assetId, onChain: data, kept: null };
      if (response.status === 404) {
        const kept = await fetchKept(assetId).catch(() => null);
        if (kept) return { assetId, onChain: null, kept };
      }
      throw new Error(problemMessage(error));
    },
  });

  const found = lookup.data;
  const row = found?.onChain ?? found?.kept;

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
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          placeholder="asset id, or a link to an asset"
          required
        />
        <button
          data-testid="lookup-submit"
          className={`${ghostButton} shrink-0`}
          type="submit"
          disabled={lookup.isPending}
        >
          Find
        </button>
      </form>

      {found && row && (
        <Link
          href={`/assets/${found.assetId}`}
          data-testid="lookup-result"
          className="group mt-4 flex items-center gap-3.5 border-y border-line py-3 pl-1 pr-1.5 transition hover:bg-white/[0.025]"
        >
          {row.image_path ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={apiBaseUrl + row.image_path}
              alt=""
              loading="lazy"
              decoding="async"
              className="h-11 w-11 shrink-0 rounded-sm object-cover"
            />
          ) : (
            <span className="font-data flex h-11 w-11 shrink-0 items-center justify-center rounded-sm border border-white/10 text-[13px] text-neutral-600">
              {found.assetId.slice(0, 2)}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-3">
              <AssetName name={row.display_name} source={row.name_source} assetId={found.assetId} />
              {found.onChain ? (
                <span className="flex shrink-0 items-center gap-2">
                  <span className={stamp}>
                    {found.onChain.finalized ? "sealed" : "open supply"}
                  </span>
                  <span data-testid="lookup-supply" className="font-data text-sm text-accent">
                    {found.onChain.total_supply.toLocaleString("en-US")}
                  </span>
                </span>
              ) : (
                <span className="font-data shrink-0 text-[13px] text-accent">
                  no longer on this chain
                </span>
              )}
            </div>
            <p className="mt-0.5 truncate font-data text-[13px] text-neutral-600">
              {found.assetId}
            </p>
          </div>
          <span
            aria-hidden
            className="shrink-0 text-neutral-500 transition group-hover:translate-x-0.5 group-hover:text-accent"
          >
            →
          </span>
        </Link>
      )}
      {found && (
        <p className="mt-2.5 text-[13px] text-neutral-500">
          {found.onChain
            ? "Open it: the page checks the asset id, the name and the image in your browser."
            : "The test network was reset. Open it to see what was kept, and to mint it again."}
        </p>
      )}
      {lookup.isError && <p className="mt-3 text-sm text-red-400">{lookup.error.message}</p>}
    </section>
  );
}
