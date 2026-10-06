"use client";

import { useMemo, useState } from "react";
import { encode } from "uqr";

import { CopyButton } from "@/components/copy-button";
import { SITE_URL } from "@/lib/site";

/**
 * A QR matrix drawn as one SVG path. Dark modules on a white plate, quiet
 * zone included: scanners need that contrast whatever the page theme is.
 */
function QrCode({ value, label }: { value: string; label: string }) {
  const { size, path } = useMemo(() => {
    const qr = encode(value, { ecc: "M", border: 2 });
    // One rectangle per horizontal run of dark modules, not per module,
    // which keeps the path short.
    let d = "";
    qr.data.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        if (!row[x]) continue;
        const start = x;
        while (x + 1 < row.length && row[x + 1]) x++;
        const run = x - start + 1;
        d += `M${start} ${y}h${run}v1h-${run}z`;
      }
    });
    return { size: qr.size, path: d };
  }, [value]);

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className="h-44 w-44 shrink-0 bg-white"
    >
      <path d={path} fill="#000" />
    </svg>
  );
}

type Mode = "link" | "digest";

/**
 * Hand an asset to someone else: its page as a link, or its ZIP 227 Asset
 * Digest for wallets that load assets from a QR code. The digest is only
 * offered once this browser derived it (see asset-detail).
 */
export function AssetShare({ assetId, digest }: { assetId: string; digest?: string }) {
  const [mode, setMode] = useState<Mode>("link");
  const current: Mode = mode === "digest" && digest ? "digest" : "link";
  const value = current === "digest" && digest ? digest : `${SITE_URL}/assets/${assetId}`;

  const tab = (target: Mode, text: string) => (
    <button
      type="button"
      aria-pressed={current === target}
      onClick={() => setMode(target)}
      className={`rounded-sm border px-2.5 py-1 text-[13px] transition ${
        current === target
          ? "border-accent/60 text-accent"
          : "border-white/10 text-neutral-400 hover:border-accent/40 hover:text-neutral-200"
      }`}
    >
      {text}
    </button>
  );

  return (
    <div className="mt-4 flex flex-col gap-5 sm:flex-row sm:items-start">
      <QrCode
        value={value}
        label={current === "digest" ? "QR code of the asset digest" : "QR code of this page"}
      />
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap gap-2" role="group" aria-label="What the QR code holds">
          {tab("link", "Page link")}
          {digest && tab("digest", "Asset digest")}
        </div>
        <p className="max-w-prose text-[15px] leading-relaxed text-neutral-400">
          {current === "digest"
            ? "The 64-byte Asset Digest (ZIP 227), the compact form wallets can load an asset from. Derived in your browser."
            : "Opens this page. Whoever scans it runs the same checks in their own browser, so they trust the chain, not you."}
        </p>
        <div className="flex items-start justify-between gap-3">
          <span className="font-data break-all text-sm leading-relaxed text-neutral-300">
            {value}
          </span>
          <CopyButton value={value} />
        </div>
      </div>
    </div>
  );
}
