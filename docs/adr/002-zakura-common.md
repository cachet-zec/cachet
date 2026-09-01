# ADR 002: Zakura Common cannot be adopted until the ZSA stack rebases

Date: 2026-08-30. Status: accepted (negative finding, revisit on upstream rebase).

## Context

Zakura Common (`zakura-core/common`, announced 29 August 2026) publishes
optimized forks of the Zcash cryptography stack: pasta curves, halo2,
sinsemilla and friends, reporting ~5x faster desktop proving, ~14x on
mobile, ~21x sinsemilla hashing, consensus-identical, MIT/Apache. If the
browser mint engine could link against it, proving would drop from ~43 s
(17.3 s proving key + 26.1 s proof, single-threaded wasm) toward seconds.

## Investigation

We cloned the workspace and compared its dependency generations against
our locked stack the day it was announced.

- Zakura Common targets `ff 0.14` / `group 0.14` / `rand 0.10` (the
  current trait generation). Its crates keep upstream lib names
  (`pasta_curves`, `halo2_proofs`) at version 1.0.1.
- The entire QEDIT ZSA stack we pin (orchard, librustzcash,
  sapling-crypto, sinsemilla, halo2 zsa1 branch) lives on `ff 0.13` /
  `group 0.13` / `pasta_curves 0.5`.
- Rust trait coherence makes the two generations unlinkable in one
  program: every public type (curve points, field elements) differs.
  A `[patch]` swap fails at type level, not merely at compile detail.
- The QEDIT `zsa1` halo2 branch contains only bugfixes over upstream
  halo2 (no circuit API changes), so a rebase is mechanical in
  principle, but it is upstream work in the protocol forks, not
  something an application can do from the outside.

## Decision

Do not fork or vendor. Keep the pinned QEDIT stack as-is. Track the
upstream rebase (which must happen on the road to mainnet anyway); when
the ZSA branches move to the `ff 0.14` generation, Zakura Common becomes
adoptable by changing version pins, and the browser mint engine inherits
the speedup for free.

Until then, the measured performance path is application-side:
wasm threads (atomics + rebuilt std + COOP/COEP) to re-enable the
multicore halo2 path, plus the shipped loading work (wasm-opt 6.03 MB →
4.04 MB, zstd transfer 1.56 MB, worker warm-up on page mount, cache
headers). Sizes drift with every engine rebuild; the whitepaper's
section 7 carries the current measurements.

## Note on wasm-opt

Debian bookworm's binaryen (v108) emits modules whose wasm-bindgen
externref table cannot grow (`WebAssembly.Table.grow(): failed to grow
table`), which breaks the engine at first call. The build script pins a
modern binaryen release (v123) instead; keep that pin when touching the
build.
