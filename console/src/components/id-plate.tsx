/**
 * The plate of an asset that sealed no image: a rosette drawn from its id.
 * Decoration, not evidence. Coordinates are rounded so the markup is stable.
 */

const C = 200;

function polar(radiusAt: (t: number) => number, steps = 360): string {
  const points: string[] = [];
  for (let i = 0; i < steps; i++) {
    const t = (2 * Math.PI * i) / steps;
    const r = radiusAt(t);
    points.push(`${(C + r * Math.cos(t)).toFixed(2)} ${(C + r * Math.sin(t)).toFixed(2)}`);
  }
  return `M${points.join(" L")} Z`;
}

export function IdPlate({ assetId, className = "" }: { assetId: string; className?: string }) {
  const byte = (index: number) => parseInt(assetId.slice(index * 2, index * 2 + 2), 16) || 0;

  const petals = 7 + (byte(1) % 6); // 7..12 woven ellipses
  const petalHeight = 64 + (byte(2) % 56); // how open the weave is
  const roseLobes = 5 + (byte(3) % 8); // 5..12
  const roseDepth = 14 + (byte(4) % 14);
  const edgeLobes = 24 + 2 * (byte(5) % 9); // 24..40 scallops
  const turn = byte(6) % 30;

  return (
    <svg viewBox="0 0 400 400" aria-hidden className={className}>
      <rect width="400" height="400" fill="var(--color-surface)" />
      <g fill="none" stroke="var(--color-accent)">
        {Array.from({ length: 9 }, (_, i) => (
          <circle
            key={`ring-${i}`}
            cx={C}
            cy={C}
            r={72 + i * 12}
            strokeWidth="0.7"
            opacity={0.34 - i * 0.025}
          />
        ))}
        <g transform={`rotate(${turn} ${C} ${C})`}>
          {Array.from({ length: petals }, (_, i) => (
            <ellipse
              key={`petal-${i}`}
              cx={C}
              cy={C}
              rx="176"
              ry={petalHeight}
              strokeWidth="0.7"
              opacity="0.3"
              transform={`rotate(${((i * 180) / petals).toFixed(2)} ${C} ${C})`}
            />
          ))}
          <path
            d={polar((t) => 126 + roseDepth * Math.cos(roseLobes * t))}
            strokeWidth="1"
            opacity="0.55"
          />
          <path
            d={polar((t) => 126 - roseDepth * Math.cos(roseLobes * t))}
            strokeWidth="1"
            opacity="0.3"
          />
        </g>
        <path
          d={polar((t) => 186 + 3.2 * Math.cos(edgeLobes * t), 720)}
          strokeWidth="1.2"
          opacity="0.7"
        />
      </g>
      <circle
        cx={C}
        cy={C}
        r="52"
        fill="var(--color-ground)"
        stroke="var(--color-accent)"
        strokeOpacity="0.6"
      />
      <text
        x={C}
        y={C}
        textAnchor="middle"
        dominantBaseline="central"
        className="font-data"
        fontSize="34"
        fill="var(--color-neutral-200)"
      >
        {assetId.slice(0, 2)}
      </text>
    </svg>
  );
}
