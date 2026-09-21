/**
 * Anti-phishing display rule (shared with ZIP 227 guidance): a name is
 * never rendered without its provenance.
 *
 * - `envelope`  — sealed into the asset id via the metadata hash: a real name.
 * - `free_text` — issuer-chosen, unverified label: dimmed italic.
 * - none        — unresolved: only the asset id identifies it.
 */
export function AssetName({
  name,
  source,
  assetId,
}: {
  name: string | null | undefined;
  source: string | null | undefined;
  assetId: string;
}) {
  if (!name) {
    return (
      <span
        className="flex min-w-0 items-baseline gap-2 overflow-hidden"
        title="Unresolved: no description is known for this asset"
      >
        <span className="font-data min-w-0 truncate text-sm text-neutral-500">
          {assetId.slice(0, 12)}…
        </span>
        <span className="shrink-0 text-[13px] italic text-neutral-600">unresolved</span>
      </span>
    );
  }
  if (source === "free_text") {
    // `truncate` clips an italic's last glyph: pad the box, pull the margin back.
    return (
      <span
        className="-mr-[0.1em] truncate pr-[0.25em] text-[17px] italic text-neutral-300"
        title="Free-text on-chain description, not a verified name"
      >
        {name}
      </span>
    );
  }
  return <span className="truncate text-[17px] text-neutral-100">{name}</span>;
}
