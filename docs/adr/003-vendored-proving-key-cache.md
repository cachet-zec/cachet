# ADR 003: vendor librustzcash to cache the Orchard proving key

Date: 2026-08-30. Status: accepted.

## Context

`zcash_primitives::transaction::builder::Builder::build()` constructs the
Orchard `ProvingKey` inline on every call (builder.rs, both the Vanilla
and ZSA arms). The key is deterministic and expensive: measured 17.3 s in
single-threaded wasm, 7.9 s on 8 wasm threads, ~2 s natively. It was the
dominant fixed cost of every browser mint after threads shipped
(13.2 s total, of which ~8 s was the key).

## Decision

Vendor the eight librustzcash crates we consume (QED-it rev `0ea73754`,
exactly the rev previously pinned by git) into `server/vendor/librustzcash`
with ONE functional patch: memoize the proving keys in process-wide
`OnceLock`s and expose `prepare_orchard_zsa_proving_key()` so callers can
warm the cache off the critical path. See `vendor/librustzcash/README.md`
for the update procedure; `[patch.crates-io]` now points these six crates
at the vendor paths (equihash/f4jumble ride along as intra-workspace
deps). The vendor is `exclude`d from the server workspace so its own
workspace-inherited dependencies resolve.

Alternatives rejected:

- **GitHub fork**: cleaner cargo-wise, but publishing a fork now would
  front-run the project's planned public debut; revisit when the public
  repository exists. The patch is a candidate for an upstream PR either
  way.
- **Bypassing the builder** (proving via orchard directly): the PCZT path
  does not carry issuance bundles at this rev, so it would mean
  reimplementing v6 transaction assembly.

## Measured effect (browser, 8 wasm threads, consumer CPU)

- Cold mint (key + proof + signature): 13.2 s (unchanged).
- Key warm-up alone, fired when the user confirms the seed: 7.9 s.
- Mint with the key cached: **5.6 s** — 7.7x over the original 43.4 s
  single-core pipeline.
- Native servers warm the key at boot (skipped on read-only instances,
  which never prove).

## Consequences

- The proving key stays resident (~hundreds of MB). In wasm this is free
  (linear memory never shrinks); on signing servers it is an accepted
  cost, and read-only deployments never build it.
- Bumping the QEDIT stack now involves re-vendoring + re-applying the
  patch (procedure in the vendor README). The pin discipline of ADR-001
  is unchanged: same rev, one documented diff.
