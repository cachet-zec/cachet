"use client";

import { useState } from "react";

import Link from "next/link";

import { SealMark } from "@/components/seal-mark";
import { createCachetClient } from "@cachet/api-client";

import { DEFAULT_REGISTRY } from "@/lib/registries";
import { card, dangerButton, input, label, primaryButton, stamp } from "@/lib/ui";

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
/**
 * The operator page is pinned to this build's own API. A visitor may read
 * another registry (lib/registries.ts); an admin token must never follow
 * that choice to somebody else's server.
 */
const apiBaseUrl = DEFAULT_REGISTRY;
const api = createCachetClient({ baseUrl: apiBaseUrl });

/** Rows per page in the two long lists. */
const PAGE_SIZE = 25;

const sectionTitle = "font-display text-2xl font-medium text-neutral-100";

/** Row-sized buttons: the shared ones are sized for a form's main action. */
const smallGhost =
  "rounded-[2px] border border-line-strong px-3 py-1.5 text-sm text-neutral-200 transition " +
  "hover:border-accent/60 hover:text-accent disabled:opacity-40";
const smallDanger =
  "rounded-[2px] border border-red-400/40 px-3 py-1.5 text-sm text-red-300 transition " +
  "hover:border-red-400/70 hover:bg-red-400/10 disabled:opacity-40";

/** Thousands separators without going through Number: a supply can exceed 2^53. */
function formatSupply(value: string | number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function Pager({
  page,
  pages,
  total,
  onPage,
}: {
  page: number;
  pages: number;
  total: number;
  onPage: (page: number) => void;
}) {
  if (pages <= 1) return null;
  return (
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
      <span className="font-data text-[13px] text-neutral-500">
        page {page + 1} of {pages} · {total} rows
      </span>
      <span className="flex items-center gap-2">
        <button
          type="button"
          className={smallGhost}
          disabled={page === 0}
          onClick={() => onPage(page - 1)}
        >
          Previous
        </button>
        <button
          type="button"
          className={smallGhost}
          disabled={page >= pages - 1}
          onClick={() => onPage(page + 1)}
        >
          Next
        </button>
      </span>
    </div>
  );
}

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
  const [pause, setPause] = useState<{
    paused: boolean;
    reason: string | null;
    since: number | null;
    until: number | null;
  }>({
    paused: false,
    reason: null,
    since: null,
    until: null,
  });
  const [pauseReason, setPauseReason] = useState("");
  // Asset ids ticked in the list, for the batch action below.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assetsPage, setAssetsPage] = useState(0);
  const [issuersPage, setIssuersPage] = useState(0);

  async function adminFetch(
    method: "GET" | "POST" | "DELETE" | "PUT",
    body?: unknown,
    route = "/api/v1/admin/moderation",
  ) {
    const response = await fetch(`${apiBaseUrl}${route}`, {
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

  const [refreshing, setRefreshing] = useState(false);

  /** The Refresh button: the same reload the actions run, with feedback. */
  async function reload() {
    setRefreshing(true);
    setStatus(null);
    try {
      await refresh();
      setStatus("Refreshed.");
    } catch (reloadError) {
      setStatus(reloadError instanceof Error ? reloadError.message : String(reloadError));
    } finally {
      setRefreshing(false);
    }
  }

  async function refresh() {
    const listed = await adminFetch("GET");
    setEntries((await listed.json()) as Entry[]);
    const switchState = await adminFetch("GET", undefined, "/api/v1/admin/pause");
    setPause((await switchState.json()) as typeof pause);
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

  async function setMintsPaused(paused: boolean) {
    const question = paused
      ? "Pause minting through this instance? The relay and uploads answer 503 until you resume; the chain is unaffected."
      : "Resume minting through this instance?";
    if (!window.confirm(question)) return;
    setStatus(null);
    try {
      await adminFetch(
        "PUT",
        { paused, reason: pauseReason.trim() ? pauseReason.trim() : undefined },
        "/api/v1/admin/pause",
      );
      setStatus(paused ? "Minting paused. Effective now." : "Minting resumed.");
      await refresh();
    } catch (pauseError) {
      setStatus(pauseError instanceof Error ? pauseError.message : String(pauseError));
    }
  }

  function toggleSelected(assetId: string, on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(assetId);
      else next.delete(assetId);
      return next;
    });
  }

  /**
   * Hide the issuance key of every selected asset with the reason "spam".
   * One confirmation for the batch; keys are deduplicated, and a key that
   * carries more assets than the ones selected is spelled out, since
   * hiding it withholds all of them.
   */
  async function hideSelectedAsSpam() {
    const chosen = assets.filter((asset) => selected.has(asset.asset_id) && asset.issuer);
    const keys = [...new Set(chosen.map((asset) => asset.issuer as string))].filter(
      (issuerKey) => !hiddenIssuerKeys.has(issuerKey),
    );
    if (keys.length === 0) {
      setStatus("Nothing to hide: the selection carries no visible issuer key.");
      return;
    }
    const wider = keys.filter(
      (issuerKey) =>
        (issuers.find((collection) => collection.issuer === issuerKey)?.asset_count ?? 0) >
        chosen.filter((asset) => asset.issuer === issuerKey).length,
    );
    const question =
      `Hide ${keys.length} issuance key${keys.length > 1 ? "s" : ""} as spam? ` +
      `Every asset under them leaves this registry's listings (reversible).` +
      (wider.length > 0
        ? ` ${wider.length} of these keys also carry assets you did not select.`
        : "");
    if (!window.confirm(question)) return;
    setStatus(null);
    let done = 0;
    try {
      for (const issuerKey of keys) {
        await adminFetch("POST", { kind: "issuer", key: issuerKey, reason: "spam" });
        done += 1;
      }
      setStatus(`Hidden ${done} issuer key${done > 1 ? "s" : ""} as spam.`);
    } catch (batchError) {
      setStatus(
        `${done} hidden, then: ${batchError instanceof Error ? batchError.message : String(batchError)}`,
      );
    }
    setSelected(new Set());
    await refresh();
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
  const matchingAssets = needle
    ? assets.filter((asset) =>
        [asset.display_name ?? "", asset.asset_id, asset.issuer ?? ""].some((field) =>
          field.toLowerCase().includes(needle),
        ),
      )
    : assets;
  const assetPages = Math.max(1, Math.ceil(matchingAssets.length / PAGE_SIZE));
  const assetsPageClamped = Math.min(assetsPage, assetPages - 1);
  const visibleAssets = matchingAssets.slice(
    assetsPageClamped * PAGE_SIZE,
    (assetsPageClamped + 1) * PAGE_SIZE,
  );
  const issuerPages = Math.max(1, Math.ceil(issuers.length / PAGE_SIZE));
  const issuersPageClamped = Math.min(issuersPage, issuerPages - 1);
  const visibleIssuers = issuers.slice(
    issuersPageClamped * PAGE_SIZE,
    (issuersPageClamped + 1) * PAGE_SIZE,
  );

  if (!unlocked) {
    return (
      <div className="mx-auto flex max-w-md flex-col pt-14">
        <div className={`${card} flex flex-col gap-4`}>
          <div className="flex items-center gap-3">
            <SealMark size={34} />
            <h1 className="font-display text-3xl font-medium text-neutral-50">Operator</h1>
          </div>
          <p className="text-base leading-relaxed text-neutral-300">
            Paste this instance&apos;s admin token. It stays in this tab&apos;s memory: never
            stored, never in a cookie, gone when the tab closes.
          </p>
          <p className="font-data text-[13px] text-neutral-500">
            Sent only to <span className="text-neutral-300">{new URL(apiBaseUrl).host}</span>
          </p>
          <input
            className={input}
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="admin token"
            autoComplete="off"
            onKeyDown={(event) => {
              if (event.key === "Enter") void unlock();
            }}
          />
          <button
            type="button"
            className={primaryButton}
            disabled={token.trim() === ""}
            onClick={() => void unlock()}
          >
            Unlock
          </button>
          {status && <p className="text-sm text-red-300">{status}</p>}
        </div>
      </div>
    );
  }

  const purgedCount = entries.filter((entry) => entry.bytes_present === false).length;

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-4xl font-medium leading-[1.08] text-neutral-50 sm:text-5xl">
            Operator
          </h1>
          <p className="mt-3 max-w-xl text-base leading-relaxed text-neutral-300">
            What this registry serves, and whether it takes mints. The chain is never touched from
            here.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {status && (
            <span role="status" className="font-data text-sm text-accent">
              {status}
            </span>
          )}
          <button
            type="button"
            data-testid="admin-refresh"
            className={smallGhost}
            disabled={refreshing}
            title="Reload the pause state, the assets, the issuers and the moderation entries."
            onClick={() => void reload()}
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      {/* The state of the instance, before any list. */}
      <dl className="grid grid-cols-2 lg:grid-cols-4">
        {[
          {
            label: "Minting",
            value: pause.paused ? "Paused" : "Open",
            tone: pause.paused ? "text-red-300" : "text-emerald-300",
          },
          { label: "Assets with content", value: assets.length.toLocaleString("en-US") },
          { label: "Issuers on chain", value: issuers.length.toLocaleString("en-US") },
          {
            label: "Hidden entries",
            value: entries.length.toLocaleString("en-US"),
            detail: purgedCount > 0 ? `${purgedCount} purged` : undefined,
          },
        ].map((figure) => (
          <div
            key={figure.label}
            className="border-line py-5 pr-4 max-lg:even:border-l max-lg:even:pl-6 max-lg:[&:nth-child(n+3)]:border-t lg:border-l lg:pl-6 lg:first:border-l-0 lg:first:pl-0"
          >
            <dt className="font-data text-sm text-neutral-400">{figure.label}</dt>
            <dd
              className={`font-display mt-1.5 text-4xl font-medium leading-none tabular-nums ${
                figure.tone ?? "text-neutral-50"
              }`}
            >
              {figure.value}
            </dd>
            {figure.detail && (
              <dd className="font-data mt-1.5 text-[13px] text-red-300">{figure.detail}</dd>
            )}
          </div>
        ))}
      </dl>

      <section
        data-testid="admin-pause"
        className={`${card} ${pause.paused ? "border-red-400/40" : ""}`}
      >
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] lg:gap-10">
          <div>
            <div className="flex flex-wrap items-center gap-3">
              <h2 className={sectionTitle}>Minting through this instance</h2>
              <span
                className={
                  pause.paused
                    ? "rounded-full border border-red-400/50 px-3 py-0.5 font-data text-[13px] text-red-300"
                    : "rounded-full border border-emerald-400/40 px-3 py-0.5 font-data text-[13px] text-emerald-300"
                }
              >
                {pause.paused ? "paused" : "open"}
              </span>
            </div>
            <p className="mt-2.5 max-w-prose text-base leading-relaxed text-neutral-300">
              The switch for a spam wave. Paused, the relay and the uploads answer 503 and the mint
              page says so. Nothing else changes, and it applies from the next request.
            </p>
            <p className="font-data mt-3 text-[13px] leading-relaxed text-neutral-500">
              {pause.until && (
                <>
                  Automatic pause, reopens at{" "}
                  {new Date(pause.until * 1000).toISOString().slice(11, 16)} UTC.{" "}
                </>
              )}
              {pause.since ? (
                <>
                  Last change{" "}
                  {new Date(pause.since * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC
                  {pause.reason ? ` · ${pause.reason}` : ""}
                </>
              ) : (
                "Never changed on this instance."
              )}
            </p>
          </div>
          <div className="flex flex-col justify-end gap-2.5">
            <label className={label} htmlFor="admin-pause-reason">
              Reason <span className="font-normal text-neutral-500">· optional, kept with it</span>
            </label>
            <input
              id="admin-pause-reason"
              className={input}
              value={pauseReason}
              onChange={(event) => setPauseReason(event.target.value)}
              placeholder="spam wave, maintenance…"
            />
            {pause.paused ? (
              <button
                type="button"
                className={primaryButton}
                onClick={() => void setMintsPaused(false)}
              >
                Resume minting
              </button>
            ) : (
              <button
                type="button"
                className={`${dangerButton} rounded-[2px] py-3 text-base`}
                onClick={() => void setMintsPaused(true)}
              >
                Pause minting
              </button>
            )}
          </div>
        </div>
      </section>

      <section>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className={sectionTitle}>Assets with content</h2>
            <p className="mt-1.5 max-w-prose text-base text-neutral-400">
              What a moderator looks at: assets carrying a name or an image. Hiding is reversible
              below; purging deletes the bytes from this disk.
            </p>
          </div>
          <input
            className={`${input} sm:max-w-xs`}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setAssetsPage(0);
            }}
            placeholder="filter by name, asset id or issuer"
            spellCheck={false}
          />
        </div>

        {/* The batch action lives with the selection it acts on. */}
        <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[3px] bg-surface px-3 py-2.5">
          <label className="flex cursor-pointer items-center gap-2.5 text-sm text-neutral-300">
            <input
              type="checkbox"
              data-testid="admin-select-all"
              className="accent-[var(--color-accent)]"
              checked={
                visibleAssets.length > 0 &&
                visibleAssets.every((asset) => selected.has(asset.asset_id))
              }
              onChange={(event) =>
                setSelected(
                  event.target.checked
                    ? new Set(visibleAssets.map((asset) => asset.asset_id))
                    : new Set(),
                )
              }
            />
            Select the {visibleAssets.length} shown
          </label>
          <button
            type="button"
            data-testid="admin-hide-spam"
            className={smallDanger}
            disabled={selected.size === 0}
            title="Hide the issuance key of every selected asset with the reason 'spam'. Reversible under Hidden on this instance."
            onClick={() => void hideSelectedAsSpam()}
          >
            Hide selected as spam ({selected.size})
          </button>
          <span className="text-[13px] text-neutral-500">
            A spam wave mints under fresh keys, so hiding the key hides exactly that asset.
          </span>
        </div>

        {matchingAssets.length === 0 && (
          <p className="py-6 text-base text-neutral-400">Nothing matches.</p>
        )}
        <ul>
          {visibleAssets.map((asset) => {
            const sha = bundleSha(asset.description);
            const bundleHidden = sha !== null && hiddenBundleKeys.has(sha);
            const isSelected = selected.has(asset.asset_id);
            return (
              <li
                key={asset.asset_id}
                className={`flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-line px-3 py-3 transition last:border-b-0 ${
                  isSelected ? "bg-accent/[0.06]" : "hover:bg-white/[0.02]"
                }`}
              >
                <input
                  type="checkbox"
                  className="accent-[var(--color-accent)]"
                  aria-label={`select ${asset.display_name ?? asset.asset_id.slice(0, 12)}`}
                  checked={isSelected}
                  disabled={!asset.issuer}
                  onChange={(event) => toggleSelected(asset.asset_id, event.target.checked)}
                />
                {asset.image_path ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={apiBaseUrl + asset.image_path}
                    alt=""
                    className="h-14 w-14 shrink-0 border border-line-strong bg-ground object-cover"
                  />
                ) : (
                  <div className="font-data flex h-14 w-14 shrink-0 items-center justify-center border border-line text-base text-neutral-500">
                    {asset.asset_id.slice(0, 2)}
                  </div>
                )}
                <div className="min-w-0 flex-1 basis-56">
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                    <Link
                      href={`/assets/${asset.asset_id}`}
                      target="_blank"
                      className="min-w-0 max-w-full truncate text-[17px] text-neutral-100 transition hover:text-accent"
                      title={asset.display_name ?? asset.asset_id}
                    >
                      {asset.display_name ?? asset.asset_id.slice(0, 16)}
                    </Link>
                    {asset.finalized && <span className={stamp}>sealed</span>}
                    {bundleHidden && (
                      <span className="rounded-full border border-red-400/50 px-3 py-0.5 font-data text-[13px] text-red-300">
                        {sha !== null && purgedBundleKeys.has(sha)
                          ? "bundle purged"
                          : "bundle hidden"}
                      </span>
                    )}
                  </div>
                  <div className="font-data mt-1 truncate text-[13px] text-neutral-500">
                    supply {formatSupply(asset.total_supply)} ·{" "}
                    <span title={asset.asset_id}>{asset.asset_id.slice(0, 16)}&hellip;</span>
                    {asset.issuer && (
                      <span title={asset.issuer}>
                        {" "}
                        · issuer {asset.issuer.slice(0, 12)}&hellip;
                      </span>
                    )}
                  </div>
                </div>
                <span className="flex flex-wrap items-center gap-2">
                  {sha && !bundleHidden && (
                    <button
                      type="button"
                      className={smallGhost}
                      title="Withhold this asset's bundle: description and image answer 410. The chain record and the name stay."
                      onClick={() => void hide("bundle", sha, asset.display_name ?? undefined)}
                    >
                      Hide bundle
                    </button>
                  )}
                  {asset.issuer && !hiddenIssuerKeys.has(asset.issuer) && (
                    <button
                      type="button"
                      className={smallGhost}
                      title="Withhold every asset of this issuance key from listings."
                      onClick={() => void hide("issuer", asset.issuer as string)}
                    >
                      Hide issuer
                    </button>
                  )}
                  {sha && !purgedBundleKeys.has(sha) && (
                    <button
                      type="button"
                      className={smallDanger}
                      title="Delete this asset's bundle bytes from this registry's disk. Irreversible here; the chain record stays."
                      onClick={() => purge(sha, asset.display_name)}
                    >
                      Purge
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
        <Pager
          page={assetsPageClamped}
          pages={assetPages}
          total={matchingAssets.length}
          onPage={setAssetsPage}
        />
      </section>

      <div className="grid gap-8 lg:grid-cols-2 lg:gap-12">
        <section>
          <h2 className={sectionTitle}>Issuers on chain</h2>
          <p className="mt-1.5 text-base text-neutral-400">
            Hiding a key withholds every asset minted under it.
          </p>
          <ul className="mt-3">
            {visibleIssuers.map((collection) => (
              <li
                key={collection.issuer}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line py-3 last:border-b-0"
              >
                <span className="min-w-0">
                  <Link
                    href={`/issuers/${collection.issuer}`}
                    target="_blank"
                    className="font-data block truncate text-sm text-neutral-200 transition hover:text-accent"
                    title={collection.issuer}
                  >
                    {collection.issuer.slice(0, 22)}&hellip;
                  </Link>
                  <span className="font-data text-[13px] text-neutral-500">
                    {collection.asset_count} {collection.asset_count === 1 ? "asset" : "assets"}
                  </span>
                </span>
                {hiddenIssuerKeys.has(collection.issuer) ? (
                  <span className="rounded-full border border-red-400/50 px-3 py-0.5 font-data text-[13px] text-red-300">
                    hidden
                  </span>
                ) : (
                  <button
                    type="button"
                    className={smallGhost}
                    onClick={() => void hide("issuer", collection.issuer)}
                  >
                    Hide issuer
                  </button>
                )}
              </li>
            ))}
          </ul>
          <Pager
            page={issuersPageClamped}
            pages={issuerPages}
            total={issuers.length}
            onPage={setIssuersPage}
          />
        </section>

        <section>
          <h2 className={sectionTitle}>Hide by key</h2>
          <p className="mt-1.5 text-base text-neutral-400">
            For what the lists above do not show, such as an unresolved asset.
          </p>
          <div className="mt-5 flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <span className={label}>Kind</span>
              {/* Three known choices deserve three visible states. */}
              <div
                role="radiogroup"
                aria-label="Moderation kind"
                className="grid grid-cols-3 overflow-hidden rounded-[2px] border border-line"
              >
                {[
                  { value: "issuer", title: "Issuer", hint: "validating key" },
                  { value: "bundle", title: "Bundle", hint: "sha-256" },
                  { value: "description", title: "Description", hint: "asset id" },
                ].map((option, index) => (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={kind === option.value}
                    onClick={() => setKind(option.value)}
                    className={`flex flex-col items-start px-3.5 py-2.5 text-left transition ${
                      index > 0 ? "border-l border-line" : ""
                    } ${
                      kind === option.value
                        ? "bg-accent/[0.08] text-accent"
                        : "text-neutral-300 hover:bg-white/[0.03]"
                    }`}
                  >
                    <span className="text-sm font-medium">{option.title}</span>
                    <span
                      className={`font-data text-[13px] ${
                        kind === option.value ? "text-accent/80" : "text-neutral-500"
                      }`}
                    >
                      {option.hint}
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className={label} htmlFor="admin-key">
                Key <span className="font-normal text-neutral-500">· hex</span>
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
            <div className="flex flex-col gap-1.5">
              <label className={label} htmlFor="admin-reason">
                Reason <span className="font-normal text-neutral-500">· stored with the entry</span>
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
              className={`${dangerButton} self-start rounded-[2px]`}
              onClick={() => void hide(kind, key.trim(), reason)}
              disabled={key.trim() === ""}
            >
              Hide
            </button>
          </div>
        </section>
      </div>

      <section>
        <h2 className={sectionTitle}>Hidden on this instance</h2>
        <p className="mt-1.5 max-w-prose text-base text-neutral-400">
          Listings, bundles and images of these answer 410 here. Any other registry can still serve
          them: a registry can withhold, it can never lie.
        </p>
        {entries.length === 0 ? (
          <p className="mt-5 text-base text-neutral-400">Nothing is hidden on this instance.</p>
        ) : (
          <ul className="mt-3">
            {entries.map((entry) => (
              <li
                key={`${entry.kind}-${entry.key}`}
                className="grid items-center gap-x-6 gap-y-2 border-b border-line py-3 last:border-b-0 sm:grid-cols-[7rem_minmax(0,1fr)_auto]"
              >
                <span className={`${stamp} w-fit`}>{entry.kind}</span>
                <span className="min-w-0">
                  <span className="font-data block break-all text-sm text-neutral-200">
                    {entry.key}
                  </span>
                  <span className="font-data text-[13px] text-neutral-500">
                    {entry.reason ?? "no reason given"}
                    {entry.bytes_present === false && (
                      <span className="text-red-300"> · bytes purged</span>
                    )}
                  </span>
                </span>
                <button type="button" className={smallGhost} onClick={() => void unhide(entry)}>
                  Unhide
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
