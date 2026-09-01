import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

const GOLD = "#e8b23a";

/**
 * Home-screen icon for iOS.
 *
 * Safari probes /apple-touch-icon.png on every visit and was getting a 404;
 * this both silences that and gives the site a real icon when someone saves
 * it. Same lockup as icon.svg - double band, serif C - drawn with borders
 * rather than SVG because satori renders those predictably.
 */
export default async function AppleIcon() {
  const display = await readFile(join(process.cwd(), "src/app/og-fonts/Fraunces-SemiBold.ttf"));

  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#0b0a08",
      }}
    >
      <div
        style={{
          width: 153,
          height: 153,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          border: `8px solid ${GOLD}`,
          borderRadius: "50%",
        }}
      >
        <div
          style={{
            width: 122,
            height: 122,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "4px solid rgba(232, 178, 58, 0.4)",
            borderRadius: "50%",
          }}
        >
          <div
            style={{
              display: "flex",
              fontFamily: "Fraunces",
              fontSize: 78,
              color: GOLD,
              // Optical centering: the serif C sits high on its baseline.
              marginTop: 6,
            }}
          >
            C
          </div>
        </div>
      </div>
    </div>,
    { ...size, fonts: [{ name: "Fraunces", data: display, style: "normal", weight: 600 }] },
  );
}
