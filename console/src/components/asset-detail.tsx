"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { AssetEvents } from "@/components/asset-events";
import { CopyButton } from "@/components/copy-button";
import { IdPlate } from "@/components/id-plate";
import { KeptAsset } from "@/components/kept-asset";
import { SealedText } from "@/components/sealed-text";
import { api, apiBaseUrl, problemMessage } from "@/lib/api";
import { safeImageDataUri, sealedName } from "@/lib/sealed-name";
import { deriveAssetId } from "@/lib/verify-engine";
import { card, fieldLabel, ghostButton, input, stamp } from "@/lib/ui";

/** A page section's heading: the engraved face, under a hairline. */
const sectionTitle = "font-display text-2xl font-medium text-neutral-100";

/** The double rule of an engraved plate: a hairline inside a hairline. */
const plateFrame = "border border-line p-1.5";

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
    // A 410 is an operator decision, not a transient fault: retrying it
    // twice in a row is pointless, but polling it slowly is not - the
    // operator can unhide, and a page left open should notice without a
    // reload. Successes are content-addressed and never need refetching.
    retry: false,
    refetchInterval: (query) => (query.state.status === "error" ? 15_000 : false),
    queryFn: async () => {
      const url = `${apiBaseUrl}/api/v1/metadata/${envelope!.sha256}`;
      let response = await fetch(url);
      if (!response.ok) {
        // An error may be the browser's own cached copy of an older
        // decision (a 410 cached before the API marked errors no-store).
        // Ask the network once before believing it; the success path keeps
        // the immutable cache untouched.
        response = await fetch(url, { cache: "reload" });
      }
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
 * format - envelope or free text.
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

/** The sealed image as the page's plate; click for full size, Escape closes. */
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
        className={`${plateFrame} group block w-full cursor-zoom-in transition hover:border-accent/60`}
        onClick={() => setOpen(true)}
      >
        {/* Contained, never cropped: the whole sealed image is the point. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt=""
          className="aspect-square w-full border border-line-strong bg-ground object-contain"
        />
      </button>
      {/* Portal to <body>: the page wrapper animates with a retained
          transform, and a transformed ancestor captures position:fixed -
          rendered in place, this overlay would cover the column, not the
          viewport, and the vh-sized image would overflow it. */}
      {open &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            data-testid="asset-image-lightbox"
            className="fixed inset-0 z-50 flex cursor-zoom-out flex-col items-center justify-center gap-3 bg-black/90 p-8 backdrop-blur-md"
            onClick={() => setOpen(false)}
          >
            {/* Height budget: viewport minus the caption, the gaps and the
              padding - so image + caption always fit together, navbar
              included. Width capped so a square never wall-to-walls. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt=""
              className="max-h-[calc(100vh-9rem)] max-w-[min(88vw,52rem)] rounded-md border border-white/15 object-contain shadow-[0_8px_40px_rgba(0,0,0,0.6)]"
            />
            <p className="font-data text-sm text-neutral-400">
              Sealed with the asset. Click anywhere to close.
            </p>
          </div>,
          document.body,
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

  // The name comes out of the description this page checks against the
  // asset id, and the image out of the bundle it hashes: never from the
  // registry's `display_name` or `image_path`, which nothing verifies. Long
  // free text is cut short; the full description is in the register below.
  const sealed = sealedName(state.data?.description);
  const displayName =
    sealed.name && sealed.name.length > 60 ? `${sealed.name.slice(0, 57).trimEnd()}…` : sealed.name;
  const nameSource = sealed.source;
  const sealedImage = verification.data?.verified
    ? safeImageDataUri(verification.data.bundle.image_data_uri)
    : null;
  const imagePending = envelope !== null && verification.isPending;

  const finalizedMeaning =
    "Finalized: consensus refuses further units, from anyone including the issuer. " +
    "Holders can still burn what they hold, so the supply can fall but never rise.";

  return (
    <div className="mx-auto max-w-5xl">
      <Link
        href="/console"
        className="font-data text-sm text-neutral-400 transition hover:text-accent"
      >
        ← Back to console
      </Link>

      {state.isError && (
        <KeptAsset
          assetId={assetId}
          fallback={
            <div className={`${card} mt-4`}>
              <p className="text-sm text-red-400">
                Asset not found on this chain: {state.error.message}
              </p>
            </div>
          }
        />
      )}

      {state.data && (
        <article className="mt-6">
          {/* The plate, then what a holder weighs first. */}
          <header className="grid gap-8 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] md:gap-12">
            <div>
              {sealedImage ? (
                <SealedImage src={sealedImage} />
              ) : imagePending ? (
                <div className={plateFrame}>
                  <div className="aspect-square w-full motion-safe:animate-pulse border border-line-strong bg-surface" />
                </div>
              ) : (
                <div className={plateFrame}>
                  <IdPlate assetId={assetId} className="block w-full border border-line-strong" />
                </div>
              )}
              {!sealedImage && !imagePending && (
                <p className="font-data mt-2.5 text-[13px] text-neutral-500">
                  {envelope && !verification.data?.verified
                    ? "Image not shown: the metadata could not be verified."
                    : "No image sealed. Pattern drawn from the asset id."}
                </p>
              )}
            </div>

            <div className="min-w-0">
              <h1
                className={
                  nameSource === "free_text"
                    ? "font-display text-4xl font-medium italic leading-[1.08] text-neutral-200 [overflow-wrap:anywhere] sm:text-5xl"
                    : "font-display text-4xl font-medium leading-[1.08] text-neutral-50 [overflow-wrap:anywhere] sm:text-5xl"
                }
              >
                {displayName ?? <span className="italic text-neutral-500">Unresolved asset</span>}
              </h1>

              <div className="mt-4 flex flex-wrap items-center gap-2">
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
                        ? "rounded-full border border-emerald-400/40 px-3 py-0.5 font-data text-[13px] tracking-[0.04em] text-emerald-300"
                        : "rounded-full border border-red-400/50 px-3 py-0.5 font-data text-[13px] tracking-[0.04em] text-red-300"
                    }
                  >
                    {badge.label}
                  </span>
                )}
                {envelope && verification.isError && (
                  <span className={stamp}>{verification.error.message}</span>
                )}
              </div>

              {/* Supply, and whether it can still grow: stated either way. */}
              <div className="mt-9 flex flex-wrap items-center justify-between gap-x-10 gap-y-5">
                <div>
                  <p className={fieldLabel}>Supply on chain</p>
                  <p className="font-display mt-1.5 text-5xl font-medium leading-none tabular-nums text-neutral-50 [overflow-wrap:anywhere] sm:text-6xl">
                    {state.data.total_supply.toLocaleString("en-US")}
                  </p>
                </div>
                {state.data.finalized ? (
                  // Engraved, not stamped. The tooltip keeps the precise meaning.
                  <p
                    data-testid="sealed-stamp"
                    title={finalizedMeaning}
                    className="pen-write font-display text-3xl font-medium italic leading-tight text-accent"
                  >
                    Sealed forever
                  </p>
                ) : (
                  <p
                    data-testid="open-supply"
                    title="Not finalized: the issuance key can still add units. The name and metadata cannot change, only the supply."
                    className="pen-write font-display text-2xl font-medium italic leading-tight text-accent sm:text-3xl"
                  >
                    Issuer can mint more
                  </p>
                )}
              </div>

              {/* Bundle content renders ONLY once the hash check passed: a
                  registry that fails its own commitment gets a red badge,
                  not a voice. A bundle's `external_url` is never shown: anyone
                  can mint, and this page should not carry an address it has
                  not checked. The mint page does not offer the field. */}
              {verification.data?.verified && verification.data.bundle.description && (
                <SealedText className="mt-6" text={verification.data.bundle.description} />
              )}
            </div>
          </header>

          <section className="mt-14">
            <h2 className={sectionTitle}>Checked in your browser</h2>
            <ul className="mt-4 flex flex-col gap-3">
              <CheckRow
                title="Asset id"
                state={
                  !state.data.description
                    ? "none"
                    : identity.data
                      ? identity.data.matches
                        ? "ok"
                        : "failed"
                      : identity.isError
                        ? "unknown"
                        : "pending"
                }
                text={{
                  ok: "Derived from the issuer key and the description (ZIP 227).",
                  failed:
                    "The description served does not derive this asset id. Do not trust the name shown.",
                  pending: "Recomputing the asset id from the issuer key and the description…",
                  unknown: "The asset id could not be recomputed in this browser.",
                  none: "No description is known for this asset yet, so there is nothing to derive.",
                }}
              />
              <CheckRow
                order={1}
                title="Metadata"
                state={
                  !envelope
                    ? "none"
                    : verification.data
                      ? verification.data.verified
                        ? "ok"
                        : "failed"
                      : verification.isError
                        ? "unknown"
                        : "pending"
                }
                text={{
                  ok: "Name, text and image match the hash sealed on chain.",
                  failed:
                    "The bundle served does not hash to the commitment in the description. Its content is not shown.",
                  pending: "Fetching the metadata bundle and hashing it…",
                  unknown: `Not checked: ${verification.error?.message ?? "metadata bundle unavailable"}.`,
                  none: state.data.description
                    ? "Free-text label, no metadata bundle: the name is what the issuer typed."
                    : "Nothing to check until the description is known.",
                }}
              />
            </ul>
          </section>

          <section className="mt-14">
            <h2 className={sectionTitle}>Register entry</h2>
            <dl className="mt-3">
              <EntryRow label="Asset id" value={assetId} />
              {state.data.issuer && (
                <EntryRow label="Issuer" value={state.data.issuer}>
                  <Link
                    href={`/issuers/${state.data.issuer}`}
                    className="mt-2 inline-block text-sm text-neutral-300 underline decoration-white/20 transition hover:text-accent"
                  >
                    All assets from this issuer →
                  </Link>
                </EntryRow>
              )}
              {envelope && (
                <EntryRow label="Metadata commitment" hint="SHA-256" value={envelope.sha256} />
              )}
              {state.data.description && (
                <EntryRow label="On-chain description" value={state.data.description} />
              )}
              {!state.data.description && <ResolveDescription assetId={assetId} />}
            </dl>
          </section>

          <AssetEvents assetId={assetId} />
        </article>
      )}

      {state.isPending && (
        <div className="mt-6 grid gap-8 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] md:gap-12">
          <div className="aspect-square motion-safe:animate-pulse border border-line bg-surface" />
          <div className="flex flex-col gap-5">
            <div className="h-12 w-2/3 motion-safe:animate-pulse bg-surface" />
            <div className="h-28 motion-safe:animate-pulse bg-surface/60" />
          </div>
        </div>
      )}
    </div>
  );
}

type CheckState = "ok" | "failed" | "pending" | "unknown" | "none";

/** One client-side check, with its verdict in words rather than a colour. */
function CheckRow({
  title,
  state,
  text,
  order = 0,
}: {
  title: string;
  state: CheckState;
  text: Record<CheckState, string>;
  /** Position in the list: a passed check draws its tick slightly after the one above. */
  order?: number;
}) {
  const mark = { ok: "✓", failed: "✗", pending: "…", unknown: "?", none: "–" }[state];
  const tone = {
    ok: "text-emerald-300",
    failed: "text-red-300",
    pending: "text-neutral-500",
    unknown: "text-accent",
    none: "text-neutral-500",
  }[state];
  return (
    <li className="grid gap-x-8 gap-y-1 sm:grid-cols-[13rem_minmax(0,1fr)]">
      <span className="flex items-baseline gap-2.5 text-base font-medium text-neutral-100">
        <span aria-hidden className={`font-data flex w-4 shrink-0 justify-center ${tone}`}>
          {state === "ok" ? (
            // Drawn when the check passes, not before: the state is the
            // real one, the key restarts the stroke if it changes.
            <svg key="ok" viewBox="0 0 16 16" className="h-4 w-4 translate-y-0.5" fill="none">
              <path
                d="M2.5 8.5 6.2 12.2 13.5 4"
                pathLength={1}
                className="tick-draw"
                style={{ "--tick-delay": `${order * 260}ms` } as React.CSSProperties}
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : state === "pending" ? (
            <span className="pulse-dot mt-2 h-1.5 w-1.5 rounded-full bg-neutral-500" />
          ) : (
            mark
          )}
        </span>
        {title}
      </span>
      <span
        className={`text-base leading-relaxed ${state === "failed" ? "text-red-200" : "text-neutral-300"}`}
      >
        {text[state]}
      </span>
    </li>
  );
}

/** One line of the register: what the datum is, the datum, a way to copy it. */
function EntryRow({
  label,
  hint,
  value,
  children,
}: {
  label: string;
  hint?: string;
  value: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="grid gap-x-8 gap-y-1.5 border-b border-line py-4 last:border-b-0 sm:grid-cols-[13rem_minmax(0,1fr)]">
      <dt>
        <span className="block text-base font-medium text-neutral-100">{label}</span>
        {hint && <span className="font-data block text-[13px] text-neutral-500">{hint}</span>}
      </dt>
      <dd className="min-w-0">
        <div className="flex items-start justify-between gap-3">
          <span className="font-data break-all text-sm leading-relaxed text-neutral-300">
            {value}
          </span>
          <CopyButton value={value} />
        </div>
        {children}
      </dd>
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
    <div className="grid gap-x-8 gap-y-1.5 border-b border-line py-4 last:border-b-0 sm:grid-cols-[13rem_minmax(0,1fr)]">
      <dt>
        <span className="block text-base font-medium text-neutral-100">On-chain description</span>
        <span className="font-data block text-[13px] text-neutral-500">unresolved</span>
      </dt>
      <dd className="min-w-0">
        <p className="max-w-prose text-base leading-relaxed text-neutral-300">
          The chain only stores the description hash. Know the plaintext? Submit it: nothing is
          accepted unless it hashes to the on-chain commitment (ZIP 227), so the registry cannot be
          lied to.
        </p>
        <form
          className="mt-3 flex flex-wrap gap-2.5 sm:flex-nowrap"
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
        {resolve.isError && (
          <p className="mt-2 text-[13px] text-red-400">{resolve.error.message}</p>
        )}
      </dd>
    </div>
  );
}
