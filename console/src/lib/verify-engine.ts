/**
 * Asset-id derivation, in the reader's browser.
 *
 * Re-hashing a bundle against the `sha256` inside an on-chain description
 * proves the bundle matches the description. It does not prove the
 * description is the one the chain committed to - a registry serving a
 * fabricated pair would pass that check.
 *
 * ZIP 227 makes the description checkable, because identity is derived:
 * an asset id is a function of the issuance validating key and the hash of
 * the description, both public. Recomputing it here and comparing against
 * the id the reader asked for closes the chain, with nothing trusted.
 *
 * The engine is a separate, much smaller wasm module than the mint one:
 * no proving circuit, ~250 KB, loaded on demand and only once per session.
 */

/** Bump on every rebuild of the verification engine, as for the mint one. */
const ENGINE_VERSION = "1";
const BASE = "/verify-engine";

type Derive = (issuanceKeyHex: string, description: string) => string;

let engine: Promise<Derive> | null = null;

function load(): Promise<Derive> {
  return (async () => {
    // webpackIgnore: the engine is a static asset served as a plain ES
    // module, not something the bundler should try to resolve.
    const mod = await import(
      /* webpackIgnore: true */ `${BASE}/cachet_verify_engine.js?v=${ENGINE_VERSION}`
    );
    await mod.default({
      module_or_path: `${BASE}/cachet_verify_engine_bg.wasm?v=${ENGINE_VERSION}`,
    });
    return mod.derive_asset_id as Derive;
  })();
}

/**
 * Derive the asset id `issuanceKeyHex` would mint `description` under.
 *
 * The module is fetched once and reused; a failed load is not cached, so a
 * transient network error does not disable verification for the session.
 */
export async function deriveAssetId(issuanceKeyHex: string, description: string): Promise<string> {
  if (!engine) {
    engine = load().catch((error) => {
      engine = null;
      throw error;
    });
  }
  return (await engine)(issuanceKeyHex, description);
}
