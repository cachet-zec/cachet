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
/** Rows per page in the two long lists. */
const PAGE_SIZE = 25;

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
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
      <span className="font-data text-xs text-neutral-500">
        page {page + 1} of {pages} · {total} rows
      </span>
      <span className="flex items-center gap-2">
        <button
          type="button"
          className={`${ghostButton} px-3 py-1 text-xs`}
          disabled={page === 0}
          onClick={() => onPage(page - 1)}
        >
          Previous
        </button>
        <button
          type="button"
          className={`${ghostButton} px-3 py-1 text-xs`}
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
  }>({
    paused: false,
    reason: null,
    since: null,
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

      <section className={card} data-testid="admin-pause">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className={cardTitle}>Minting through this instance</h2>
          <span className={pause.paused ? `${stamp} border-red-400/50 text-red-300` : stamp}>
            {pause.paused ? "paused" : "open"}
          </span>
        </div>
        <p className="mt-2 max-w-2xl text-xs leading-relaxed text-neutral-500">
          The switch for a spam wave. Paused, the relay and metadata uploads answer 503 and the mint
          studio says so; nothing else changes, and the chain is never involved. Effective on the
          next request, kept across restarts, reversible here.
          {pause.since && (
            <>
              {" "}
              Last change{" "}
              {new Date(pause.since * 1000).toISOString().slice(0, 19).replace("T", " ")} UTC
              {pause.reason ? ` (${pause.reason})` : ""}.
            </>
          )}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            className={`${input} max-w-xs`}
            value={pauseReason}
            onChange={(event) => setPauseReason(event.target.value)}
            placeholder="reason (optional, kept with the decision)"
          />
          {pause.paused ? (
            <button
              type="button"
              className={ghostButton}
              onClick={() => void setMintsPaused(false)}
            >
              Resume minting
            </button>
          ) : (
            <button
              type="button"
              className={dangerButton}
              onClick={() => void setMintsPaused(true)}
            >
              Pause minting
            </button>
          )}
        </div>
      </section>

      <section className={card}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className={cardTitle}>Assets with content ({assets.length})</h2>
          <input
            className={`${input} max-w-xs`}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setAssetsPage(0);
            }}
            placeholder="filter by name, asset id or issuer"
            spellCheck={false}
          />
        </div>
        <div className="mb-2 flex flex-wrap items-center gap-3 border-b border-white/[0.06] pb-2">
          <label className="flex items-center gap-2 text-xs text-neutral-400">
            <input
              type="checkbox"
              data-testid="admin-select-all"
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
            select the {visibleAssets.length} shown
          </label>
          <button
            type="button"
            data-testid="admin-hide-spam"
            className={`${dangerButton} px-3 py-1 text-xs`}
            disabled={selected.size === 0}
            title="Hide the issuance key of every selected asset with the reason 'spam'. Reversible under Current entries."
            onClick={() => void hideSelectedAsSpam()}
          >
            Hide selected as spam ({selected.size})
          </button>
          <span className="text-xs text-neutral-600">
            A spam wave mints under fresh keys, so hiding the key hides exactly that asset.
          </span>
        </div>
        {matchingAssets.length === 0 && (
          <p className="text-sm text-neutral-500">Nothing matches.</p>
        )}
        <ul className="flex flex-col">
          {visibleAssets.map((asset) => {
            const sha = bundleSha(asset.description);
            const bundleHidden = sha !== null && hiddenBundleKeys.has(sha);
            return (
              <li
                key={asset.asset_id}
                className="flex flex-wrap items-center gap-4 border-b border-white/[0.06] py-2.5 last:border-b-0"
              >
                <input
                  type="checkbox"
                  aria-label={`select ${asset.display_name ?? asset.asset_id.slice(0, 12)}`}
                  checked={selected.has(asset.asset_id)}
                  disabled={!asset.issuer}
                  onChange={(event) => toggleSelected(asset.asset_id, event.target.checked)}
                />
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
                      className="font-display min-w-0 max-w-full truncate text-base text-neutral-100 transition hover:text-[#e8b23a]"
                      title={asset.display_name ?? asset.asset_id}
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
        <Pager
          page={assetsPageClamped}
          pages={assetPages}
          total={matchingAssets.length}
          onPage={setAssetsPage}
        />
      </section>

      <section className={card}>
        <h2 className={`${cardTitle} mb-3`}>Issuers on chain ({issuers.length})</h2>
        <ul className="flex flex-col">
          {visibleIssuers.map((collection) => (
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
        <Pager
          page={issuersPageClamped}
          pages={issuerPages}
          total={issuers.length}
          onPage={setIssuersPage}
        />
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
