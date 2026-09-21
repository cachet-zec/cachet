/**
 * Where a mint is, as a band of segments.
 *
 * The engine reports no percentage while it proves, so none is invented:
 * a segment is filled when its step really finished, the one in progress
 * carries a moving engraved wave, the rest wait. "Prove" is drawn wider
 * because it is where the time goes.
 */
const STEPS = [
  { label: "Seal", grow: 1 },
  { label: "Read", grow: 1 },
  { label: "Prove", grow: 4 },
  { label: "Relay", grow: 1 },
  { label: "Record", grow: 1 },
];

export function MintGauge({
  phase,
  steps,
  message,
}: {
  /** 1-based index of the step in progress. */
  phase: number;
  /** How many steps this run has: 3 when the transaction is handed over. */
  steps: number;
  message: string;
}) {
  return (
    <div data-testid="mint-gauge" className="mt-4" role="status" aria-live="polite">
      <div className="flex gap-1.5" aria-hidden>
        {STEPS.slice(0, steps).map((step, index) => {
          const position = index + 1;
          const done = position < phase;
          const current = position === phase;
          return (
            <div key={step.label} className="min-w-0" style={{ flexGrow: step.grow, flexBasis: 0 }}>
              <div
                className={`relative h-2.5 overflow-hidden rounded-[1px] border ${
                  done ? "border-accent bg-accent" : current ? "border-accent/70" : "border-line"
                }`}
              >
                {current && <span className="gauge-weave" />}
              </div>
              <p
                className={`font-data mt-1.5 truncate text-[13px] ${
                  done || current ? "text-accent" : "text-neutral-600"
                }`}
              >
                {step.label}
              </p>
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-sm leading-relaxed text-neutral-300">{message}</p>
    </div>
  );
}
