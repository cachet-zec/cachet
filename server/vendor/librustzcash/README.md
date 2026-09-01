# Vendored librustzcash (QED-it fork) + proving-key cache patch

This directory is a snapshot of the crates Cachet consumes from
`QED-it/librustzcash` at rev `0ea737548f7aea6124056df54d55f6c5a35ef914`
(the exact rev previously pinned by git in `server/Cargo.toml`), with ONE
functional patch applied.

## The patch

`zcash_primitives/src/transaction/builder.rs` (marked `CACHET PATCH`):

- upstream rebuilds the Orchard `ProvingKey` inside every
  `Builder::build()` call. The key is deterministic and costs tens of
  seconds in single-threaded wasm (and seconds natively), so the patch
  memoizes it in a process-wide `OnceLock`, once per flavor.
- `prepare_orchard_zsa_proving_key()` is added so callers can warm the
  cache off the critical path (the mint studio does it while the user
  fills the form; the server could do it at boot).

Nothing else is modified. The workspace root `Cargo.toml` is trimmed to
the vendored members and its (cargo-ignored) `[patch]` section removed;
`server/Cargo.toml`'s own `[patch.crates-io]` remains the single
authority for orchard/sapling/halo2 pins.

## Why vendor instead of forking on GitHub

The diff is 30 lines and the snapshot keeps the repository
self-contained and reproducible offline. The patch is a candidate for an
upstream PR to QED-it; when upstream takes it (or rebases), delete this
directory and restore the git pins.

## Updating

1. Restore the git pins in `server/Cargo.toml`, bump the rev, build.
2. Re-copy the eight crates + root `Cargo.toml` here from the new
   checkout, re-trim members, re-apply the `CACHET PATCH` hunks.
3. Point the `[patch.crates-io]` entries back at the vendor paths.
