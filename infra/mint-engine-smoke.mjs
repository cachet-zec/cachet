// Smoke test for the single-core mint engine module: loads the wasm from
// disk in Node, derives keys, checks the proving-key cache and the wallet
// exports. Fast (no proving). Used locally and by the CI wasm job:
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

console.log(
  `smoke ok: seed/issuer/asset-id/wallet derivations pass; ` +
    `proving key built in ${(first / 1000).toFixed(1)}s, cached hit ${second}ms`,
);
