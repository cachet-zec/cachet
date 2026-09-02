import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ImageResponse } from "next/og";

import { apiBaseUrl } from "@/lib/api";

export const alt = "A Zcash Shielded Asset on Cachet";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const GOLD = "#e8b23a";
const INK = "#eae5db";
const MUTED = "#9c968a";

const font = (file: string) => readFile(join(process.cwd(), "src/app/og-fonts", file));

type AssetCard = {
  name: string | null;
  supply: string;
  finalized: boolean;
  image: string | null;
};

/**
 * What the card may show, read through the same public API a visitor uses,
 * so moderation applies by construction: a hidden issuer answers 410 on
 * the asset (generic card, no details), a hidden or purged bundle answers
 * 410 on the image (card without image). Nothing here reaches into the
 * store directly.
 */
async function loadCard(id: string): Promise<AssetCard | null> {
  try {
    const response = await fetch(`${apiBaseUrl}/api/v1/assets/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(2_500),
      cache: "no-store",
    });
    if (!response.ok) return null;
    const asset = (await response.json()) as {
      display_name?: string | null;
      total_supply?: string | number;
      finalized?: boolean;
      image_path?: string | null;
    };
    let image: string | null = null;
    if (asset.image_path) {
      const picture = await fetch(`${apiBaseUrl}${asset.image_path}`, {
        signal: AbortSignal.timeout(2_500),
        cache: "no-store",
      });
      const type = picture.headers.get("content-type") ?? "";
      // Satori renders PNG, JPEG and WebP; anything else (or a 410) means
      // the card simply has no picture.
      if (picture.ok && /^image\/(png|jpeg|webp)/.test(type)) {
        const bytes = Buffer.from(await picture.arrayBuffer());
        image = `data:${type.split(";")[0]};base64,${bytes.toString("base64")}`;
      }
    }
    return {
      name: asset.display_name ?? null,
      supply: String(asset.total_supply ?? ""),
      finalized: Boolean(asset.finalized),
      image,
    };
  } catch {
    return null;
  }
}

/** Fit a name into the card: long names shrink, very long ones are cut. */
function nameStyle(name: string): { fontSize: number; text: string } {
  if (name.length <= 18) return { fontSize: 76, text: name };
  if (name.length <= 30) return { fontSize: 58, text: name };
  if (name.length <= 44) return { fontSize: 44, text: name };
  return { fontSize: 44, text: `${name.slice(0, 41)}…` };
}

export default async function AssetOpenGraphImage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [display, mono, monoMedium, card] = await Promise.all([
    font("Fraunces-SemiBold.ttf"),
    font("IBMPlexMono-Regular.ttf"),
    font("IBMPlexMono-Medium.ttf"),
    loadCard(id),
  ]);

  const shortId = `${id.slice(0, 12)}…${id.slice(-6)}`;
  const title = card?.name ? nameStyle(card.name) : { fontSize: 44, text: "A shielded asset" };
  const stamp = card ? (card.finalized ? "SEALED FOREVER" : "OPEN SUPPLY") : "ON CHAIN";

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        padding: "48px 64px 44px",
        backgroundColor: "#0b0a08",
        backgroundImage: "radial-gradient(circle at 85% 20%, #16130d 0%, #0b0a08 55%)",
        color: INK,
        fontFamily: "IBM Plex Mono",
      }}
    >
      {/* Header: seal + wordmark, as on the site card */}
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 46,
            height: 46,
            borderRadius: 9999,
            border: "3px solid " + GOLD,
            fontFamily: "Fraunces",
            fontSize: 26,
            color: GOLD,
          }}
        >
          C
        </div>
        <div style={{ fontFamily: "Fraunces", fontSize: 32, color: INK }}>Cachet</div>
        <div style={{ fontSize: 15, letterSpacing: 5, color: MUTED, marginLeft: 10 }}>
          ZCASH SHIELDED ASSET
        </div>
      </div>

      {/* Body: picture (or seal placeholder) beside the facts */}
      <div style={{ display: "flex", flexGrow: 1, alignItems: "center", gap: 56, marginTop: 28 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 360,
            height: 360,
            flexShrink: 0,
            borderRadius: 10,
            border: "1px solid rgba(255,255,255,0.12)",
            backgroundColor: "#12100d",
            overflow: "hidden",
          }}
        >
          {card?.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={card.image}
              alt=""
              width={360}
              height={360}
              style={{ objectFit: "cover", width: 360, height: 360 }}
            />
          ) : (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 200,
                height: 200,
                borderRadius: 9999,
                border: "3px solid rgba(232,178,58,0.5)",
                fontFamily: "Fraunces",
                fontSize: 110,
                color: "rgba(232,178,58,0.6)",
              }}
            >
              C
            </div>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flexGrow: 1 }}>
          <div style={{ fontSize: 17, letterSpacing: 6, color: GOLD }}>
            {card ? "ASSET" : "REGISTRY ENTRY"}
          </div>
          <div
            style={{
              display: "flex",
              marginTop: 16,
              fontFamily: "Fraunces",
              fontSize: title.fontSize,
              lineHeight: 1.08,
              letterSpacing: -1,
              color: "#fafafa",
            }}
          >
            {title.text}
          </div>
          {card && (
            <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginTop: 22 }}>
              <div style={{ fontSize: 22, color: MUTED }}>supply</div>
              <div style={{ fontSize: 34, fontWeight: 500, color: GOLD }}>{card.supply}</div>
            </div>
          )}
          <div style={{ display: "flex", marginTop: 26 }}>
            <div
              style={{
                display: "flex",
                transform: "rotate(-4deg)",
                border: "2px solid rgba(232,178,58,0.75)",
                borderRadius: 4,
                padding: "8px 16px",
                fontSize: 18,
                letterSpacing: 5,
                color: GOLD,
              }}
            >
              {stamp}
            </div>
          </div>
        </div>
      </div>

      {/* Ledger double rule + signature line */}
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ height: 2, backgroundColor: "rgba(232,178,58,0.35)", display: "flex" }} />
        <div
          style={{
            height: 1,
            backgroundColor: "rgba(255,255,255,0.08)",
            marginTop: 4,
            display: "flex",
          }}
        />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 18,
          }}
        >
          <div style={{ fontWeight: 500, fontSize: 21, color: INK }}>
            cachetzec.com · verified in your browser
          </div>
          <div style={{ fontSize: 17, color: MUTED }}>{shortId}</div>
        </div>
      </div>
    </div>,
    {
      ...size,
      fonts: [
        { name: "Fraunces", data: display, style: "normal", weight: 600 },
        { name: "IBM Plex Mono", data: mono, style: "normal", weight: 400 },
        { name: "IBM Plex Mono", data: monoMedium, style: "normal", weight: 500 },
      ],
    },
  );
}
