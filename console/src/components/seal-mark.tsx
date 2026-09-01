/**
 * The Cachet seal: a clean double band and a serif C. Drawn once here;
 * the favicon mirrors it.
 */
export function SealMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="shrink-0">
      {/* main band */}
      <circle cx="16" cy="16" r="14" fill="none" stroke="#e8b23a" strokeWidth="1.4" />
      <circle
        cx="16"
        cy="16"
        r="12.2"
        fill="none"
        stroke="rgba(232,178,58,0.35)"
        strokeWidth="0.7"
      />
      <text
        x="16"
        y="21.3"
        textAnchor="middle"
        fontFamily="Georgia, serif"
        fontSize="14"
        fontWeight="700"
        fill="#e8b23a"
      >
        C
      </text>
    </svg>
  );
}

/**
 * A huge, faint, engraved version of the seal for page backgrounds —
 * guilloché-style concentric linework, like the embossed seal on an
 * official document. Render inside a relatively-positioned container.
 */
export function SealWatermark({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 600 600"
      aria-hidden
      className={`pointer-events-none select-none ${className}`}
    >
      {/* engraved concentric field */}
      {Array.from({ length: 14 }, (_, i) => (
        <circle
          key={`ring-${i}`}
          cx="300"
          cy="300"
          r={90 + i * 14}
          fill="none"
          stroke="#e8b23a"
          strokeWidth="0.8"
          opacity={0.5 - i * 0.025}
        />
      ))}
      {/* guilloché: offset ellipses woven through the rings. The group
          turns once every five minutes (CSS) — the engraving is alive,
          the C never moves. */}
      <g className="seal-guilloche">
        {Array.from({ length: 12 }, (_, i) => (
          <ellipse
            key={`g1-${i}`}
            cx="300"
            cy="300"
            rx="278"
            ry="150"
            fill="none"
            stroke="#e8b23a"
            strokeWidth="0.6"
            opacity="0.22"
            transform={`rotate(${i * 15} 300 300)`}
          />
        ))}
      </g>
      {/* outer edge */}
      <circle
        cx="300"
        cy="300"
        r="292"
        fill="none"
        stroke="#e8b23a"
        strokeWidth="2"
        opacity="0.55"
      />
      <circle
        cx="300"
        cy="300"
        r="86"
        fill="none"
        stroke="#e8b23a"
        strokeWidth="1.4"
        opacity="0.7"
      />
      <text
        x="300"
        y="345"
        textAnchor="middle"
        fontFamily="Georgia, serif"
        fontSize="130"
        fontWeight="700"
        fill="#e8b23a"
        opacity="0.55"
      >
        C
      </text>
    </svg>
  );
}
