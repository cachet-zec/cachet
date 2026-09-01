"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";

import { AssetEvents } from "@/components/asset-events";
import { Zmd1Manifest } from "@/components/zmd1-manifest";
import { CopyButton } from "@/components/copy-button";
import { api, apiBaseUrl, problemMessage } from "@/lib/api";
import { safeExternalHref } from "@/lib/safe-href";
import { deriveAssetId } from "@/lib/verify-engine";
import { card, cardTitle, ghostButton, input, stamp, stampNotable } from "@/lib/ui";

/** The v1 on-chain metadata envelope (see packages/registry-spec). */
interface Envelope {
  v: number;
  name: string;
  sha256: string;
}

function parseEnvelope(description: string | null | undefined): Envelope | null {
  if (!description) return null;
  try {
    const parsed = JSON.parse(description) as Envelope;
    return parsed.v === 1 && typeof parsed.sha256 === "string" && parsed.sha256.length === 64
      ? parsed
      : null;
  } catch {
    return null;
  }
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Fetch the metadata bundle and verify it against the on-chain commitment,
 * entirely client-side: the registry is never trusted for integrity.
 */
function useVerifiedBundle(envelope: Envelope | null) {
  return useQuery({
    queryKey: ["bundle", envelope?.sha256],
    enabled: envelope !== null,
    queryFn: async () => {
      const response = await fetch(`${apiBaseUrl}/api/v1/metadata/${envelope!.sha256}`);
      if (!response.ok) {
        throw new Error(
          response.status === 410
            ? "hidden by this registry's operator"
            : "metadata bundle unavailable",
        );
      }
      const bytes = await response.arrayBuffer();
      const computed = await sha256Hex(bytes);
      const bundle = JSON.parse(new TextDecoder().decode(bytes)) as {
        name?: string;
        description?: string;
        image_data_uri?: string;
        external_url?: string;
      };
      return { bundle, verified: computed === envelope!.sha256 };
    },
  });
}

/**
 * Recompute the asset id from the issuer key and description served for it.
 *
 * This is the check that makes the page trustless rather than merely
 * self-consistent: a registry can serve any description it likes, but it
 * cannot serve one that derives the asset id the reader asked for unless it
 * is the real one. Applies to every asset with a description, whatever the
 * format - envelope, ZMD-1 or free text.
 */
function useDerivedIdentity(assetId: string, issuer?: string | null, description?: string | null) {
  return useQuery({
    queryKey: ["identity", assetId, description],
    enabled: Boolean(issuer && description),
    retry: false,
    queryFn: async () => {
      const derived = await deriveAssetId(issuer!, description!);
      return { derived, matches: derived === assetId.toLowerCase() };
    },
  });
}

/** The strongest statement the completed checks actually support. */
function verificationBadge(
  identity: { matches: boolean } | undefined,
  bundle: { verified: boolean } | undefined,
  hasEnvelope: boolean,
) {
  // Failures first, and an identity failure outranks: a description that
  // does not derive the asset id makes everything under it moot.
  if (identity && !identity.matches) {
    return {
      ok: false,
      label: "✗ asset id mismatch",
      title:
        "The description served for this asset does not derive its asset id. " +
        "Do not trust the name shown.",
    };
  }
  if (bundle && !bundle.verified) {
    return {
      ok: false,
      label: "✗ metadata hash mismatch",
      title: "The bundle served does not hash to the commitment in the on-chain description.",
    };
  }
  if (identity?.matches && hasEnvelope && bundle?.verified) {
    return {
      ok: true,
      label: "✓ fully verified in your browser",
      title:
        "Checked on your machine: the description derives this asset id (ZIP 227), and the " +
        "metadata bundle hashes to the commitment inside it. Nothing was taken on trust " +
        "from the registry.",
    };
  }
  if (identity?.matches) {
    return {
      ok: true,
      label: "✓ description verified in your browser",
      title:
        "The description served derives this asset id (ZIP 227), so it is the one the " +
        "chain committed to.",
    };
  }
  if (hasEnvelope && bundle?.verified) {
    return {
      ok: true,
      label: "✓ metadata verified in your browser",
      title:
        "The bundle hashes to the commitment in the description. The description itself " +
        "could not be re-derived here.",
    };
  }
  return null;
}

/**
 * The sealed image, thumbnail first, full size on demand.
 *
 * The bytes on screen are the bytes the chain committed to (transitively,
 * through the bundle hash), so showing them at 96 px only would undersell
 * the guarantee. Click or Escape closes.
 */
function SealedImage({ src }: { src: string }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        data-testid="asset-image-open"
        title="View the sealed image full size"
        className="group shrink-0 cursor-zoom-in"
        onClick={() => setOpen(true)}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt=""
          className="h-24 w-24 rounded-sm border border-white/10 object-cover transition group-hover:border-[#e8b23a]/60"
        />
      </button>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          data-testid="asset-image-lightbox"
          className="fixed inset-0 z-50 flex cursor-zoom-out flex-col items-center justify-center gap-3 bg-black/90 p-8 backdrop-blur-md"
          onClick={() => setOpen(false)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {/* Height budget: viewport minus the caption, the gaps and the
              padding - so image + caption always fit together, navbar
              included. Width capped so a square never wall-to-walls. */}
          <img
            src={src}
            alt=""
            className="max-h-[calc(100vh-9rem)] max-w-[min(88vw,52rem)] rounded-md border border-white/15 object-contain shadow-[0_8px_40px_rgba(0,0,0,0.6)]"
          />
          <p className="font-data text-[11px] uppercase tracking-[0.16em] text-neutral-500">
            sealed with the asset · click anywhere to close
          </p>
        </div>
      )}
    </>
  );
}

export function AssetDetail({ assetId }: { assetId: string }) {
  const state = useQuery({
    queryKey: ["asset", assetId],
    queryFn: async () => {
      const { data, error } = await api.GET("/api/v1/assets/{asset_id}", {
        params: { path: { asset_id: assetId } },
      });
      if (error) throw new Error(error.detail);
      return data;
    },
  });

  const envelope = parseEnvelope(state.data?.description);
  const verification = useVerifiedBundle(envelope);
  const identity = useDerivedIdentity(assetId, state.data?.issuer, state.data?.description);
  const badge = verificationBadge(identity.data, verification.data, envelope !== null);

  // Plain free-text descriptions (pre-metadata assets) can be long: keep
  // the title short and leave the full text to the on-chain field below.
  const rawName = state.data?.display_name ?? null;
  const displayName =
    rawName && rawName.length > 60 ? `${rawName.slice(0, 57).trimEnd()}…` : rawName;
  const nameSource = state.data?.name_source ?? null;

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href="/console"
        className="font-data text-[13px] text-neutral-400 transition hover:text-[#e8b23a]"
      >
        ← Back to console
      </Link>

      {state.isError && (
        <div className={`${card} mt-4`}>
          <p className="text-sm text-red-400">
            Asset not found on this chain: {state.error.message}
          </p>
        </div>
      )}

      {state.data && (
        <div className={`${card} mt-4`}>
          <div className="flex flex-wrap items-start gap-5">
            {state.data.image_path ? (
              <SealedImage src={apiBaseUrl + state.data.image_path} />
            ) : (
              <div className="font-data flex h-24 w-24 items-center justify-center rounded-sm border border-white/10 text-lg text-neutral-600">
                {assetId.slice(0, 2)}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <h1
                className={
                  nameSource === "free_text"
                    ? "font-display text-2xl font-semibold italic tracking-tight text-neutral-300"
                    : "font-display text-2xl font-semibold tracking-tight text-neutral-50"
                }
              >
                {displayName ?? <span className="italic text-neutral-500">Unresolved asset</span>}
              </h1>
              <p className="font-data mt-1.5 text-sm text-neutral-400">
                supply{" "}
                <span className="text-[#e8b23a]">
                  {state.data.total_supply.toLocaleString("en-US")}
                </span>
              </p>
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                {state.data.finalized ? (
                  <span
                    className={`${stamp} -rotate-1`}
                    title="Finalized: consensus refuses further units, from anyone including the issuer. Holders can still burn what they hold, so the supply can fall but never rise."
                  >
                    sealed forever
                  </span>
                ) : (
                  // Stated, not left to the absence of a stamp: whoever
                  // holds this asset can be diluted, and that is a fact
                  // about the chain, not an opinion about the issuer.
                  <span
                    className={stampNotable}
                    title="Not finalized: the issuance key that minted this asset can still issue more units of it. The metadata cannot change - only the supply."
                  >
                    issuer can mint more
                  </span>
                )}
                {nameSource === "zmd1" && (
                  <span
                    className={stamp}
                    title="ZMD-1 descriptor: an on-chain machine identifier issued by a third party"
                  >
                    zmd-1 descriptor
                  </span>
                )}
                {nameSource === "free_text" && (
                  <span className={stamp} title="Issuer-chosen free text; not a verified name">
                    unverified label
                  </span>
                )}
                {badge && (
                  <span
                    data-testid="verification-badge"
                    title={badge.title}
                    className={
                      badge.ok
                        ? "rounded-sm border border-emerald-400/40 px-1.5 py-0.5 font-data text-[10px] uppercase tracking-[0.14em] text-emerald-300"
                        : "rounded-sm border border-red-400/50 px-1.5 py-0.5 font-data text-[10px] uppercase tracking-[0.14em] text-red-300"
                    }
                  >
                    {badge.label}
                  </span>
                )}
                {envelope && verification.isError && (
                  <span className={stamp}>{verification.error.message}</span>
                )}
              </div>
            </div>
          </div>

          {/* Bundle content renders ONLY once the hash check passed: a
              registry that fails its own commitment gets a red badge, not
              a voice. The link is additionally scheme-allowlisted. */}
          {verification.data?.verified && verification.data.bundle.description && (
            <p className="mt-5 whitespace-pre-wrap text-sm leading-relaxed text-neutral-300">
              {verification.data.bundle.description}
            </p>
          )}
          {verification.data?.verified &&
            verification.data.bundle.external_url &&
            safeExternalHref(verification.data.bundle.external_url) && (
              <a
                href={safeExternalHref(verification.data.bundle.external_url)!}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-block text-sm text-[#e8b23a]/90 underline decoration-[#e8b23a]/30 transition hover:text-[#e8b23a]"
              >
                {verification.data.bundle.external_url}
              </a>
            )}

          <dl className="mt-6 flex flex-col gap-3 border-t border-white/[0.07] pt-5">
            <div>
              <dt className={cardTitle}>Asset id</dt>
              <dd className="mt-1 flex items-center gap-2">
                <span className="font-data break-all text-xs text-neutral-300">{assetId}</span>
                <CopyButton value={assetId} />
              </dd>
            </div>
            {state.data.issuer && (
              <div>
                <dt className={cardTitle}>Issuer (issuance validating key)</dt>
                <dd className="mt-1 flex flex-wrap items-center gap-2">
                  <span className="font-data break-all text-xs text-neutral-300">
                    {state.data.issuer}
                  </span>
                  <CopyButton value={state.data.issuer} />
                  <Link
                    href={`/issuers/${state.data.issuer}`}
                    className="font-data text-[11px] text-neutral-400 underline decoration-white/20 transition hover:text-[#e8b23a]"
                  >
                    all assets from this issuer →
                  </Link>
                </dd>
              </div>
            )}
            {envelope && (
              <div>
                <dt className={cardTitle}>Metadata commitment (SHA-256)</dt>
                <dd className="mt-1 flex items-center gap-2">
                  <span className="font-data break-all text-xs text-neutral-300">
                    {envelope.sha256}
                  </span>
                  <CopyButton value={envelope.sha256} />
                </dd>
              </div>
            )}
            {state.data.description && (
              <div>
                <dt className={cardTitle}>On-chain description</dt>
                <dd className="font-data mt-1 break-all text-xs text-neutral-500">
                  {state.data.description}
                </dd>
              </div>
            )}
            {!state.data.description && <ResolveDescription assetId={assetId} />}
          </dl>

          {nameSource === "zmd1" && <Zmd1Manifest assetId={assetId} />}

          <AssetEvents assetId={assetId} />
        </div>
      )}

      {state.isPending && <div className={`${card} mt-4 h-48 animate-pulse`} />}
    </div>
  );
}

/**
 * Unresolved asset: the chain only stores the description hash. Anyone who
 * knows the plaintext can teach it to the registry — it is accepted only
 * if it hashes to the on-chain commitment, so the registry cannot be lied
 * to. Open even on read-only deployments (verification, not issuance).
 */
function ResolveDescription({ assetId }: { assetId: string }) {
  const [description, setDescription] = useState("");
  const queryClient = useQueryClient();

  const resolve = useMutation({
    mutationFn: async () => {
      const { data, error } = await api.POST("/api/v1/assets/{asset_id}/description", {
        params: { path: { asset_id: assetId } },
        body: { description },
      });
      if (error) throw new Error(problemMessage(error));
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["asset", assetId] });
      queryClient.invalidateQueries({ queryKey: ["assets"] });
    },
  });

  return (
    <div>
      <dt className={cardTitle}>On-chain description (unresolved)</dt>
      <dd className="mt-1">
        <p className="text-xs leading-relaxed text-neutral-500">
          The chain only stores the description hash. Know the plaintext? Submit it: nothing is
          accepted unless it hashes to the on-chain commitment (ZIP 227), so the registry cannot be
          lied to.
        </p>
        <form
          className="mt-2.5 flex gap-2.5"
          onSubmit={(event) => {
            event.preventDefault();
            resolve.mutate();
          }}
        >
          <input
            data-testid="resolve-description"
            className={input}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={512}
            required
            placeholder="the exact asset description"
          />
          <button
            data-testid="resolve-submit"
            className={`${ghostButton} shrink-0`}
            type="submit"
            disabled={resolve.isPending}
          >
            {resolve.isPending ? "Verifying…" : "Verify & register"}
          </button>
        </form>
        {resolve.isError && <p className="mt-2 text-xs text-red-400">{resolve.error.message}</p>}
      </dd>
    </div>
  );
}
