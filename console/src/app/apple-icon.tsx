import { ImageResponse } from "next/og";

import { SEAL_C_PATH, SEAL_EDGE_PATH } from "@/components/seal-mark";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

const ACCENT = "#dc9a76";
const GROUND = "#0b1d18";

/**
 * Home-screen icon for iOS.
 *
 * Safari probes /apple-touch-icon.png on every visit and was getting a 404;
 * this both silences that and gives the site a real icon when someone saves
 * it. Same mark as icon.svg: the scalloped seal edge around an open ring.
 * Pure geometry, so no font file is read here.
 */
export default function AppleIcon() {
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: GROUND,
      }}
    >
      <svg width="150" height="150" viewBox="0 0 32 32" fill="none">
        <path d={SEAL_EDGE_PATH} stroke={ACCENT} strokeWidth="1.3" />
        <circle cx="16" cy="16" r="10.4" stroke={ACCENT} strokeOpacity="0.45" strokeWidth="0.6" />
        <path d={SEAL_C_PATH} stroke={ACCENT} strokeWidth="2.7" />
      </svg>
    </div>,
    size,
  );
}
