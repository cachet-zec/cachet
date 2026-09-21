import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ImageResponse } from "next/og";

import { SEAL_C_PATH, SEAL_EDGE_PATH } from "@/components/seal-mark";
import { apiBaseUrl } from "@/lib/api";
import { createRenderCache } from "@/lib/render-cache";

export const alt = "A Zcash Shielded Asset on Cachet";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const ACCENT = "#dc9a76";
const INK = "#edf3ee";
const MUTED = "#a4b8aa";

const font = (file: string) => readFile(join(process.cwd(), "src/app/og-fonts", file));

// Read once per process, not once per card.
let fontFiles: Promise<[Buffer, Buffer, Buffer]> | null = null;
const fonts = () =>
  (fontFiles ??= Promise.all([
    font("BodoniModa-Medium.ttf"),
    font("DMMono-Regular.ttf"),
    font("DMMono-Medium.ttf"),
  ]).catch((error) => {
    fontFiles = null;
    throw error;
  }));

/** How long a drawn card stands: a supply or a moderation change shows after. */
const CARD_TTL_MS = 5 * 60_000;
/** A card drawn while the registry did not answer is retried soon. */
const UNSETTLED_TTL_MS = 15_000;

// 48 MB of cards at most, two drawn at a time, eight callers waiting (a
// few seconds at worst, inside what a link preview allows); past that a
// caller gets the site's card (see lib/render-cache.ts).
const cards = createRenderCache({ maxBytes: 48 * 1024 * 1024, maxConcurrent: 2, maxWaiting: 8 });

const ASSET_ID = /^[0-9a-f]{64}$/;

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
async function loadCard(id: string): Promise<{ card: AssetCard | null; settled: boolean }> {
  try {
    const response = await fetch(`${apiBaseUrl}/api/v1/assets/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(2_500),
      cache: "no-store",
    });
    // Not there, or withheld: a settled answer. Anything else is a failure.
    if (!response.ok) return { card: null, settled: response.status < 500 };
    const asset = (await response.json()) as {
      display_name?: string | null;
      total_supply?: string | number;
      finalized?: boolean;
      image_path?: string | null;
    };
    let image: string | null = null;
    // The path comes from the registry: only the one shape it can have is
    // fetched, so it can never point this server somewhere else.
    if (asset.image_path && /^\/api\/v1\/metadata\/[0-9a-f]{64}\/image$/.test(asset.image_path)) {
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
      card: {
        name: asset.display_name ?? null,
        supply: String(asset.total_supply ?? ""),
        finalized: Boolean(asset.finalized),
        image,
      },
      settled: true,
    };
  } catch {
    return { card: null, settled: false };
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
  // Anything that is not an asset id shares one generic card: made-up ids
  // cost one render in all, and never a call to the registry.
  const assetId = ASSET_ID.test(id.toLowerCase()) ? id.toLowerCase() : null;
  // A well-formed id with no asset behind it is as made up as the rest: once
  // the registry has said so, it shares the generic card too, so random ids
  // cost one cheap lookup each and never a drawing slot.
  const known = assetId ? (cards.peek(assetId) ?? null) : null;
  const loaded = assetId && !known ? await loadCard(assetId) : { card: null, settled: true };
  const generic = !known && loaded.card === null && loaded.settled;
  const bytes = known
    ? known
    : await cards
        .get(generic ? "unknown" : (assetId ?? "unknown"), async () => {
          const drawn = await drawCard(generic ? null : assetId, loaded.card);
          return {
            bytes: new Uint8Array(await drawn.arrayBuffer()),
            ttlMs: loaded.settled ? CARD_TTL_MS : UNSETTLED_TTL_MS,
          };
        })
        .catch(() => null);
  if (!bytes) {
    // Too many cards being drawn, or this one failed: the site's card, which
    // is static, rather than a queue or an error.
    return new Response(null, {
      status: 302,
      headers: { Location: "/opengraph-image", "Cache-Control": "no-store" },
    });
  }
  return new Response(bytes, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": `public, max-age=${CARD_TTL_MS / 1000}`,
    },
  });
}

async function drawCard(assetId: string | null, card: AssetCard | null) {
  const [display, mono, monoMedium] = await fonts();

  const shortId = assetId ? `${assetId.slice(0, 12)}…${assetId.slice(-6)}` : "";
  const title = card?.name ? nameStyle(card.name) : { fontSize: 44, text: "A shielded asset" };
  // Same words as the asset page, engraved either way.
  const sealed = card?.finalized === true;
  // No card, no claim: a made-up, withheld or lost id is not "on chain".
  const tag = card ? "Issuer can mint more" : "";

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        padding: "48px 64px 44px",
        backgroundColor: "#0b1d18",
        backgroundImage: "radial-gradient(circle at 85% 20%, #17352b 0%, #0b1d18 55%)",
        color: INK,
        fontFamily: "DM Mono",
      }}
    >
      {/* Header: seal + wordmark, as on the site card */}
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <svg width="52" height="52" viewBox="0 0 32 32" fill="none">
          <path d={SEAL_EDGE_PATH} stroke={ACCENT} strokeWidth="1.3" />
          <circle cx="16" cy="16" r="10.4" stroke={ACCENT} strokeOpacity="0.45" strokeWidth="0.6" />
          <path d={SEAL_C_PATH} stroke={ACCENT} strokeWidth="2.7" />
        </svg>
        <div style={{ fontFamily: "Bodoni Moda", fontSize: 36, color: INK }}>Cachet</div>
        <div style={{ fontSize: 15, letterSpacing: 5, color: MUTED, marginLeft: 10 }}>
          ZCASH SHIELDED ASSET · TESTNET
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
            backgroundColor: "#10281f",
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
            <div style={{ display: "flex", opacity: 0.7 }}>
              <svg width="230" height="230" viewBox="0 0 32 32" fill="none">
                <path d={SEAL_EDGE_PATH} stroke={ACCENT} strokeWidth="1.3" />
                <circle
                  cx="16"
                  cy="16"
                  r="10.4"
                  stroke={ACCENT}
                  strokeOpacity="0.45"
                  strokeWidth="0.6"
                />
                <path d={SEAL_C_PATH} stroke={ACCENT} strokeWidth="2.7" />
              </svg>
            </div>
          )}
        </div>

        <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flexGrow: 1 }}>
          <div style={{ fontSize: 17, letterSpacing: 6, color: ACCENT }}>
            {card ? "ASSET" : "REGISTRY ENTRY"}
          </div>
          <div
            style={{
              display: "flex",
              marginTop: 16,
              fontFamily: "Bodoni Moda",
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
              <div style={{ fontSize: 34, fontWeight: 500, color: ACCENT }}>{card.supply}</div>
            </div>
          )}
          <div
            style={{
              display: "flex",
              marginTop: 20,
              fontFamily: "Bodoni Moda",
              fontSize: sealed ? 42 : 36,
              color: ACCENT,
            }}
          >
            {sealed ? "Sealed forever" : tag}
          </div>
        </div>
      </div>

      {/* Ledger double rule + signature line */}
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ height: 2, backgroundColor: "rgba(220,154,118,0.35)", display: "flex" }} />
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
        { name: "Bodoni Moda", data: display, style: "normal", weight: 500 },
        { name: "DM Mono", data: mono, style: "normal", weight: 400 },
        { name: "DM Mono", data: monoMedium, style: "normal", weight: 500 },
      ],
    },
  );
}
