import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ImageResponse } from "next/og";

export const alt = "Cachet · shielded asset issuance on Zcash";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const GOLD = "#e8b23a";
const INK = "#eae5db";
const MUTED = "#9c968a";

const font = (file: string) => readFile(join(process.cwd(), "src/app/og-fonts", file));

/** Social-card image: the site's editorial lockup — seal, serif headline, ledger rule. */
export default async function OpenGraphImage() {
  const [display, displayItalic, mono, monoMedium] = await Promise.all([
    font("Fraunces-SemiBold.ttf"),
    font("Fraunces-SemiBoldItalic.ttf"),
    font("IBMPlexMono-Regular.ttf"),
    font("IBMPlexMono-Medium.ttf"),
  ]);

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        padding: "56px 72px 48px",
        backgroundColor: "#0b0a08",
        backgroundImage: "radial-gradient(circle at 18% 0%, #16130d 0%, #0b0a08 55%)",
        color: INK,
        fontFamily: "IBM Plex Mono",
      }}
    >
      {/* Watermark seal, bleeding off the right edge like the hero. */}
      <div
        style={{
          position: "absolute",
          top: -170,
          right: -150,
          width: 640,
          height: 640,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 9999,
          border: "2px solid rgba(232,178,58,0.14)",
        }}
      >
        <div
          style={{
            width: 540,
            height: 540,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 9999,
            border: "2px solid rgba(232,178,58,0.08)",
            fontFamily: "Fraunces",
            fontSize: 380,
            color: "rgba(232,178,58,0.06)",
          }}
        >
          C
        </div>
      </div>

      {/* Header: seal + wordmark */}
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 54,
            height: 54,
            borderRadius: 9999,
            border: "3px solid " + GOLD,
            fontFamily: "Fraunces",
            fontSize: 30,
            color: GOLD,
          }}
        >
          C
        </div>
        <div style={{ fontFamily: "Fraunces", fontSize: 38, color: INK }}>Cachet</div>
      </div>

      {/* Hero block */}
      <div style={{ display: "flex", flexDirection: "column", marginTop: 64, flexGrow: 1 }}>
        <div style={{ fontSize: 19, letterSpacing: 7, color: GOLD }}>
          ISSUANCE CONSOLE · VERIFIABLE REGISTRY
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            marginTop: 22,
            fontFamily: "Fraunces",
            fontSize: 84,
            lineHeight: 1.08,
            letterSpacing: -1,
            color: "#fafafa",
          }}
        >
          <div style={{ display: "flex" }}>
            <span>Mint&nbsp;</span>
            <span style={{ fontStyle: "italic", color: GOLD }}>shielded</span>
            <span>&nbsp;assets</span>
          </div>
          <div style={{ display: "flex" }}>on Zcash.</div>
        </div>
        <div style={{ marginTop: 30, fontSize: 23, lineHeight: 1.7, color: MUTED, maxWidth: 900 }}>
          Your keys never leave your browser. Public supplies, shielded balances, metadata sealed
          on-chain.
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
            marginTop: 22,
          }}
        >
          <div style={{ fontFamily: "IBM Plex Mono", fontWeight: 500, fontSize: 24, color: INK }}>
            cachetzec.com
          </div>
          <div
            style={{
              display: "flex",
              transform: "rotate(-4deg)",
              border: "2px solid rgba(232,178,58,0.75)",
              borderRadius: 4,
              padding: "8px 16px",
              fontSize: 19,
              letterSpacing: 5,
              color: GOLD,
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
        { name: "Fraunces", data: display, style: "normal", weight: 600 },
        { name: "Fraunces", data: displayItalic, style: "italic", weight: 600 },
        { name: "IBM Plex Mono", data: mono, style: "normal", weight: 400 },
        { name: "IBM Plex Mono", data: monoMedium, style: "normal", weight: 500 },
      ],
    },
  );
}
