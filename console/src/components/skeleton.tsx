/**
 * Loading placeholders shaped like what is coming, so the page does not
 * jump when it arrives. A bone is a block with a slow light passing over
 * it; under reduced-motion settings it is just the block.
 */
export function Bone({ className = "" }: { className?: string }) {
  return <span aria-hidden className={`bone block ${className}`} />;
}

const NAME_WIDTHS = ["w-2/5", "w-3/5", "w-1/3", "w-1/2", "w-2/3"];

/**
 * Rows of the registry, an issuer's list or the landing's entries: an index
 * where the real row has one, a thumbnail, a name over an id, a figure.
 */
export function AssetRowsSkeleton({
  rows,
  index = true,
  thumb = "h-9 w-9",
  className = "",
}: {
  rows: number;
  index?: boolean;
  /** Size classes of the real row's thumbnail. */
  thumb?: string;
  className?: string;
}) {
  return (
    <div role="status" aria-label="Loading" className={`flex flex-col ${className}`}>
      {Array.from({ length: rows }, (_, row) => (
        <div
          key={row}
          className="flex items-center gap-3.5 border-b border-line py-3 pl-1 pr-1.5 last:border-b-0"
        >
          {index && <Bone className="h-3.5 w-6 shrink-0" />}
          <Bone className={`${thumb} shrink-0 rounded-sm`} />
          <div className="min-w-0 flex-1">
            {/* same line boxes as the real row: a 24px name line over a 20px id line */}
            <div className="flex h-6 items-center justify-between gap-3">
              {/* widths vary so the block does not read as a table of nothing */}
              <Bone className={`h-4 ${NAME_WIDTHS[row % NAME_WIDTHS.length]}`} />
              <Bone className="h-3.5 w-16 shrink-0" />
            </div>
            <div className="mt-0.5 flex h-5 items-center">
              <Bone className="h-3 w-4/5" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
