"use client";

import { useState } from "react";

import Link from "next/link";

import { api, apiBaseUrl } from "@/lib/api";
import { card, cardTitle, dangerButton, ghostButton, input, label, stamp } from "@/lib/ui";

type Entry = {
  kind: string;
  key: string;
  reason: string | null;
  hidden_at: string;
  bytes_present: boolean | null;
};
type Collection = { issuer: string; asset_count: number; total_supply: string | number };
type Asset = {
  asset_id: string;
  display_name: string | null;
  issuer: string | null;
  total_supply: string | number;
  finalized: boolean;
  image_path: string | null;
  description: string | null;
};

/** The bundle a Cachet envelope points at, or null for any other description. */
function bundleSha(description: string | null): string | null {
  if (!description) return null;
  try {
    const envelope = JSON.parse(description) as { sha256?: unknown };
    return typeof envelope.sha256 === "string" ? envelope.sha256.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Operator moderation console. The token lives in component state only —
 * never storage, never a cookie — and is pasted each session. Every call
 * goes to the instance's token-gated admin API, which answers 404 unless
 * CACHET_ADMIN_TOKEN is configured server-side. Availability-only, like
 * the CLI it mirrors: hide/unhide, never alter.
 */
export function AdminPanel() {
  const [token, setToken] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [issuers, setIssuers] = useState<Collection[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  const [kind, setKind] = useState("issuer");
  const [key, setKey] = useState("");
  const [reason, setReason] = useState("");

  async function adminFetch(method: "GET" | "POST" | "DELETE", body?: unknown) {
    const response = await fetch(`${apiBaseUrl}/api/v1/admin/moderation`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.status === 404) {
      throw new Error("Admin surface disabled on this instance, or wrong token.");
    }
    if (!response.ok) {
      throw new Error(`Admin call failed (${response.status}).`);
    }
    return response;
  }

  async function refresh() {
    const listed = await adminFetch("GET");
    setEntries((await listed.json()) as Entry[]);
    const collections = await api.GET("/api/v1/collections");
    setIssuers((collections.data ?? []) as Collection[]);
    // What a moderator actually looks at: the assets carrying content
    // (a name, an image). Unresolved script mints are hex and nothing
    // else; they stay reachable through "hide by key".
    const resolved = await api.GET("/api/v1/assets", { params: { query: { resolved: true } } });
    setAssets((resolved.data ?? []) as Asset[]);
  }

  async function unlock() {
    setStatus(null);
    try {
      await refresh();
      setUnlocked(true);
    } catch (unlockError) {
      setStatus(unlockError instanceof Error ? unlockError.message : String(unlockError));
    }
  }

  async function hide(hideKind: string, hideKey: string, hideReason?: string, purge = false) {
    setStatus(null);
    try {
      await adminFetch("POST", {
        kind: hideKind,
        key: hideKey,
        reason: hideReason?.trim() ? hideReason.trim() : undefined,
        purge,
      });
      setStatus(`${purge ? "Purged" : "Hidden"} ${hideKind} ${hideKey.slice(0, 12)}…`);
      await refresh();
    } catch (hideError) {
      setStatus(hideError instanceof Error ? hideError.message : String(hideError));
    }
  }

  async function unhide(entry: Entry) {
    setStatus(null);
    try {
      await adminFetch("DELETE", { kind: entry.kind, key: entry.key });
      setStatus(`Unhidden ${entry.kind} ${entry.key.slice(0, 12)}…`);
      await refresh();
    } catch (unhideError) {
      setStatus(unhideError instanceof Error ? unhideError.message : String(unhideError));
    }
  }

  const hiddenIssuerKeys = new Set(
    entries.filter((entry) => entry.kind === "issuer").map((entry) => entry.key),
  );
  const hiddenBundleKeys = new Set(
    entries.filter((entry) => entry.kind === "bundle").map((entry) => entry.key.toLowerCase()),
  );
  const purgedBundleKeys = new Set(
    entries
      .filter((entry) => entry.kind === "bundle" && entry.bytes_present === false)
      .map((entry) => entry.key.toLowerCase()),
  );

  /** Purge is the one irreversible action here: say so before doing it. */
  function purge(sha: string, name: string | null) {
    const confirmed = window.confirm(
      `Purge the bytes of "${name ?? sha.slice(0, 12)}" from this registry?\n\n` +
        "The description and image are deleted from disk, not just withheld. The chain record, " +
        "the on-chain name and the hash stay; the same bytes are refused if uploaded again. " +
        "Daily backups keep a copy for up to 7 days.",
    );
    if (confirmed) void hide("bundle", sha, "purged", true);
  }
  const needle = search.trim().toLowerCase();
  const visibleAssets = needle
    ? assets.filter((asset) =>
        [asset.display_name ?? "", asset.asset_id, asset.issuer ?? ""].some((field) =>
          field.toLowerCase().includes(needle),
        ),
      )
    : assets;

  if (!unlocked) {
    return (
      <div className="mx-auto flex max-w-md flex-col gap-4 pt-16">
        <h1 className="font-display text-2xl font-semibold text-neutral-100">Operator</h1>
        <p className="text-sm text-neutral-500">Paste your admin token.</p>
        <input
          className={input}
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="admin token"
          onKeyDown={(event) => {
            if (event.key === "Enter") void unlock();
          }}
        />
        <button type="button" className={ghostButton} onClick={() => void unlock()}>
          Unlock
        </button>
        {status && <p className="text-sm text-red-400">{status}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <h1 className="font-display text-2xl font-semibold text-neutral-100">Operator moderation</h1>
      <p className="max-w-2xl text-sm text-neutral-500">
        Hiding withholds distribution on THIS registry (listings, bundles, images answer 410) and is
        reversible. Purging also deletes a bundle&apos;s bytes from disk, for content an operator
        must not keep; the entry stays so the bytes cannot return. Either way the chain record is
        untouched and any other registry can keep serving the identical content. A registry can
        withhold; it can never lie.
      </p>
      {status && <p className="text-sm text-[#e8b23a]">{status}</p>}

      <section className={card}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className={cardTitle}>Assets with content ({assets.length})</h2>
          <input
            className={`${input} max-w-xs`}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="filter by name, asset id or issuer"
            spellCheck={false}
          />
        </div>
        {visibleAssets.length === 0 && <p className="text-sm text-neutral-500">Nothing matches.</p>}
        <ul className="flex flex-col">
          {visibleAssets.map((asset) => {
            const sha = bundleSha(asset.description);
            const bundleHidden = sha !== null && hiddenBundleKeys.has(sha);
            return (
              <li
                key={asset.asset_id}
                className="flex flex-wrap items-center gap-4 border-b border-white/[0.06] py-2.5 last:border-b-0"
              >
                {asset.image_path ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={apiBaseUrl + asset.image_path}
                    alt=""
                    className="h-12 w-12 shrink-0 rounded-sm border border-white/10 object-cover"
                  />
                ) : (
                  <div className="font-data flex h-12 w-12 shrink-0 items-center justify-center rounded-sm border border-white/10 text-sm text-neutral-600">
                    {asset.asset_id.slice(0, 2)}
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <Link
                      href={`/assets/${asset.asset_id}`}
                      target="_blank"
                      className="font-display text-base text-neutral-100 transition hover:text-[#e8b23a]"
                    >
                      {asset.display_name ?? asset.asset_id.slice(0, 16)}
                    </Link>
                    <span className="font-data text-xs text-neutral-500">
                      supply {String(asset.total_supply)}
                    </span>
                    {asset.finalized && <span className={stamp}>sealed</span>}
                    {bundleHidden && (
                      <span className="font-data text-xs text-red-300">
                        {sha !== null && purgedBundleKeys.has(sha)
                          ? "bundle purged"
                          : "bundle hidden"}
                      </span>
                    )}
                  </div>
                  <div className="font-data mt-0.5 truncate text-[11px] text-neutral-600">
                    <span title={asset.asset_id}>{asset.asset_id.slice(0, 20)}&hellip;</span>
                    {asset.issuer && (
                      <span title={asset.issuer}>
                        {" "}
                        &middot; issuer {asset.issuer.slice(0, 14)}&hellip;
                      </span>
                    )}
                  </div>
                </div>
                <span className="flex items-center gap-2">
                  {sha && !bundleHidden && (
                    <button
                      type="button"
                      className={`${dangerButton} px-3 py-1 text-xs`}
                      title="Withhold this asset's bundle: description and image answer 410. The chain record and the name stay."
                      onClick={() => void hide("bundle", sha, asset.display_name ?? undefined)}
                    >
                      Hide bundle
                    </button>
                  )}
                  {sha && !purgedBundleKeys.has(sha) && (
                    <button
                      type="button"
                      className={`${dangerButton} px-3 py-1 text-xs`}
                      title="Delete this asset's bundle bytes from this registry's disk. Irreversible here; the chain record stays."
                      onClick={() => purge(sha, asset.display_name)}
                    >
                      Purge
                    </button>
                  )}
                  {asset.issuer && !hiddenIssuerKeys.has(asset.issuer) && (
                    <button
                      type="button"
                      className={`${ghostButton} px-3 py-1 text-xs`}
                      title="Withhold every asset of this issuance key from listings."
                      onClick={() => void hide("issuer", asset.issuer as string)}
                    >
                      Hide issuer
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </section>

      <section className={card}>
        <h2 className={`${cardTitle} mb-3`}>Issuers on chain</h2>
        <ul className="flex flex-col">
          {issuers.map((collection) => (
            <li
              key={collection.issuer}
              className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] py-2 last:border-b-0"
            >
              <span className="font-data text-xs text-neutral-300" title={collection.issuer}>
                {collection.issuer.slice(0, 24)}&hellip;
              </span>
              <span className="flex items-center gap-3">
                <span className="font-data text-xs text-neutral-500">
                  {collection.asset_count} assets
                </span>
                {hiddenIssuerKeys.has(collection.issuer) ? (
                  <span className="font-data text-xs text-red-300">hidden</span>
                ) : (
                  <button
                    type="button"
                    className={`${dangerButton} px-3 py-1 text-xs`}
                    onClick={() => void hide("issuer", collection.issuer)}
                  >
                    Hide issuer
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className={card}>
        <h2 className={`${cardTitle} mb-3`}>Hide by key</h2>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <span className={label}>Kind</span>
            {/* Segmented control instead of a native select: three known
                choices deserve three visible states, in the site's own
                language — no OS popup to fight. */}
            <div
              role="radiogroup"
              aria-label="Moderation kind"
              className="flex w-fit overflow-hidden rounded-md border border-white/10 bg-black/30 shadow-[inset_0_1px_2px_rgba(0,0,0,0.35)]"
            >
              {[
                { value: "issuer", title: "issuer", hint: "validating key" },
                { value: "bundle", title: "bundle", hint: "sha-256" },
                { value: "description", title: "description", hint: "asset id" },
              ].map((option, index) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={kind === option.value}
                  onClick={() => setKind(option.value)}
                  className={`flex flex-col items-start px-4 py-2 text-left transition ${
                    index > 0 ? "border-l border-white/[0.07]" : ""
                  } ${
                    kind === option.value
                      ? "bg-[#e8b23a]/[0.08] text-[#e8b23a]"
                      : "text-neutral-400 hover:bg-white/[0.03] hover:text-neutral-200"
                  }`}
                >
                  <span className="font-data text-[13px]">{option.title}</span>
                  <span
                    className={`font-data text-[10px] uppercase tracking-[0.14em] ${
                      kind === option.value ? "text-[#e8b23a]/60" : "text-neutral-600"
                    }`}
                  >
                    {option.hint}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <label className={label} htmlFor="admin-key">
              Key · hex
            </label>
            <input
              id="admin-key"
              className={input}
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder="issuer key, bundle sha256 or asset id"
              spellCheck={false}
            />
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <label className={label} htmlFor="admin-reason">
                Reason · stored with the entry
              </label>
              <input
                id="admin-reason"
                className={input}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="optional"
              />
            </div>
            <button
              type="button"
              className={dangerButton}
              onClick={() => void hide(kind, key.trim(), reason)}
              disabled={key.trim() === ""}
            >
              Hide
            </button>
          </div>
        </div>
      </section>

      <section className={card}>
        <h2 className={`${cardTitle} mb-3`}>Current entries ({entries.length})</h2>
        {entries.length === 0 && (
          <p className="text-sm text-neutral-500">Nothing is hidden on this instance.</p>
        )}
        <ul className="flex flex-col">
          {entries.map((entry) => (
            <li
              key={`${entry.kind}-${entry.key}`}
              className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.06] py-2 last:border-b-0"
            >
              <span className="min-w-0">
                <span className="font-data mr-2 text-[10px] uppercase tracking-[0.14em] text-neutral-500">
                  {entry.kind}
                </span>
                <span className="font-data break-all text-xs text-neutral-300">{entry.key}</span>
                {entry.reason && (
                  <span className="ml-2 text-xs italic text-neutral-500">{entry.reason}</span>
                )}
                {entry.bytes_present === false && (
                  <span className="font-data ml-2 text-[10px] uppercase tracking-[0.14em] text-red-300">
                    purged
                  </span>
                )}
              </span>
              <button
                type="button"
                className={`${ghostButton} px-3 py-1 text-xs`}
                onClick={() => void unhide(entry)}
              >
                Unhide
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
