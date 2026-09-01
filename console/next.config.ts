import type { NextConfig } from "next";

// Content-Security-Policy. 'unsafe-inline' is required by Next.js
// hydration scripts and injected styles; 'wasm-unsafe-eval' is required
// to compile the mint engine. Everything else is same-origin plus the
// API (fetches and bundle images). Dev builds skip the CSP: next dev
// relies on eval for fast refresh.
const apiOrigin = new URL(process.env.NEXT_PUBLIC_CACHET_API_URL ?? "http://localhost:8080").origin;
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  `connect-src 'self' ${apiOrigin}`,
  `img-src 'self' data: ${apiOrigin}`,
  "font-src 'self'",
  // blob: because wasm-bindgen-rayon spawns its thread-pool workers from
  // blob: URLs (the blob wraps a same-origin module script).
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  // Privacy (docs/PRIVACY.md): the console must not phone home.
  // Next.js telemetry is disabled via NEXT_TELEMETRY_DISABLED in .env,
  // and no analytics/error-reporting SDK may be added.
  reactStrictMode: true,

  // Privacy/security headers on every console response. Referrer-Policy is
  // the load-bearing one: outbound links (issuer external_url, GitHub) must
  // never learn which asset page the visitor came from.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          // Cross-origin isolation: required for SharedArrayBuffer, which
          // the threaded mint engine needs. Applied site-wide because
          // client-side navigation keeps the first document's isolation
          // state; the API answers with CORS + CORP so its resources
          // still load. No other cross-origin resource is ever embedded.
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
          ...(process.env.NODE_ENV === "production"
            ? [{ key: "Content-Security-Policy", value: csp }]
            : []),
        ],
      },
      {
        // The mint engine is large and changes only on deploys: cache it
        // for an hour, serve stale while revalidating for a day.
        source: "/mint-engine/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=3600, stale-while-revalidate=86400",
          },
        ],
      },
      {
        source: "/mint-engine-mt/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=3600, stale-while-revalidate=86400",
          },
        ],
      },
      {
        // Same rule for the verification engine, which every asset page
        // loads. Without it Next serves max-age=0 and revalidates 247 KB
        // on every visit.
        source: "/verify-engine/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=3600, stale-while-revalidate=86400",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
