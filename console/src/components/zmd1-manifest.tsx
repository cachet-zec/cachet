"use client";

import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import { safeExternalHref } from "@/lib/safe-href";
import { card, cardTitle } from "@/lib/ui";

/**
 * The verified ZMD-1 full-form manifest of a foreign (ZecBit-convention)
 * asset. The server fetched the manifest from its IPFS gateway and
 * verified BLAKE2b-256(bytes) against the on-chain commitment before
 * serving it, so what renders here carries the same "the registry cannot
 * lie" guarantee as Cachet's own envelope. Images stay explicit external
 * links: this instance embeds no third-party content, and the visitor's
 * browser contacts no gateway unless they choose to.
 */
export function Zmd1Manifest({ assetId }: { assetId: string }) {
  const manifest = useQuery({
    queryKey: ["zmd1-manifest", assetId],
    queryFn: async () => {
      const { data, error, response } = await api.GET("/api/v1/assets/{asset_id}/zmd1-manifest", {
        params: { path: { asset_id: assetId } },
      });
      if (response.status === 404) return null; // minimal form: nothing committed
      if (error) throw new Error(error.detail ?? "manifest unavailable");
      return data;
    },
    staleTime: Infinity, // content-addressed: immutable
    retry: 1,
  });

  if (!manifest.data) {
    if (manifest.isError) {
      return (
        <section className={card}>
          <h2 className={`${cardTitle} mb-2`}>ZMD-1 manifest</h2>
          <p className="text-xs leading-relaxed text-neutral-500">
            This asset commits to a full manifest on chain, but it could not be verified right now:{" "}
            {manifest.error.message}
          </p>
        </section>
      );
    }
    return null;
  }

  // Tolerant parse: ZMD-1 manifests are JSON in the wild, but a verified
  // document that fails to parse is still shown raw — the bytes are the
  // truth, the rendering is a convenience.
  let parsed: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(manifest.data.manifest);
    if (value && typeof value === "object" && !Array.isArray(value)) parsed = value;
  } catch {
    parsed = null;
  }

  const text = (key: string): string | null =>
    typeof parsed?.[key] === "string" ? (parsed[key] as string) : null;
  const image = text("image");
  const attributes = Array.isArray(parsed?.attributes)
    ? (parsed.attributes as unknown[])
        .map((entry) => {
          if (!entry || typeof entry !== "object") return null;
          const item = entry as Record<string, unknown>;
          const trait = typeof item.trait_type === "string" ? item.trait_type : null;
          const value =
            typeof item.value === "string" || typeof item.value === "number"
              ? String(item.value)
              : null;
          return trait && value !== null ? ([trait, value] as const) : null;
        })
        .filter((pair): pair is readonly [string, string] => pair !== null)
    : [];

  return (
    <section className={card} data-testid="zmd1-manifest">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className={cardTitle}>ZMD-1 manifest</h2>
        <span
          className="rounded-sm border border-emerald-400/40 px-1.5 py-0.5 font-data text-[10px] uppercase tracking-[0.14em] text-emerald-300"
          title="This registry fetched the manifest and verified its BLAKE2b-256 against the on-chain commitment"
        >
          ✓ verified against the chain
        </span>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-neutral-500">
        A foreign-convention manifest, committed on chain by its descriptor and verified byte for
        byte by this registry. Displayed as a neighbour&apos;s work: Cachet is neutral
        infrastructure.
      </p>

      {text("name") && (
        <p className="font-display mt-4 text-lg font-medium text-neutral-100">{text("name")}</p>
      )}
      {text("description") && (
        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-neutral-300">
          {text("description")}
        </p>
      )}

      {attributes.length > 0 && (
        <dl className="mt-4 max-w-md">
          {attributes.map(([trait, value]) => (
            <div
              key={trait}
              className="flex flex-wrap items-baseline justify-between gap-x-6 border-b border-white/[0.06] py-1.5 last:border-b-0"
            >
              <dt className="font-data text-[11px] uppercase tracking-[0.14em] text-neutral-500">
                {trait}
              </dt>
              <dd className="font-data text-[13px] text-neutral-200">{value}</dd>
            </div>
          ))}
        </dl>
      )}

      {image &&
        (() => {
          const href = safeExternalHref(
            image.startsWith("ipfs://")
              ? `https://ipfs.io/ipfs/${image.slice("ipfs://".length)}`
              : image,
          );
          return (
            <p className="mt-4 text-xs text-neutral-500">
              Image (external, opens off-site):{" "}
              {href ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  className="font-data break-all text-[#e8b23a]/90 underline decoration-[#e8b23a]/30"
                >
                  {image}
                </a>
              ) : (
                // Not http(s): show the raw value, never a clickable link.
                <span className="font-data break-all text-neutral-400">{image}</span>
              )}
            </p>
          );
        })()}

      {!parsed && (
        <pre className="font-data mt-4 overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-[#12100d] p-3 text-xs text-neutral-400">
          {manifest.data.manifest}
        </pre>
      )}

      <p className="font-data mt-4 break-all text-[11px] text-neutral-600">
        cid {manifest.data.cid} · blake2b-256 {manifest.data.content_hash}
      </p>
    </section>
  );
}
