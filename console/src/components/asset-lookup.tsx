"use client";

import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";

import { AssetName } from "@/components/asset-name";
import { api, apiBaseUrl, problemMessage } from "@/lib/api";
import { fetchKept } from "@/lib/kept";
import { card, cardTitle, ghostButton, input, stamp } from "@/lib/ui";

/** Suggestions shown while typing. */
const SUGGESTIONS = 8;

/** An asset id typed, pasted, or sitting inside a pasted link. */
function assetIdIn(text: string): string | null {
  // No lookbehind: older Safari does not parse one.
  return text.toLowerCase().match(/(?:^|[^0-9a-f])([0-9a-f]{64})(?![0-9a-f])/)?.[1] ?? null;
}

/** The registry's thumbnail for a sealed image, or a monogram. */
function Thumb({
  imagePath,
  assetId,
  size,
}: {
  imagePath?: string | null;
  assetId: string;
  size: string;
}) {
  return imagePath ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={apiBaseUrl + imagePath}
      alt=""
      loading="lazy"
      decoding="async"
      className={`${size} shrink-0 rounded-sm object-cover`}
    />
  ) : (
    <span
      className={`${size} font-data flex shrink-0 items-center justify-center rounded-sm border border-white/10 text-[13px] text-neutral-600`}
    >
      {assetId.slice(0, 2)}
    </span>
  );
}

/**
 * Find one asset by its id. The answer is the same row the registry list
 * shows, and it leads to the asset's page, where everything is checked. An
 * asset the chain no longer carries but whose sealed content is kept is
 * found too, and says so.
 *
 * While typing, the registry suggests assets whose name or description
 * contains the text, or whose id or issuer key starts with it: the search
 * the registry list runs, asked once the typing pauses.
 */
export function AssetLookup() {
  const router = useRouter();
  const listId = useId();
  const [typed, setTyped] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [needle, setNeedle] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setNeedle(typed.trim()), 200);
    return () => clearTimeout(timer);
  }, [typed]);

  // A whole id or a link is looked up exactly; anything shorter is a search.
  const searching = needle.length >= 2 && assetIdIn(needle) === null;
  const suggestions = useQuery({
    queryKey: ["assets", "lookup", needle],
    queryFn: async () => {
      const { data, error } = await api.GET("/api/v1/assets", {
        params: { query: { q: needle, limit: SUGGESTIONS, order: "named_first" } },
      });
      if (error) throw new Error(problemMessage(error));
      return data;
    },
    enabled: searching,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });
  const shown = open && searching && (suggestions.data?.length ?? 0) > 0;
  const options = shown ? (suggestions.data ?? []) : [];

  const lookup = useMutation({
    mutationFn: async () => {
      const assetId = assetIdIn(typed);
      if (!assetId) {
        throw new Error("Pick a suggestion, or give a whole asset id (64 hexadecimal characters).");
      }
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
          const picked = options[active];
          if (picked) {
            router.push(`/assets/${picked.asset_id}`);
            return;
          }
          setOpen(false);
          lookup.mutate();
        }}
      >
        <div className="relative min-w-0 flex-1">
          <input
            data-testid="lookup-asset-id"
            className={input}
            value={typed}
            onChange={(event) => {
              setTyped(event.target.value);
              setActive(-1);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 120)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && options.length > 0) {
                event.preventDefault();
                setActive((current) => (current + 1) % options.length);
              } else if (event.key === "ArrowUp" && options.length > 0) {
                event.preventDefault();
                setActive((current) => (current <= 0 ? options.length - 1 : current - 1));
              } else if (event.key === "Escape") {
                setOpen(false);
              }
            }}
            placeholder="a name, an asset id, or a link"
            role="combobox"
            aria-expanded={shown}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={shown && active >= 0 ? `${listId}-${active}` : undefined}
            autoComplete="off"
            spellCheck={false}
            required
          />
          {shown && (
            <ul
              id={listId}
              role="listbox"
              data-testid="lookup-suggestions"
              className="absolute inset-x-0 top-full z-20 mt-1 max-h-96 overflow-y-auto rounded-md border border-line-strong bg-surface py-1 shadow-[0_8px_24px_rgba(0,0,0,0.45)]"
            >
              {options.map((asset, index) => (
                <li
                  key={asset.asset_id}
                  id={`${listId}-${index}`}
                  role="option"
                  aria-selected={index === active}
                  data-testid="lookup-suggestion"
                  className={`flex cursor-pointer items-center gap-3 px-3 py-2 ${
                    index === active ? "bg-accent/[0.08]" : "hover:bg-white/[0.03]"
                  }`}
                  onMouseEnter={() => setActive(index)}
                  // mousedown, before the input's blur closes the list
                  onMouseDown={(event) => {
                    event.preventDefault();
                    router.push(`/assets/${asset.asset_id}`);
                  }}
                >
                  <Thumb imagePath={asset.image_path} assetId={asset.asset_id} size="h-8 w-8" />
                  <span className="flex min-w-0 flex-1 flex-col leading-tight">
                    <AssetName
                      name={asset.display_name}
                      source={asset.name_source}
                      assetId={asset.asset_id}
                    />
                    <span className="font-data truncate text-[13px] text-neutral-500">
                      {asset.asset_id.slice(0, 12)}…
                    </span>
                  </span>
                  <span className="font-data shrink-0 text-[13px] text-accent">
                    {asset.total_supply.toLocaleString("en-US")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button
          data-testid="lookup-submit"
          className={`${ghostButton} shrink-0`}
          type="submit"
          disabled={lookup.isPending}
        >
          Find
        </button>
      </form>
      {open && searching && suggestions.data?.length === 0 && (
        <p className="mt-2 text-[13px] text-neutral-500">
          Nothing in this registry matches. A whole asset id or a link also finds what a reset took.
        </p>
      )}

      {found && row && (
        <Link
          href={`/assets/${found.assetId}`}
          data-testid="lookup-result"
          className="group mt-4 flex items-center gap-3.5 border-y border-line py-3 pl-1 pr-1.5 transition hover:bg-white/[0.025]"
        >
          <Thumb imagePath={row.image_path} assetId={found.assetId} size="h-11 w-11" />
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
