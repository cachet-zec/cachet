import type { Metadata } from "next";

const SITE_NAME = "Cachet";

/** The site-wide card rendered by app/opengraph-image.tsx. */
const SITE_CARD = {
  url: "/opengraph-image",
  width: 1200,
  height: 630,
  alt: "Cachet: issue shielded assets on Zcash (testnet)",
};

const DEFAULT_DESCRIPTION =
  "Issuance console & verifiable registry for Zcash Shielded Assets. Private balances, public supplies, metadata sealed into the asset id. Testnet.";

/**
 * Title, description, canonical URL and social card text of one page, kept
 * in step. Next.js replaces a parent's `openGraph` wholesale when a page
 * sets a title alone, so a shared link would otherwise carry the site's
 * generic title, and no image at all. So the card is named here too: the
 * site's, or the route's own when it has one (an asset page passes it, the
 * image set here wins over its opengraph-image file). `path` is relative
 * to the site's `metadataBase`.
 */
export function pageMetadata({
  title,
  description = DEFAULT_DESCRIPTION,
  path,
  card,
}: {
  title: string;
  description?: string;
  path: string;
  /** A route's own card image (an asset page); the site card otherwise. */
  card?: { url: string; alt: string };
}): Metadata {
  const image = card ? { ...SITE_CARD, ...card } : SITE_CARD;
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      title,
      description,
      url: path,
      siteName: SITE_NAME,
      type: "website",
      images: [image],
    },
    twitter: { card: "summary_large_image", title, description, images: [image.url] },
  };
}
