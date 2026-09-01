import type { MetadataRoute } from "next";

import { SITE_URL } from "@/lib/site";

/**
 * Crawlers were getting no directive at all (404), and no pointer to the
 * sitemap. Everything here is public and worth indexing except the operator
 * surface, which answers 404 without a token anyway - disallowing it just
 * saves a crawler the trip.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/admin"] },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
