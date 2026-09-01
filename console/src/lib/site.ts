/**
 * Public origin this deployment is served from.
 *
 * Used for canonical metadata, robots.txt and sitemap.xml, which all need
 * absolute URLs. Like the API origin, it is baked into the bundle at build
 * time, so it is a build arg rather than a runtime variable - a self-hoster
 * sets it once in `infra/prod/deploy.sh` and their robots.txt stops pointing
 * at somebody else's box.
 */
export const SITE_URL = process.env.NEXT_PUBLIC_CACHET_SITE_URL ?? "https://cachetzec.com";
