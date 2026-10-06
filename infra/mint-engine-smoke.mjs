// Smoke test for the single-core mint engine module: loads the wasm from
// disk in Node, derives keys, checks the proving-key cache and the wallet
// exports. Then the verification engine: it must derive the published
// ZIP 227 vectors and agree with the mint engine on an asset id. Fast (no
// proving). Used locally and by the CI wasm job:
//   node infra/mint-engine-smoke.mjs
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "console", "public", "mint-engine");

const engine = await import(
  new URL(`file://${join(dir, "cachet_mint_engine.js").replaceAll("\\", "/")}`)
);
await engine.default(readFileSync(join(dir, "cachet_mint_engine_bg.wasm")));

const seed = engine.generate_seed_phrase();
if (seed.split(" ").length !== 24) throw new Error("seed generation failed");

const info = engine.issuer_info(seed, "smoke");
if (!/^[0-9a-f]{66}$/.test(info.issuer)) throw new Error("issuer derivation failed");
if (!/^[0-9a-f]{64}$/.test(info.asset_id)) throw new Error("asset-id derivation failed");

const wallet = engine.wallet_reset(seed);
if (!wallet.address.startsWith("u")) throw new Error("wallet address encoding failed");
if (wallet.scanned_height !== 0 || wallet.holdings.length !== 0)
  throw new Error("fresh wallet state is not empty");

// The proving-key cache: second call must be instant.
let t = Date.now();
engine.prepare_proving();
const first = Date.now() - t;
t = Date.now();
engine.prepare_proving();
const second = Date.now() - t;
if (second > 1000) throw new Error(`proving-key cache miss: second prepare took ${second}ms`);

// The verification engine, as the asset page loads it.
const verifyDir = join(root, "console", "public", "verify-engine");
const verify = await import(
  new URL(`file://${join(verifyDir, "cachet_verify_engine.js").replaceAll("\\", "/")}`)
);
await verify.default({
  module_or_path: readFileSync(join(verifyDir, "cachet_verify_engine_bg.wasm")),
});

function identity(issuer, description) {
  const derived = verify.derive_identity(issuer, description);
  try {
    return {
      asset_id: derived.asset_id,
      asset_desc_hash: derived.asset_desc_hash,
      asset_digest: derived.asset_digest,
    };
  } finally {
    derived.free();
  }
}

// Both engines must name the same asset for the same issuer and description.
if (identity(info.issuer, "smoke").asset_id !== info.asset_id)
  throw new Error("the verification engine disagrees with the mint engine on an asset id");

const vectors = JSON.parse(
  readFileSync(join(root, "packages", "registry-spec", "vectors", "zip227-identity.json"), "utf8"),
).vectors;
for (const vector of vectors) {
  const derived = identity(vector.issuer, vector.description);
  for (const field of ["asset_desc_hash", "asset_digest", "asset_id"]) {
    if (derived[field] !== vector[field])
      throw new Error(`ZIP 227 vector "${vector.description}": ${field} differs`);
  }
}

console.log(
  `smoke ok: seed/issuer/asset-id/wallet derivations pass; ` +
    `verification engine matches ${vectors.length} ZIP 227 vectors; ` +
    `proving key built in ${(first / 1000).toFixed(1)}s, cached hit ${second}ms`,
);
