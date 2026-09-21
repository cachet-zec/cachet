/**
 * Public origin this deployment is served from.
 *
 * Used for canonical metadata, robots.txt and sitemap.xml, which all need
 * absolute URLs. Like the API origin, it is baked into the bundle at build
 * time, so it is a build arg rather than a runtime variable - a self-hoster
 * sets it once in `infra/prod/deploy.sh` and their robots.txt stops pointing
 * at somebody else's box.
 */
export const SITE_URL = process.env.NEXT_PUBLIC_CACHET_SITE_URL ?? "https://cachetzec.com";

/**
 * Shielded unified address for donations. Mainnet ZEC: the one thing on
 * this site that is not testnet.
 */
export const DONATION_ADDRESS =
  "u1rkcc55ajpuvwxlml7rnk9lx9gu54hzzyzr356n7czrtral9p2zdcw5sm3htj9pvrl2mzx036qkejt7pkjk90kvedk6x9nghdqxv892w4wqdtxmagxsj8pynu9pr9al540dx4jg9saekeea5dmafaa09fqvcdgptxffre68uxdsu674u8";

/**
 * Asset ids the landing showcase leads with, in display order.
 *
 * The landing is editorial; the console lists everything. Baked at build
 * time like the site URL (NEXT_PUBLIC_CACHET_FEATURED_ASSETS, comma
 * separated). Malformed entries are dropped rather than sent to the API.
 */
export const FEATURED_ASSET_IDS: readonly string[] = (
  process.env.NEXT_PUBLIC_CACHET_FEATURED_ASSETS ?? ""
)
  .split(",")
  .map((id) => id.trim().toLowerCase())
  .filter((id) => /^[0-9a-f]{64}$/.test(id));

/**
 * Optional block explorer, as two build-time URL templates (`{height}`,
 * `{txid}`): explorers do not agree on paths. Unset, heights and txids
 * stay plain text.
 */
function explorerTemplate(value: string | undefined, placeholder: string): string | null {
  const template = value?.trim() ?? "";
  return /^https?:\/\//.test(template) && template.includes(placeholder) ? template : null;
}

const EXPLORER_BLOCK = explorerTemplate(
  process.env.NEXT_PUBLIC_CACHET_EXPLORER_BLOCK_URL,
  "{height}",
);
const EXPLORER_TX = explorerTemplate(process.env.NEXT_PUBLIC_CACHET_EXPLORER_TX_URL, "{txid}");

export function explorerBlockUrl(height: number): string | null {
  return EXPLORER_BLOCK && Number.isSafeInteger(height) && height >= 0
    ? EXPLORER_BLOCK.replace("{height}", String(height))
    : null;
}

export function explorerTxUrl(txid: string): string | null {
  return EXPLORER_TX && /^[0-9a-f]{64}$/i.test(txid) ? EXPLORER_TX.replace("{txid}", txid) : null;
}
