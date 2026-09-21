import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ImageResponse } from "next/og";

import { SEAL_C_PATH, SEAL_EDGE_PATH } from "@/components/seal-mark";

export const alt = "Cachet · shielded asset issuance on Zcash";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const ACCENT = "#dc9a76";
const INK = "#edf3ee";
const MUTED = "#a4b8aa";

const font = (file: string) => readFile(join(process.cwd(), "src/app/og-fonts", file));

/** Social-card image: the site's lockup - the pressed seal, the landing's own headline in
 *  the display face, ledger rule. */
export default async function OpenGraphImage() {
  const [display, mono, monoMedium] = await Promise.all([
    font("BodoniModa-Medium.ttf"),
    font("DMMono-Regular.ttf"),
    font("DMMono-Medium.ttf"),
  ]);

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        padding: "56px 72px 48px",
        backgroundColor: "#0b1d18",
        backgroundImage: "radial-gradient(circle at 18% 0%, #17352b 0%, #0b1d18 55%)",
        color: INK,
        fontFamily: "DM Mono",
      }}
    >
      {/* Watermark seal, bleeding off the right edge like the hero. */}
      <div style={{ position: "absolute", top: -190, right: -170, display: "flex", opacity: 0.1 }}>
        <svg width="680" height="680" viewBox="0 0 32 32" fill="none">
          <path d={SEAL_EDGE_PATH} stroke={ACCENT} strokeWidth="1.3" />
          <circle cx="16" cy="16" r="10.4" stroke={ACCENT} strokeOpacity="0.45" strokeWidth="0.6" />
          <path d={SEAL_C_PATH} stroke={ACCENT} strokeWidth="2.7" />
        </svg>
      </div>

      {/* Header: seal + wordmark */}
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <svg width="60" height="60" viewBox="0 0 32 32" fill="none">
          <path d={SEAL_EDGE_PATH} stroke={ACCENT} strokeWidth="1.3" />
          <circle cx="16" cy="16" r="10.4" stroke={ACCENT} strokeOpacity="0.45" strokeWidth="0.6" />
          <path d={SEAL_C_PATH} stroke={ACCENT} strokeWidth="2.7" />
        </svg>
        <div style={{ fontFamily: "Bodoni Moda", fontSize: 42, color: INK }}>Cachet</div>
      </div>

      {/* Hero block */}
      <div style={{ display: "flex", flexDirection: "column", marginTop: 46, flexGrow: 1 }}>
        <div style={{ fontSize: 19, letterSpacing: 7, color: ACCENT }}>
          ISSUANCE CONSOLE · VERIFIABLE REGISTRY
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            marginTop: 22,
            fontFamily: "Bodoni Moda",
            fontSize: 86,
            lineHeight: 1.04,
            letterSpacing: -1,
            color: "#f5f9f6",
          }}
        >
          <div style={{ display: "flex" }}>Issue shielded assets</div>
          <div style={{ display: "flex" }}>on Zcash.</div>
        </div>
        <div style={{ marginTop: 24, fontSize: 23, lineHeight: 1.6, color: MUTED, maxWidth: 900 }}>
          Public supplies, shielded balances, metadata sealed on-chain. Minted from your browser.
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
            marginTop: 22,
          }}
        >
          <div style={{ fontFamily: "DM Mono", fontWeight: 500, fontSize: 24, color: INK }}>
            cachetzec.com
          </div>
          <div
            style={{
              display: "flex",
              transform: "rotate(-4deg)",
              border: "2px solid rgba(220,154,118,0.75)",
              borderRadius: 4,
              padding: "8px 16px",
              fontSize: 19,
              letterSpacing: 5,
              color: ACCENT,
            }}
          >
            TESTNET
          </div>
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
