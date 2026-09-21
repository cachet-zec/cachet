"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";

import { CopyButton } from "@/components/copy-button";
import { SealedText } from "@/components/sealed-text";
import { envelopeHash, fetchKept, loadSealedContent } from "@/lib/kept";
import { safeImageDataUri, sealedName } from "@/lib/sealed-name";
import { primaryButton } from "@/lib/ui";

/**
 * Shown where an asset used to be. The chain this registry follows does
 * not carry it, but the registry kept what was sealed into its id, so the
 * issuer can bring the same asset id back.
 *
 * When the registry keeps nothing for this id, the page's own "not found"
 * (`fallback`) says all there is to say. What is shown was hashed in this
 * browser against the kept description first.
 */
export function KeptAsset({
  assetId,
  fallback,
}: {
  assetId: string;
  /** What the page says when nothing is kept for this id. */
  fallback: React.ReactNode;
}) {
  const kept = useQuery({
    queryKey: ["kept", assetId],
    queryFn: () => fetchKept(assetId),
    retry: false,
  });
  const remintable = kept.data ? envelopeHash(kept.data.description) !== null : false;
  const sealed = useQuery({
    queryKey: ["kept", assetId, "sealed"],
    enabled: remintable,
    queryFn: () => loadSealedContent(kept.data!.description),
    retry: false,
  });

  if (kept.isPending) return null;
  if (kept.isError) {
    return (
      <p className="mt-6 text-sm text-red-400">
        The registry did not answer. This says nothing about the asset: try again in a moment.
      </p>
    );
  }
  if (!kept.data) return fallback;
  const image = sealed.data?.imageDataUri ? safeImageDataUri(sealed.data.imageDataUri) : null;

  return (
    <article data-testid="kept-asset" className="mt-6">
      <p className="font-data text-sm text-accent">No longer on this chain</p>
      <h1 className="font-display mt-2 text-4xl font-medium leading-[1.08] text-neutral-50 [overflow-wrap:anywhere] sm:text-5xl">
        {/* read here from the kept description, cleaned; never the registry's own field */}
        {sealedName(kept.data.description).name}
      </h1>
      <p className="mt-4 max-w-prose text-base leading-relaxed text-neutral-300">
        The test network was reset, and a reset takes every asset with it. This registry kept what
        was sealed into this asset&apos;s id. Minted again with the same seed, this content gives
        the same asset id.
      </p>

      <div className="mt-8 grid gap-8 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] md:gap-10">
        {image && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image}
            alt=""
            className="aspect-square w-full border border-line-strong bg-ground object-cover"
          />
        )}
        <div className="min-w-0">
          {sealed.data?.description && <SealedText text={sealed.data.description} />}
          {sealed.isError && (
            <p className="text-sm text-red-400">{(sealed.error as Error).message}</p>
          )}
          {!remintable && (
            <p className="max-w-prose text-sm leading-relaxed text-neutral-400">
              Its description was free text, not a Cachet seal: it is kept, but the mint page cannot
              sign it as it is.
            </p>
          )}

          <div className="mt-6 flex items-start gap-3">
            <span className="font-data break-all text-sm leading-relaxed text-neutral-400">
              {assetId}
            </span>
            <CopyButton value={assetId} />
          </div>

          {sealed.data && (
            <Link
              href={`/mint?remint=${assetId}`}
              data-testid="kept-remint"
              className={`${primaryButton} mt-6 inline-block`}
            >
              Mint it again
            </Link>
          )}
        </div>
      </div>
    </article>
  );
}
