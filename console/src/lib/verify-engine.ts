/**
 * Asset-id derivation, in the reader's browser.
 *
 * Re-hashing a bundle against the `sha256` inside an asset description
 * proves the bundle matches the description. It does not prove the
 * description is the one the chain committed to - a registry serving a
 * fabricated pair would pass that check.
 *
 * ZIP 227 makes the description checkable, because identity is derived:
 * an asset id is a function of the issuance validating key and the hash of
 * the description, both public. Recomputing it here and comparing against
 * the id the reader asked for closes the chain, with nothing trusted.
 *
 * The same derivation yields the asset's other ZIP 227 names (description
 * hash, Asset Digest), so a page can show them without taking them from
 * the registry either.
 *
 * The engine is a separate, much smaller wasm module than the mint one:
 * no proving circuit, ~250 KB, loaded on demand and only once per session.
 */

/** Bump on every rebuild of the verification engine, as for the mint one. */
const ENGINE_VERSION = "1a5bc03979ef";
const BASE = "/verify-engine";

/** What ZIP 227 derives from an issuer key and a description, in hex. */
export type AssetIdentity = {
  /** The Asset Base: the id the chain and the registry use. */
  assetId: string;
  /** BLAKE2b-256 of the description ("ZSA-AssetDescCRH"). */
  assetDescHash: string;
  /** BLAKE2b-512 of the encoded Asset Identifier ("ZSA-Asset-Digest"). */
  assetDigest: string;
};

/** The wasm-bindgen object: getters over wasm memory, freed by hand. */
type WasmIdentity = {
  asset_id: string;
  asset_desc_hash: string;
  asset_digest: string;
  free(): void;
};

type Derive = (issuanceKeyHex: string, description: string) => WasmIdentity;

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
    return mod.derive_identity as Derive;
  })();
}

/**
 * Derive the identity `issuanceKeyHex` would mint `description` under.
 *
 * The module is fetched once and reused; a failed load is not cached, so a
 * transient network error does not disable verification for the session.
 */
export async function deriveIdentity(
  issuanceKeyHex: string,
  description: string,
): Promise<AssetIdentity> {
  if (!engine) {
    engine = load().catch((error) => {
      engine = null;
      throw error;
    });
  }
  const derived = (await engine)(issuanceKeyHex, description);
  try {
    return {
      assetId: derived.asset_id,
      assetDescHash: derived.asset_desc_hash,
      assetDigest: derived.asset_digest,
    };
  } finally {
    derived.free();
  }
}
