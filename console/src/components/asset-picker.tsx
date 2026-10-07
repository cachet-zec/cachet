"use client";

import { useId, useRef, useState } from "react";

import { apiBaseUrl } from "@/lib/api";
import { input } from "@/lib/ui";

/** What the picker knows of an asset, from the registry's listing. */
export type PickableAsset = {
  asset_id: string;
  display_name?: string | null;
  name_source?: string | null;
  image_path?: string | null;
  finalized?: boolean;
};

const MAX_SHOWN = 8;
const isAssetId = (text: string) => /^[0-9a-f]{64}$/.test(text);
const shortId = (id: string) => `${id.slice(0, 8)}…${id.slice(-6)}`;

function Thumb({ asset, id }: { asset?: PickableAsset; id: string }) {
  return asset?.image_path ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={apiBaseUrl + asset.image_path}
      alt=""
      loading="lazy"
      decoding="async"
      className="h-8 w-8 shrink-0 rounded-sm object-cover"
    />
  ) : (
    <span className="font-data flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-white/10 text-[13px] text-neutral-600">
      {id.slice(0, 2)}
    </span>
  );
}

function Name({ asset }: { asset?: PickableAsset }) {
  if (!asset?.display_name) return <span className="italic text-neutral-500">unnamed asset</span>;
  return (
    <span
      className={asset.name_source === "envelope" ? "text-neutral-100" : "italic text-neutral-300"}
      title={asset.name_source === "envelope" ? undefined : "Free-text label, not a sealed name"}
    >
      {asset.display_name}
    </span>
  );
}

/**
 * Choose an asset by name from the registry's listing, or paste its id.
 * The listing is the one the page already holds (the same request for
 * every visitor), so searching tells the registry nothing.
 */
export function AssetPicker({
  id,
  testId,
  value,
  onChange,
  assets,
  exclude,
  loading = false,
}: {
  id: string;
  testId: string;
  /** The chosen asset id, or "" for none. */
  value: string;
  onChange: (assetId: string) => void;
  assets: PickableAsset[];
  /** An asset not to offer (the one being given). */
  exclude?: string;
  /** The listing has not arrived yet. */
  loading?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const chosen = value.trim().toLowerCase();
  if (isAssetId(chosen)) {
    const asset = assets.find((candidate) => candidate.asset_id === chosen);
    return (
      <div
        data-testid={`${testId}-chosen`}
        className="flex min-h-[2.75rem] items-center gap-3 rounded-md border border-white/10 bg-black/30 px-3 py-1.5"
      >
        <Thumb asset={asset} id={chosen} />
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate text-sm">
            <Name asset={asset} />
          </span>
          <span className="font-data truncate text-[13px] text-neutral-500" title={chosen}>
            {shortId(chosen)}
          </span>
        </span>
        <button
          type="button"
          className="shrink-0 text-[13px] text-neutral-400 underline decoration-white/20 underline-offset-2 transition hover:text-accent"
          onClick={() => {
            onChange("");
            setQuery("");
            setOpen(true);
            setTimeout(() => inputRef.current?.focus(), 0);
          }}
        >
          change
        </button>
      </div>
    );
  }

  const needle = query.trim().toLowerCase();
  const matches = assets
    .filter((asset) => asset.asset_id !== exclude)
    .filter((asset) =>
      needle === ""
        ? asset.name_source === "envelope"
        : asset.display_name?.toLowerCase().includes(needle) || asset.asset_id.startsWith(needle),
    )
    // Sealed names first, then labels, then the rest; listing order inside.
    .map((asset, order) => ({ asset, order }))
    .sort((a, b) => rank(a.asset.name_source) - rank(b.asset.name_source) || a.order - b.order)
    .slice(0, MAX_SHOWN)
    .map(({ asset }) => asset);
  const shown = open && matches.length > 0;

  const choose = (assetId: string) => {
    onChange(assetId);
    setQuery("");
    setOpen(false);
  };

  return (
    <div className="relative">
      <input
        ref={inputRef}
        id={id}
        data-testid={testId}
        className={`${input} font-data`}
        role="combobox"
        aria-expanded={shown}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={shown ? `${listId}-${active}` : undefined}
        value={query}
        placeholder="search a name, or paste an asset id"
        spellCheck={false}
        autoComplete="off"
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onChange={(event) => {
          const text = event.target.value;
          // A whole id, pasted or typed: that is the choice.
          if (isAssetId(text.trim().toLowerCase())) {
            choose(text.trim().toLowerCase());
            return;
          }
          setQuery(text);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && matches.length > 0) {
            event.preventDefault();
            setOpen(true);
            setActive((current) => (current + 1) % matches.length);
          } else if (event.key === "ArrowUp" && matches.length > 0) {
            event.preventDefault();
            setActive((current) => (current - 1 + matches.length) % matches.length);
          } else if (event.key === "Enter" && shown) {
            event.preventDefault();
            const pick = matches[active];
            if (pick) choose(pick.asset_id);
          } else if (event.key === "Escape") {
            setOpen(false);
          }
        }}
      />
      {shown && (
        <ul
          id={listId}
          role="listbox"
          className="absolute inset-x-0 top-full z-20 mt-1 max-h-80 overflow-y-auto rounded-md border border-line-strong bg-surface py-1 shadow-[0_8px_24px_rgba(0,0,0,0.45)]"
        >
          {matches.map((asset, index) => (
            <li
              key={asset.asset_id}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              data-testid={`${testId}-option`}
              className={`flex cursor-pointer items-center gap-3 px-3 py-1.5 ${
                index === active ? "bg-accent/[0.08]" : "hover:bg-white/[0.03]"
              }`}
              onMouseEnter={() => setActive(index)}
              // mousedown, before the input's blur closes the list
              onMouseDown={(event) => {
                event.preventDefault();
                choose(asset.asset_id);
              }}
            >
              <Thumb asset={asset} id={asset.asset_id} />
              <span className="flex min-w-0 flex-1 flex-col leading-tight">
                <span className="truncate text-sm">
                  <Name asset={asset} />
                </span>
                <span className="font-data truncate text-[13px] text-neutral-500">
                  {shortId(asset.asset_id)}
                  {asset.finalized ? " · sealed supply" : ""}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {open && needle !== "" && matches.length === 0 && (
        <p className="mt-1.5 text-[13px] text-neutral-500">
          {loading
            ? "Loading the registry's names…"
            : "No asset by that name here. Paste its 64-character id instead."}
        </p>
      )}
    </div>
  );
}

const RANK: Record<string, number> = { envelope: 0, free_text: 1 };
function rank(source: string | null | undefined): number {
  return source ? (RANK[source] ?? 2) : 2;
}
