import { api, apiBaseUrl } from "@/lib/api";
import { safeImageDataUri } from "@/lib/sealed-name";

/**
 * What the registry still holds for an asset the chain it follows no
 * longer carries. A test network can be reset, and a reset takes every
 * asset with it; the registry's journal and bundles are keyed by asset id
 * and stay. An asset id is derived from the issuance key and the sealed
 * description, so the same seed minting the same sealed content gets the
 * same asset id back.
 */
export type KeptAsset = {
  asset_id: string;
  description: string;
  display_name: string;
  name_source: string;
  image_path?: string | null;
};

/** The content an envelope seals, checked here against the envelope's hash. */
export type SealedContent = {
  sha256: string;
  name: string;
  description: string | undefined;
  imageDataUri: string | undefined;
  externalUrl: string | undefined;
};

/** `null`: on chain, never known here, or withheld. */
export async function fetchKept(assetId: string): Promise<KeptAsset | null> {
  const { data, response } = await api.GET("/api/v1/kept/{asset_id}", {
    params: { path: { asset_id: assetId } },
  });
  if (data) return data;
  if (response.status === 404 || response.status === 400) return null;
  throw new Error("The registry could not say what it keeps for this asset.");
}

export async function fetchKeptPage(
  limit: number,
  offset: number,
): Promise<{ items: KeptAsset[]; total: number }> {
  const { data, error, response } = await api.GET("/api/v1/kept", {
    params: { query: { limit, offset } },
  });
  if (error) throw new Error(error.detail);
  return { items: data, total: Number(response.headers.get("x-total-count") ?? data.length) };
}

/**
 * Whether a kept description can be minted again from the mint page: only
 * a v1 envelope, which is what the page itself seals. Free text is kept
 * and shown, but the page has no way to sign it as is.
 */
export function envelopeHash(description: string): string | null {
  try {
    const envelope = JSON.parse(description) as { v?: unknown; sha256?: unknown };
    return envelope.v === 1 &&
      typeof envelope.sha256 === "string" &&
      /^[0-9a-f]{64}$/.test(envelope.sha256)
      ? envelope.sha256
      : null;
  } catch {
    return null;
  }
}

/**
 * Fetch the bundle an envelope names and check it against the envelope
 * before anything is shown or signed: the bytes must hash to the seal, and
 * the name inside must be the envelope's.
 */
export async function loadSealedContent(description: string): Promise<SealedContent> {
  const sha256 = envelopeHash(description);
  if (!sha256) throw new Error("This description is not a Cachet envelope.");
  const envelopeName = (JSON.parse(description) as { name?: unknown }).name;

  const response = await fetch(`${apiBaseUrl}/api/v1/metadata/${sha256}`);
  if (response.status === 410) throw new Error("This registry withholds the sealed content.");
  if (!response.ok) throw new Error("This registry no longer holds the sealed content.");
  const bytes = await response.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const computed = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (computed !== sha256) throw new Error("The content served does not match its seal.");

  const bundle = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  // Whatever is in the bundle gets signed along with what the page shows. A
  // seed deriving the expected id proves nothing about the content (the
  // issuance key is public, anyone can compute that id for any content), so
  // the page must show all of it: a bundle with a field it cannot show, or
  // an image it will not draw, is refused.
  const shown = new Set(["v", "name", "description", "image_data_uri", "external_url"]);
  const unknown = Object.keys(bundle).filter((key) => !shown.has(key));
  if (unknown.length > 0) {
    throw new Error(`The sealed content has fields this page cannot show (${unknown.join(", ")}).`);
  }
  if (bundle.image_data_uri !== undefined && !safeImageDataUri(String(bundle.image_data_uri))) {
    throw new Error("The sealed image is not one this page can show.");
  }
  const text = (value: unknown) => (typeof value === "string" ? value : undefined);
  const name = text(bundle.name);
  if (name === undefined || name !== envelopeName) {
    throw new Error("The sealed name does not match the description.");
  }
  return {
    sha256,
    name,
    description: text(bundle.description),
    imageDataUri: text(bundle.image_data_uri),
    externalUrl: text(bundle.external_url),
  };
}
