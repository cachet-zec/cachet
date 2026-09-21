/**
 * The Cachet seal: the scalloped edge of a pressed seal around an open
 * ring that reads as a C. Pure geometry, so it holds from a small icon
 * to a poster. The favicon is a deliberate simplification (fewer, deeper
 * scallops and no inner ring) so the mark survives at 16px.
 */
/** The scalloped edge, in the mark's 32-unit viewBox. Exported so the
 *  social cards and icons draw the same outline instead of a copy. */
export const SEAL_EDGE_PATH =
  "M30.05 16.00 L29.92 16.46 L29.56 16.89 L29.09 17.29 L28.66 17.67 L28.40 18.05 L28.36 18.46 L28.55 18.93 L28.85 19.44 L29.13 19.98 L29.25 20.50 L29.14 20.94 L28.78 21.29 L28.25 21.55 L27.67 21.76 L27.18 21.98 L26.87 22.27 L26.76 22.69 L26.82 23.23 L26.93 23.83 L26.97 24.42 L26.85 24.90 L26.52 25.23 L26.01 25.38 L25.40 25.40 L24.81 25.40 L24.31 25.48 L23.97 25.71 L23.77 26.13 L23.66 26.69 L23.55 27.30 L23.35 27.82 L23.03 28.17 L22.56 28.28 L22.01 28.19 L21.43 27.98 L20.89 27.80 L20.43 27.76 L20.05 27.94 L19.74 28.33 L19.44 28.85 L19.11 29.36 L18.73 29.72 L18.29 29.85 L17.81 29.71 L17.32 29.38 L16.85 28.99 L16.41 28.67 L16.00 28.55 L15.59 28.67 L15.15 28.99 L14.68 29.38 L14.19 29.71 L13.71 29.85 L13.27 29.72 L12.89 29.36 L12.56 28.85 L12.26 28.33 L11.95 27.94 L11.57 27.76 L11.11 27.80 L10.57 27.98 L9.99 28.19 L9.44 28.28 L8.98 28.17 L8.65 27.82 L8.45 27.30 L8.34 26.69 L8.23 26.13 L8.03 25.71 L7.69 25.48 L7.19 25.40 L6.60 25.40 L5.99 25.38 L5.48 25.23 L5.15 24.90 L5.03 24.42 L5.07 23.83 L5.18 23.23 L5.24 22.69 L5.13 22.27 L4.82 21.98 L4.33 21.76 L3.75 21.55 L3.22 21.29 L2.86 20.94 L2.75 20.50 L2.87 19.98 L3.15 19.44 L3.45 18.93 L3.64 18.46 L3.60 18.05 L3.34 17.67 L2.91 17.29 L2.44 16.89 L2.08 16.46 L1.95 16.00 L2.08 15.54 L2.44 15.11 L2.91 14.71 L3.34 14.33 L3.60 13.95 L3.64 13.54 L3.45 13.07 L3.15 12.56 L2.87 12.02 L2.75 11.50 L2.86 11.06 L3.22 10.71 L3.75 10.45 L4.33 10.24 L4.82 10.02 L5.13 9.73 L5.24 9.31 L5.18 8.77 L5.07 8.17 L5.03 7.58 L5.15 7.10 L5.48 6.77 L5.99 6.62 L6.60 6.60 L7.19 6.60 L7.69 6.52 L8.03 6.29 L8.23 5.87 L8.34 5.31 L8.45 4.70 L8.65 4.18 L8.97 3.83 L9.44 3.72 L9.99 3.81 L10.57 4.02 L11.11 4.20 L11.57 4.24 L11.95 4.06 L12.26 3.67 L12.56 3.15 L12.89 2.64 L13.27 2.28 L13.71 2.15 L14.19 2.29 L14.68 2.62 L15.15 3.01 L15.59 3.33 L16.00 3.45 L16.41 3.33 L16.85 3.01 L17.32 2.62 L17.81 2.29 L18.29 2.15 L18.73 2.28 L19.11 2.64 L19.44 3.15 L19.74 3.67 L20.05 4.06 L20.43 4.24 L20.89 4.20 L21.43 4.02 L22.01 3.81 L22.56 3.72 L23.03 3.83 L23.35 4.18 L23.55 4.70 L23.66 5.31 L23.77 5.87 L23.97 6.29 L24.31 6.52 L24.81 6.60 L25.40 6.60 L26.01 6.62 L26.52 6.77 L26.85 7.10 L26.97 7.58 L26.93 8.17 L26.82 8.77 L26.76 9.31 L26.87 9.72 L27.18 10.02 L27.67 10.24 L28.25 10.45 L28.78 10.71 L29.14 11.06 L29.25 11.50 L29.13 12.02 L28.85 12.56 L28.55 13.07 L28.36 13.54 L28.40 13.95 L28.66 14.33 L29.09 14.71 L29.56 15.11 L29.92 15.54 Z";

/** The C: an open ring centred on the mark. */
export const SEAL_C_PATH = "M20.55 19.43 A5.7 5.7 0 1 1 20.55 12.57";

export function SealMark({ size = 28 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden
      className="shrink-0 text-accent"
      fill="none"
      stroke="currentColor"
    >
      {/* the scalloped edge of a pressed seal */}
      <path d={SEAL_EDGE_PATH} strokeWidth="1.3" className="seal-edge" />
      <circle cx="16" cy="16" r="10.4" strokeOpacity="0.45" strokeWidth="0.6" />
      {/* the C: an open ring, no typeface needed at any size */}
      <path d={SEAL_C_PATH} strokeWidth="2.7" />
    </svg>
  );
}

/**
 * The mark's C at the watermark's scale: the same open ring, centred on the
 * 600-unit drawing, opening to the right by the same angle as SEAL_C_PATH
 * (its ends sit at +-37 degrees). In the mark the C is 0.55 of the inner
 * ring's radius and a quarter of it thick; here that band, 36 to 58 units
 * inside the 86-unit ring, is cut as six fine lines.
 */
const C_BAND = [36, 40.4, 44.8, 49.2, 53.6, 58];
function openRing(radius: number): string {
  const x = (300 + radius * 0.7986).toFixed(2);
  const rise = radius * 0.6018;
  return `M${x} ${(300 + rise).toFixed(2)} A${radius} ${radius} 0 1 1 ${x} ${(300 - rise).toFixed(2)}`;
}

/**
 * A huge, faint, engraved version of the seal for page backgrounds —
 * guilloché-style concentric linework, like the embossed seal on an
 * official document. Render inside a relatively-positioned container.
 */
export function SealWatermark({ className = "" }: { className?: string }) {
  // Every shape draws itself, stands, is carried off past its own end and
  // starts again, each a little after the one before (`--i`, globals.css).
  // The two sets of ellipses are their own layers so their slow turning is
  // the compositor's work; the layers carry the watermark's opacity.
  const layer = "absolute inset-0 h-full w-full";
  const weave = (parity: number) =>
    Array.from({ length: 12 }, (_, i) => i)
      .filter((i) => i % 2 === parity)
      .map((i) => (
        <ellipse
          key={i}
          pathLength={1}
          className="seal-draw"
          style={{ "--i": 10 + i } as React.CSSProperties}
          cx="300"
          cy="300"
          rx="278"
          ry="150"
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth="0.8"
          opacity="0.22"
          transform={`rotate(${i * 15} 300 300)`}
        />
      ));

  return (
    <div aria-hidden className={`pointer-events-none aspect-square select-none ${className}`}>
      {/* engraved concentric field */}
      <svg viewBox="0 0 600 600" className={`${layer} seal-rings`}>
        {Array.from({ length: 14 }, (_, i) => (
          <circle
            key={`ring-${i}`}
            pathLength={1}
            className="seal-draw"
            style={{ "--i": i } as React.CSSProperties}
            cx="300"
            cy="300"
            r={90 + i * 14}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth="1"
            opacity={0.5 - i * 0.025}
          />
        ))}
        <circle
          pathLength={1}
          className="seal-draw"
          style={{ "--i": 27 } as React.CSSProperties}
          cx="300"
          cy="300"
          r="292"
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth="1.6"
          opacity="0.26"
        />
        <circle
          pathLength={1}
          className="seal-draw"
          style={{ "--i": 4 } as React.CSSProperties}
          cx="300"
          cy="300"
          r="86"
          fill="none"
          stroke="var(--color-accent)"
          strokeWidth="1.4"
          opacity="0.7"
        />
        {/* the C, engraved: the mark's open ring cut as a band of fine
            lines rather than one heavy stroke, and the last thing drawn */}
        {C_BAND.map((radius, line) => (
          <path
            key={`c-${radius}`}
            d={openRing(radius)}
            pathLength={1}
            className="seal-draw"
            style={{ "--i": 29 + line * 2 } as React.CSSProperties}
            fill="none"
            stroke="var(--color-accent)"
            strokeWidth="1.3"
            strokeLinecap="round"
            opacity="0.8"
          />
        ))}
      </svg>

      {/* guilloché: two sets of woven ellipses turning against each other,
          so the pattern between them never stops changing, the way a real
          guilloché shimmers when the paper moves. The pair also turns with
          the scroll where the browser can. */}
      <div className={`${layer} seal-guilloche`}>
        <svg viewBox="0 0 600 600" className={`${layer} seal-weave-a`}>
          {weave(0)}
        </svg>
        <svg viewBox="0 0 600 600" className={`${layer} seal-weave-b`}>
          {weave(1)}
        </svg>
      </div>
    </div>
  );
}
