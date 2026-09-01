// Web Worker host for the Cachet mint engine (WASM).
//
// Everything key-related runs HERE, off the main thread: seed handling,
// ZIP-32 derivation, Halo2 proving, BIP-340 signing. The page only ever
// receives public artifacts (issuer key, asset ids, the signed tx bytes)
// and the server only ever receives the finished transaction.
//
// Two engine builds exist: `/mint-engine-mt/` proves on all cores via
// shared-memory wasm threads but needs a cross-origin-isolated page;
// `/mint-engine/` is the single-core build that works everywhere. The
// selection is made once, on first use, and falls back silently.
let enginePromise = null;
let engineThreads = 1;

// Bump on every engine rebuild: /mint-engine*/ is cached for an hour
// (see next.config.ts), and the version query is what busts that cache
// so a deploy is visible immediately instead of after max-age.
const ENGINE_VERSION = "8";

async function load(variant) {
  const base = `/mint-engine${variant}`;
  const mod = await import(`${base}/cachet_mint_engine.js?v=${ENGINE_VERSION}`);
  await mod.default({
    module_or_path: `${base}/cachet_mint_engine_bg.wasm?v=${ENGINE_VERSION}`,
  });
  return mod;
}

function engine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      if (self.crossOriginIsolated) {
        try {
          const mod = await load("-mt");
          // Cap the pool: proving saturates well before 8 threads and
          // each wasm thread costs shared memory.
          const threads = Math.min(navigator.hardwareConcurrency || 4, 8);
          await mod.initThreadPool(threads);
          engineThreads = threads;
          return mod;
        } catch (error) {
          console.warn("mint-engine: threaded build unavailable, using single-core", error);
        }
      }
      engineThreads = 1;
      return load("");
    })();
  }
  return enginePromise;
}

self.onmessage = async (event) => {
  const { id, cmd, args } = event.data;
  try {
    const mod = await engine();
    let result;
    if (cmd === "generate_seed") {
      result = { seed: mod.generate_seed_phrase() };
    } else if (cmd === "engine_info") {
      result = { threads: engineThreads };
    } else if (cmd === "prepare_proving") {
      // Builds and caches the proving key (seconds); fired while the
      // user fills the form so the actual mint skips this cost.
      mod.prepare_proving();
      result = { ready: true };
    } else if (cmd === "issuer_info") {
      result = mod.issuer_info(args.seed, args.description);
    } else if (cmd === "wallet_reset") {
      result = mod.wallet_reset(args.seed);
    } else if (cmd === "wallet_scan") {
      // Feeds a page of raw blocks (public chain data) into the local
      // wallet: trial decryption and witnesses happen HERE, so the server
      // never learns which notes are ours.
      result = mod.wallet_scan(args.seed, args.blocks);
    } else if (cmd === "build_spend") {
      // Heavy: Halo2 proving, same cost profile as a mint.
      result = mod.build_spend_tx(
        args.seed,
        args.asset_id,
        BigInt(args.amount),
        args.recipient ?? undefined,
        args.target_height,
      );
    } else if (cmd === "build") {
      // Heavy: proving key + Halo2 proof. ~45s single-threaded,
      // a handful of seconds on the threaded build.
      result = mod.build_issuance_tx(
        args.seed,
        args.description,
        BigInt(args.amount),
        args.finalize,
        args.first_issuance,
        args.target_height,
      );
    } else {
      throw new Error(`unknown command: ${cmd}`);
    }
    self.postMessage({ id, ok: true, result });
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error?.message ?? error) });
  }
};
