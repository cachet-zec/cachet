/**
 * Anti-phishing display rule (shared with ZIP 227 guidance): a name is
 * never rendered without its provenance.
 *
 * - `envelope`  — sealed into the asset id via the metadata hash: a real name.
 * - `zmd1`      — on-chain machine identifier (`slug #index`): monospace.
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
        <span className="font-data min-w-0 truncate text-xs text-neutral-500">
          {assetId.slice(0, 12)}…
        </span>
        <span className="shrink-0 text-xs italic text-neutral-600">unresolved</span>
      </span>
    );
  }
  if (source === "zmd1") {
    return (
      <span
        className="font-data truncate text-sm text-neutral-200"
        title="ZMD-1 descriptor: an on-chain machine identifier"
      >
        {name}
      </span>
    );
  }
  if (source === "free_text") {
    return (
      <span
        className="truncate text-sm italic text-neutral-400"
        title="Free-text on-chain description, not a verified name"
      >
        {name}
      </span>
    );
  }
  return <span className="truncate text-sm text-neutral-200">{name}</span>;
}
