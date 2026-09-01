# ADR-000 — zcash_tx_tool observations (spec for `cachet-chain`)

- **Status:** accepted (milestone C shipped; kept as the `cachet-chain` reference)
- **Date:** 2026-08-29
- **Source studied:** `QED-it/zcash_tx_tool` @ `655298f` (v0.5.0, June 2026)

## What the tx_tool is

QEDIT's alpha testing tool: builds and submits V5/V6 transactions (issue,
transfer, burn of OrchardZSA assets) against a Zebra node. Explicitly "not a
wallet, not for production". It is both a reference implementation of the
flows Cachet needs and the de-facto integration test of the QEDIT stack.

## The QEDIT dependency stack (pin set)

`zcash_tx_tool` consumes the protocol through `[patch.crates-io]` git pins.
This is the exact set `cachet-chain` mirrors (revs as of `655298f`):

| Crate(s)                                                                                                     | Fork                  | Rev                                        |
| ------------------------------------------------------------------------------------------------------------ | --------------------- | ------------------------------------------ |
| `orchard` (feature `zsa-issuance`)                                                                           | QED-it/orchard        | `77d3274cb1f4620e9a1b86477c490fa123dff6bd` |
| `zcash_primitives`, `zcash_protocol`, `zcash_address`, `zcash_proofs`, `zcash_encoding`, `zcash_transparent` | QED-it/librustzcash   | `0ea737548f7aea6124056df54d55f6c5a35ef914` |
| `sapling-crypto`                                                                                             | QED-it/sapling-crypto | `59535fb5d34b5c5cf1b20ef18269f5c65228378c` |
| `zcash_spec`                                                                                                 | QED-it/zcash_spec     | `d5e84264d2ad0646b587a837f4e2424ca64d3a05` |
| `zcash_note_encryption`                                                                                      | zcash (upstream)      | `9f7e93d42cef839d02b9d75918117941d453f8cb` |
| `halo2_proofs`, `halo2_poseidon`                                                                             | zcash/halo2           | `2308caf68c48c02468b66cfc452dad54e355e32f` |
| `sinsemilla`                                                                                                 | zcash/sinsemilla      | `aabb707e862bc3d7b803c77d14e5a771bcee3e8c` |

Toolchain: Rust 1.86 (their `rust-toolchain.toml`); edition 2024.
Key feature flags: `zsa-issuance` (orchard, zcash_primitives), `zip-233`,
`transparent-inputs`, `non-standard-fees`.

**Critical, easy-to-miss requirement:** the fork gates every NU7/ZSA API
(`BranchId::Nu7`, `Builder::init_issuance_bundle`, the `OrchardZSA` bundle
variant, `Transaction::issue_bundle`) behind the compiler cfg
`zcash_unstable="nu7"`, set via rustflags in `.cargo/config.toml` — feature
flags alone are NOT enough. Without it the fork compiles silently with the
stable API surface and downstream code fails with confusing "method not
found" errors. Mirrored in the repo-root `.cargo/config.toml` — it must live at
the root, not in `server/`: cargo discovers config by walking up from the
**current working directory**, so `cargo --manifest-path server/...` run
from the root would silently miss a `server/.cargo/config.toml`.

Version note: at rev `0ea7375` the fork's `zcash_primitives` reports
`0.26.4` (our `^0.26.1` requirement resolves to it through the patch).

## Internal layout (what to import vs. reimplement)

- `src/components/` — transaction building, signing, RPC client
  (`reqwest`-based JSON-RPC to Zebra on port 18232), wallet/note management
  backed by SQLite via Diesel. The RPC surface it uses: `getbestblockhash`,
  `getblockhash`, block submission (regtest mining), raw tx submission.
- `src/commands/` — the scenarios (`test-issue-one`, `test-orchard-zsa`,
  `test-three-party`, persistence tests). These are the executable
  documentation of the issue → transfer → burn flows.
- `src/lib.rs` exists: the tool is importable as a library, but its
  application framing (Abscissa app, Diesel/SQLite state) makes it a poor
  library dependency.

**Decision (initial):** `cachet-chain` does **not** depend on
`zcash_tx_tool` itself. It imports the protocol stack (table above) directly
and implements its own thin issuance/query layer, using the tx_tool
scenarios as the reference for correct builder usage. Rationale: the
tx_tool's Diesel/SQLite wallet state and Abscissa lifecycle would leak into
our process; the protocol crates are the stable-ish part. Revisit if the
builder APIs prove too sharp to hold directly.

## Environment findings (Windows host)

- The QEDIT Zebra regtest image builds from `QED-it/zebra` branch
  `zsa-integration-demo` (CI-pinned commit `2b036fd6`); exposes JSON-RPC on
  `18232`. Built and running locally via Docker Desktop.
- tx_tool scenarios run in Docker (`zcash-tx-tool:local`, build steps now
  in `docs/SETUP.md` step 3), pointed at the host node with
  `ZCASH_NODE_ADDRESS=host.docker.internal`. Native Windows build is
  untested (Diesel/SQLite native deps); Docker is the supported path here.
- Scenario runs assume a **fresh chain**: restart the Zebra container
  between runs.
- The proving params (~700 MB: Sapling ~50 MB plus the Sprout Groth16
  blob) are fetched at image build time via `zcutil/fetch-params.sh`.
  A Cachet dev box only needs the two Sapling files (docs/SETUP.md).
- Gotcha: clone with LF endings — the params script breaks under CRLF
  checkout (`core.autocrlf=false` before checkout, or renormalize).
- Gotcha: `core2` (a transitive dependency of the QEDIT `orchard`) is
  **yanked on crates.io** and its GitHub repo was emptied by the author.
  Fresh resolution fails; it only builds because `Cargo.lock` pins
  `core2 0.3.3` (yanked versions in a committed lockfile are honored).
  Consequence: never run a blanket `cargo update` — bump dependencies
  selectively (`cargo update -p <crate>`), and keep `Cargo.lock` committed.

## Bug found in the QEDIT Zebra fork (regtest, commit `2b036fd`)

Mining the block at the NU7 activation height makes zebrad **abort ~10
seconds later**, and since the shipped regtest config is `ephemeral = true`,
the restart wipes the whole chain back to genesis. Symptom on the client
side: blocks appear accepted, then the template height regresses to 1 and
subsequent submissions fail with confusing errors
(`MissingReferenceNoteOnFirstIssuance` — the reissuance forks a fresh chain
where the asset never existed).

Root cause: `zebra-network/src/constants.rs` ships
`CURRENT_NETWORK_PROTOCOL_VERSION = 170_140` while
`Version::min_remote_for_height` requires the NU7 minimum (`170_150`, the
file's own commented-out next value) once the tip reaches activation —
the assert in `zebra-network/src/protocol/external/types.rs:41` then panics
in the peer-set's chain-tip watcher. Panic message: _"Zebra does not
implement the minimum specified Nu7 protocol version for Regtest"_.

Local fix: one-line bump to `170_150` in our image build. Upstream
issue/PR material: `docs/upstream/zebra-nu7-panic-issue.md`.

## Milestone-C questions, answered

1. **Builder entry points without the tx_tool wallet** — resolved:
   `Builder::init_issuance_bundle` + a zero-value zatoshi padding output,
   proved via `LocalTxProver`; keys derived directly with
   `IssueAuthKey::from_zip32_seed` / `SpendingKey::from_zip32_seed`
   (`cachet-chain/src/zsa/keys.rs`). No Diesel/Abscissa needed.
2. **Mining cadence** — the client mines: `getblocktemplate` →
   assemble (ZIP-244 commitments) → `submitblock`. Acceptance must be
   confirmed by the next template's height advancing;
   `getblockchaininfo.blocks` lags and must not be used for tips.
3. **Asset state reads** — no node RPC reports asset supply; state is
   derived by scanning blocks and folding issuance actions and ZSA burns
   (`cachet-chain/src/zsa/scan.rs`). Full scan per query for now; Postgres
   incremental index later (PRIVACY.md P4).
