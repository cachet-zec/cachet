import type { MetadataRoute } from "next";

import { SITE_URL } from "@/lib/site";

/**
 * Static entry points only.
 *
 * Asset and issuer pages are deliberately absent: there are hundreds, the set
 * changes with every block, and a list baked at build time is stale before it
 * ships. Crawlers reach them by following the registry, which is the same path
 * a reader takes.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: SITE_URL, changeFrequency: "hourly", priority: 1 },
    { url: `${SITE_URL}/console`, changeFrequency: "hourly", priority: 0.9 },
    { url: `${SITE_URL}/mint`, changeFrequency: "weekly", priority: 0.9 },
    { url: `${SITE_URL}/issuers`, changeFrequency: "hourly", priority: 0.7 },
    { url: `${SITE_URL}/continuity`, changeFrequency: "monthly", priority: 0.6 },
  ];
}
