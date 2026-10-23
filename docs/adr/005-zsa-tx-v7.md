# ADR 005: moving from the v6-ZSA format to QEDIT's TX_ZSA

Date: 2026-10-20, revised 2026-10-23 (naming, zcash/zips#1407). Status:
draft (spike, not a release). Revisit when QEDIT merges its TX_ZSA work and
publishes a Zebra that accepts it.

## Naming

Three different formats share two version numbers, so this ADR names them:

- **v6-ZSA**: what Cachet 0.6.0 builds, the format of the withdrawn ZIP 230
  (version 6, group id `0x77777777`, NU7 branch `0x77190ad8`).
- **TX_ZSA**: QEDIT's ZSA transaction built on NU6.3 (Ironwood). Their PRs
  QED-it/librustzcash#355 and #377 still call it "transaction version 7",
  and the code still says so (`TxVersion::V7`, `V7_TX_VERSION = 7`,
  `read_v7_bundle`). Since 2026-10-22 QEDIT calls it `TX_ZSA` /
  `Transaction_ZSA` "in order not to be confused with tx version numbers"
  (@PaulLaux on zcash/zips#1407). Code identifiers below keep their `v7`
  names; the prose says TX_ZSA.
- **ZIP 248 V7**: upstream's Extensible Transaction Format, a different
  format with the same version number: bundles encoded as TLV entries, and
  a version group id not assigned yet.

## Context

Cachet 0.6.0 builds v6-ZSA on QEDIT's `zsa1` stack: orchard `cf801a5d`
(vendored with the swap accessor patch, ADR-004), librustzcash `c5c232db`
(vendored with the proving-key cache, ADR-003), sapling-crypto `e785faaa`,
QED-it/halo2 `ef3d0ba2`.

Mainnet now has its own v6: NU6.3 (Ironwood, ZIP 229, group id
`0xD884B698`). The two v6 formats cannot coexist, so QEDIT keeps upstream's
v6 and moves ZSA to TX_ZSA:

- QED-it/librustzcash#355 merges upstream at `b253bb6c` (the NU6.3
  release, orchard 0.15) and moves ZSA to TX_ZSA. Open, head `57ea5b34`.
- QED-it/librustzcash#377 is its alternative (or follow-up). It contains all
  of #355 plus a merge with upstream up to `zcash_primitives-0.30.1`
  (`97aefdc39a`), the version Zebra v6.4.2 needs, which is QEDIT's Zebra
  target. It stops before upstream's move to orchard 0.16, `ff`/`group` 0.14
  and the removal of `zip233Amount`. Open, head `562300d6` (unchanged as of
  2026-10-23).

The specs moved too. zcash/zips#1407 ("ZIP 226: Update for the Ironwood
pool and ZIP 248's transaction format", @daira, draft, opened 2026-10-21,
not merged) updates ZIPs 226, 227 and 228:

- OrchardZSA notes live in the Ironwood pool only; the Orchard pool cannot
  contain them. The ZSA note plaintext lead byte is still a placeholder.
- ZIP 230 and ZIP 246 are withdrawn. The target format becomes ZIP 248 V7,
  which provisionally registers an OrchardZSA bundle variant and a ZSA
  issuance bundle. Their encodings, the issuance bundle's, the Action
  Groups', the digests and sighash versions, and how value balances and
  burns map onto ZIP 248's value pool deltas are all listed as Open Issues.
  Action Groups would need a change to ZIP 248 itself.
- Wallets should use the OrchardZSA bundle variant for all their Ironwood
  actions, ZEC transfers included, so that native and custom assets look
  alike.
- ZIP 226 still says ZSA is "not currently scheduled for deployment in a
  specific Network Upgrade".

QEDIT ACKed #1407 (@PaulLaux, 2026-10-22) and will update ZIP 230, although
withdrawn, to describe TX_ZSA as built on Ironwood, so that their test
vectors, orchard and librustzcash share one description.

When QEDIT's testnet node moves to TX_ZSA, the v6-ZSA engine stops working:
a TX_ZSA node does not parse v6-ZSA transactions, and the current node does
not parse TX_ZSA ones. ZSA has no mainnet date, so the goal here is only to
size the migration before it is forced.

## Two migrations, not one

- **(a) v6-ZSA to TX_ZSA**, for QEDIT's testnet (rpc.test-zsa.org). This is
  what the spike measures and what the rest of this ADR sizes. It is
  concrete: QEDIT's code exists (#355/#377), and only the merge and a Zebra
  are missing.
- **(b) TX_ZSA to ZIP 248 V7**, later, which is the only path toward a
  possible mainnet. It cannot be planned today. The ZSA parts of ZIP 248 are
  not specified while #1407's Open Issues stand, no implementation exists,
  and no network upgrade is scheduled. When it comes, it touches everything
  in Cachet that serializes or hashes a transaction, mostly through
  librustzcash:
  - the builders;
  - the swap (parse, sighash recomputation, fixed header check, the
    `map_bundles` hand-over);
  - the regtest miner's block commitments;
  - the wallet's note decryption, since the lead byte will change again.

  ZIP 248 has no Action Groups. Cachet's swap uses a single bundle, so it
  does not depend on them, but ZIP 228 swap orders do. One more naming risk:
  TX_ZSA still uses version number 7 in code, which is also ZIP 248's.
  That is an inference, not something QEDIT has said, but expect the
  constant to change.

## Investigation

The branch `claude/awesome-hypatia-98ec20` repoints the stack to #377's head
and gets everything to compile and pass. Toolchain: `rust:1-bookworm`
(rustc 1.99.1) in Docker. The host has no Rust, which is the same path
`infra/build-mint-engine.sh` uses.

### Pin set (#377 head; #355 pins the same revs)

| Crate(s)                                                                                            | Was (0.6.0)                       | Now (spike)                                                                                                                   |
| --------------------------------------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `zcash_primitives` 0.30.1, `_protocol` 0.10.5, `_address` 0.13, `_proofs` 0.30, `_transparent` 0.10 | vendored `c5c232db` + patch       | git QED-it/librustzcash `562300d6` (#377), no vendor                                                                          |
| `orchard` 0.15.5                                                                                    | vendored `cf801a5d` + patch       | vendored `e40bdfad` (`zsa1`, includes QED-it/orchard#291) + same patch                                                        |
| `sapling-crypto`                                                                                    | QED-it `e785faaa`                 | QED-it `e5a27294` (head of QED-it/sapling-crypto#15, open)                                                                    |
| `zcash_note_encryption` 0.4.2                                                                       | zcash `9f7e93d4`                  | zcash `40b73b15`                                                                                                              |
| `halo2_proofs` 0.3.5, `halo2_gadgets` 0.5                                                           | QED-it/halo2 `ef3d0ba2`           | zcash/halo2 `828fab66` (QED-it/orchard#286 moved `zsa1` back to upstream halo2)                                               |
| `halo2_poseidon`                                                                                    | patched to zcash/halo2 `2308caf6` | crates.io 0.1.0, as #377 resolves it                                                                                          |
| `zcash_encoding`                                                                                    | vendored 0.4                      | crates.io 0.4.0. librustzcash 0.30 has not adopted the breaking 0.5 yet, and patching to the git 0.5.0 would leave two copies |
| `sinsemilla`, `zcash_spec`                                                                          | unchanged                         | unchanged                                                                                                                     |

MSRV rises to 1.88 (orchard 0.15.5 and librustzcash both require it).
`server/Cargo.lock` moves only these crates (+26/−16 lines). `cargo update
-p` cannot name entries whose source changed from a path to git, so cargo's
own re-resolution of the changed `[patch]` entries did the bump. That diff
is what the CONTRIBUTING rule protects, and nothing else moved.

**The librustzcash vendor is gone.** #377 caches the Orchard proving key
upstream: `zcash_primitives::transaction::builder::cached_orchard_proving_key(
OrchardCircuitVersion)`, public, one `OnceLock` per circuit version, used
by `Builder::build`. That is ADR-003's patch, so the vendor README's own
exit condition ("when upstream takes it, delete this directory and restore
the git pins") is met on the TX_ZSA line. The orchard vendor stays: `alpha`
is still private and PCZT is still ZEC-only ("PCZT V1 is zatoshi-only").

### What broke, and the fix

All of these are fixed on the branch.

| File                                                                                 | Cause                                                                                                                                                                                                                 | Fix                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vendor/orchard/src/builder.rs` (CACHET PATCH)                                       | `Bundle` lost its `OrchardPrimitives` type parameter (QED-it/orchard#261); the version is now a runtime `BundleVersion`                                                                                               | patch re-applied (offset 687 lines), `impl<V> Bundle<_, V>`, `from_parts_unchecked(.., self.bundle_version())`                                                                                                                                                                   |
| `crates/chain/src/lib.rs`, `crates/mint-engine/src/lib.rs`, `crates/swap/src/lib.rs` | `prepare_orchard_zsa_proving_key` / `orchard_zsa_proving_key` were the vendor patch                                                                                                                                   | `cached_orchard_proving_key(OrchardCircuitVersion::ZSA)`                                                                                                                                                                                                                         |
| `crates/notes/src/lib.rs`                                                            | `orchard::primitives::OrchardDomain` moved; the `OrchardBundle` enum is gone; ZSA sits in `ironwood_bundle()`                                                                                                         | trial-decrypt the Ironwood slot's ZSA bundle under `note_encryption::ZSADomain`; tree order: see "Note commitment tree"                                                                                                                                                          |
| `crates/swap/src/lib.rs`, `testing.rs`, `tests/swap.rs`                              | no `flavor::OrchardZSA`; `Builder::new(type, version, flags, anchor) -> Result`; no `BundleType::DEFAULT_ZSA`; `build::<V>()`; `Note::from_parts` takes a `NoteVersion`; `VerifyingKey::build(OrchardCircuitVersion)` | `BundleVersion::zsa()` and its default flags, `NoteVersion::ZSA`, ZSA circuit version                                                                                                                                                                                            |
| `crates/swap/src/lib.rs` `transaction_data`                                          | **no public constructor for a TX_ZSA `TransactionData` with the Ironwood slot filled**: `from_parts` leaves it empty and `from_parts_v6` forces version 6 (the builder uses a crate-private struct literal)           | workaround: `from_parts` then `map_bundles`, whose closure runs on the Orchard slot and then the Ironwood slot, so the bundle can be handed over between the two calls. Works (the swap test asserts the slots), but it depends on field order: ask upstream for `from_parts_v7` |
| `crates/swap/src/lib.rs` `read_take`                                                 | TX_ZSA has a separate ZEC-only Orchard slot                                                                                                                                                                           | the maker also refuses a take whose Orchard slot is not empty. The recomputed sighash would already have failed safe, but now it refuses up front                                                                                                                                |
| `crates/mint-engine/src/lib.rs`, `crates/chain/src/zsa/mod.rs`                       | `BuildConfig::Standard` gains `ironwood_anchor`, `orchard_padding`, `ironwood_padding`; `add_orchard_output` lost its asset parameter (the Orchard slot is ZEC only); `BuildResult::into_transaction` is gone         | ZSA spends and outputs go through `add_ironwood_spend/output`, anchor in `ironwood_anchor`; the rho padding output goes to the Ironwood slot (issuance rho comes from the first nullifier of the ZSA bundle); `.transaction().clone()`                                           |
| `crates/chain/src/zsa/{decode,scan}.rs`, relay in `mod.rs`                           | `OrchardBundle::{OrchardVanilla, OrchardZSA}` matches                                                                                                                                                                 | burns are read from `ironwood_bundle()`; action count sums both slots; relay accepts an issuance bundle or a ZSA-version Ironwood bundle                                                                                                                                         |
| doc strings, `api/src/dto.rs` + `packages/api-client/openapi.json`                   | "v6 transaction"                                                                                                                                                                                                      | "v7" (description only; the real migration should say TX_ZSA)                                                                                                                                                                                                                    |

Results on the branch:

- `cargo check --workspace --all-targets` and `cargo fmt --check`: clean.
- `cargo clippy --workspace --all-targets -- -D warnings`: clean. Raising
  `rust-version` to 1.88 makes let-chains available, so clippy's
  `collapsible_if` then flags nine nested `if let` blocks (domain, index,
  chain, api) that it leaves alone at 1.86. `main` is not affected. They
  are collapsed on the branch, with no behavior change.
- `cargo test --workspace`: every test passes (api 13 + 42 HTTP, chain 6 + 2,
  domain 26, index 4, mint-engine 2, swap 5, verify-engine 6). The regtest
  suite (7) and the Postgres listing test (1) are `#[ignore]`d as on
  `main`. The swap integration test builds, proves and countersigns a full
  two-party swap as TX_ZSA. The proof verifies under the ZSA key, every
  signature verifies against the txid, and the id read from the take
  equals the final txid.
- wasm: the three engines build unchanged (see "Wasm engines").

### Semantic points

**ADR-004's swap id holds.** The TX_ZSA txid is BLAKE2b over the header
digest (with `zip233Amount`), the transparent, Sapling, Orchard-slot and
Ironwood-slot digests, then the issuance digest (`to_hash_v7`). The ZSA
bundle's digest (`ZTxIdOrchardZsaH`) covers the actions (compact, memo and
non-compact parts), flags, `nAGExpiryHeight = 0`, burns and value balance.
Proof, spend signatures and binding signature are in the authorizing digest
only, so the maker's countersignature cannot change the id. With no
transparent input the TX_ZSA shielded sighash is the txid, as before: the
swap test checks every signature against `txid()`. Under ZIP 248 V7 the
digests are among #1407's Open Issues, so this has to be checked again for
migration (b).

One difference: **the anchor left the txid.** v6-ZSA hashed it into the
action group digest. TX_ZSA moves it to the authorizing digest, as upstream
NU6.3 does for Orchard v6 and Ironwood (deferred witnesses, ZIP 374). So
the sighash no longer commits to the anchor. The proof still binds it (a
public input), and so does the block's auth data root. In practice,
someone able to re-prove the same actions on another valid anchor (the
taker knows the slot's viewing key and both notes) could relay a
transaction with the same txid and the same effects (same nullifiers,
outputs, values and burns) but another anchor. The swap is still the same
trade and the registry's fill record (keyed by txid) stays right. The
maker's and the registry's "built on the offer's anchor" checks are checks
on the take, not on what lands. ADR-004 needs one sentence to say so; no
code change is needed.

**One action group: still fits.** TX_ZSA serializes `nActionGroups` and
refuses more than one ("Multiple action groups are not supported yet", a
FIXME until QED-it/orchard#268, the swap work, is folded into the flat
bundle API; open, base `zsa_swap`). `nAGExpiryHeight` must be 0. Cachet's
swap is one bundle and one action group holding both parties' actions, so
it fits unchanged. What TX_ZSA at #377 still lacks is ZIP 228 (swap
orders, one signature per action group), which is what would remove the
"maker must be online" limit without custody. That remains blocked on #268
and, for ZIP 248 V7, on a change to ZIP 248 itself (#1407).

**Issuance: same place, same signature.** The issuance bundle is still the
last field of the transaction (after the ZSA bundle, now in the Ironwood
slot), is still signed over the shielded sighash (`bundle.prepare(sighash)`),
and its digest is still the last input of the txid. Its notes' rho still
comes from the first nullifier of the ZSA bundle, so the zero-value padding
output stays, now in the Ironwood slot. QED-it/orchard#249 tightened
issuance: it refuses creating and finalizing a new asset with no note,
which Cachet's `seal_only` already refuses; it allows finalizing an asset
absent from the bundle; and it checks that the signing key matches `ik`.

**ZIP 227 asset ids do not move.** `AssetBase::custom` / `AssetId::new_v0`
are unchanged. The verify-engine tests, which derive the ids of real
testnet assets from `packages/registry-spec/vectors/zip227-identity.json`,
pass on the new orchard. Asset pages, URLs and registry metadata keep their
ids across migration (a).

**Note version: old notes do not survive.** TX_ZSA notes are
`NoteVersion::ZSA` (lead byte `0x04`, `ZSADomain`); the Orchard slot uses V2
(`0x02`) and Ironwood v6 uses V3 (`0x03`). #1407 keeps the ZSA lead byte as
a placeholder, so it may change again under ZIP 248 V7. QED-it/orchard#265
adds `rcm_zsa`, a new note-commitment randomness for ZSA notes that also
binds the asset. So a v6-era ZSA note does not have the same commitment
under the TX_ZSA stack. And v6-ZSA transactions no longer parse at all:
version 6 now means Ironwood (`0xD884B698`), and the old group id belongs
to TX_ZSA. **The TX_ZSA testnet will be a new chain**, unless QEDIT keeps
a legacy parser, which #377 does not. For Cachet that means rebuilding the
registry index from zero, every wallet rescanning, and testnet balances
and issuance history starting over. Seeds, keys and asset ids stay.

**`zip233Amount` is still in the TX_ZSA header** at #377: `has_zip233()`
is true for V7, the header digest commits to it, Cachet writes zero and the
swap's header check compares it. Upstream removed it after 0.30.1, and #377
deliberately stops before that. If QEDIT drops it, the Cachet change is
mechanical (the `zip-233` features in three manifests, the `Zatoshis::ZERO`
argument and the comparison in `crates/swap`), about an hour. But it
changes the header and every txid again.

**Note commitment tree (assumption, partly backed by #1407).** In NU6.3
Ironwood is a separate pool with its own note commitment tree. TX_ZSA puts
ZSA in the Ironwood slot, so the branch assumes ZSA and issuance notes
enter the Ironwood tree, in the order "Ironwood-slot actions, then issuance
notes" (v6-ZSA's rule, with Orchard read as Ironwood), and ignores the
ZEC-only Orchard slot (`crates/notes`). #1407 backs the pool part: ZSA
notes live in the Ironwood pool, never in the Orchard pool. The order of
issuance notes in the tree is still an implementation choice that only a
TX_ZSA Zebra can confirm. Four places depend on it:

- the wallet tree order (`crates/notes`);
- the tree state a wallet starts from (`orchard_tree_state`,
  `z_gettreestate`, `crates/chain/src/zsa/rpc.rs`);
- the "final Orchard root" per block that the swap board checks anchors
  against;
- the block commitments the regtest miner computes (`zsa/block.rs`), if
  NU6.3 changes the template's roots.

QEDIT's own FIXME ("decide if Ironwood ZSA should be a separate slot") means
the layout may still move.

**One bundle variant for all Ironwood actions (to watch).** #1407 asks
wallets to send every Ironwood action, ZEC included, through the OrchardZSA
bundle variant. Cachet already does: everything it builds is a ZSA-version
bundle, ZEC padding outputs included, and it sends no ZEC otherwise. The
open question is on the receiving side. `crates/notes` decrypts only
ZSA-version Ironwood bundles and skips Ironwood v3 (ZEC) bundles. That is
right for a wallet that holds no ZEC, but it has to be revisited if the
browser wallet ever holds ZEC, or if TX_ZSA lets both variants carry
OrchardZSA-protocol notes.

**Placeholders.** `V7_TX_VERSION = 7`, `V7_VERSION_GROUP_ID = 0x77777777`
and NU7 branch `0x77190ad8` are FIXMEs. QEDIT's updated ZIP 230 should fix
TX_ZSA's values, and version 7 is also ZIP 248's number (see "Two
migrations"). #377's two ZSA test vectors (`zsa_zip_0233`, `zsa_zip_0244`)
are ignored until QEDIT's `zcash-test-vectors` is regenerated for TX_ZSA.
Cachet hardcodes none of these values; a change only means rebuilding.

### Wasm engines

`infra/mint-engine-build-inner.sh` needs no change: it references no vendor
path, wasm-bindgen's version is read from `Cargo.lock` (unchanged), and
binaryen stays pinned. Run as is on a copy of the branch, it builds all
three engines (single-core, threaded nightly with `build-std`, verify)
with no error. After wasm-bindgen and wasm-opt:

| Engine           | v6-ZSA (committed) | TX_ZSA (spike) | zstd -19, v6-ZSA → TX_ZSA |
| ---------------- | ------------------ | -------------- | ------------------------- |
| `mint-engine`    | 4 518 737 B        | 4 390 923 B    | 1 189 606 → 1 194 981 B   |
| `mint-engine-mt` | 4 593 453 B        | 4 490 850 B    | 1 213 800 → 1 219 568 B   |
| `verify-engine`  | 249 650 B          | 249 857 B      | 74 173 → 73 723 B         |

The generated `.d.ts` differs only in two doc comments and the order of one
internal export: the JS API the console calls is unchanged. Proving time in
the browser was not measured (the circuit changed with QED-it/orchard#284,
so the 5.6 s figure of ADR-003 needs re-measuring). The committed engines in
`console/public` and `engine-manifest.json` are still the v6-ZSA builds: the
branch's server and its browser engines do not match until they are
rebuilt and the manifest refreshed (`python scripts/verify-site.py
--write-manifest`). That belongs to the real migration, not to this spike.

### Regtest end to end: not possible yet

No Zebra accepts TX_ZSA yet. QEDIT's `zsa1` Zebra is on v5.2.0
(QED-it/zebra#190 moves the public testnet to `v5.2.0-ZSA.1`), and the
NU6.3 rebase, targeting upstream Zebra v6.4.2 per #377, has no public branch
yet. So `cargo test -p cachet-chain --test regtest -- --ignored` and the
console e2e suite (issue, transfer, burn, swap) were not run, and the tree
assumption above is untested. We did not try to build such a Zebra.

## Decision

Draft. Do not merge the spike: `main` stays on v6-ZSA for as long as the
public testnet runs it. The branch is the reference diff for migration (a),
which we redo from merged revs once QEDIT has merged them. The approach
holds: the orchard vendor stays, the librustzcash vendor goes (ADR-003 is
superseded on the TX_ZSA line), and the code changes are those in the
table. Migration (b) gets its own ADR once ZIP 248's ZSA encodings are
specified.

Upstream PRs Cachet can send meanwhile (cheap, and they remove workarounds):

- QED-it/librustzcash: a public `TransactionData::from_parts_v7` (or let
  `from_parts` take the Ironwood bundle), so the swap can drop the
  `map_bundles` hand-over.
- QED-it/orchard: the signing-parts accessor (ADR-004), which would let the
  orchard vendor go too.

## Effort

For migration (a) only; (b) cannot be sized yet. The spike's mechanical
part is done (about a day). After QEDIT ships, the remaining Cachet work is
about **4 to 7 working days**, mostly testing and operations:

- repin to the merged revs, re-vendor orchard with the patch: 0.5 day;
- adapt to the TX_ZSA node: Ironwood tree state and final roots in the RPC
  layer, confirm the tree order, block template roots: 1 to 2 days,
  depending on what Zebra does;
- a TX_ZSA regtest image (Zebra builds take 20 to 60 minutes), compose, CI
  job, then the regtest and e2e suites: 1 to 2 days;
- rebuild the three wasm engines and the manifest; update the copy that
  says v6 to say TX_ZSA (console landing `page.tsx`, `swap-maker.tsx`
  comment, the API description changed to "v7" on this branch, README,
  SECURITY.md, `docs/SETUP.md`, `infra/regtest`, docker-compose image name,
  whitepaper): 0.5 day;
- testnet switch: reindex the registry against the new chain, update
  instance config, tell users their testnet balances reset: 0.5 day plus
  operations;
- if QEDIT removes `zip233Amount` or changes the TX_ZSA constants: 0.25 day
  plus a rebuild.

## Blocked on QEDIT and the ZIPs

- QED-it/librustzcash#355 / #377: which one lands on `zsa1`, and its final
  revs.
- QED-it/sapling-crypto#15 (still open): its head is pinned, not a branch.
- A Zebra that accepts TX_ZSA (QED-it/zebra NU6.3 rebase toward upstream
  v6.4.2) and the public testnet upgrade date. Until then, nothing can run
  end to end.
- QEDIT's update of ZIP 230 describing TX_ZSA on Ironwood (announced on
  zcash/zips#1407): its version, group id and branch id, and TX_ZSA test
  vectors.
- The `zip233Amount` decision, and whether ZSA keeps the Ironwood slot or
  gets its own.
- For migration (b): zcash/zips#1407 merged and its Open Issues resolved
  (bundle, issuance and note encodings, digests, value balances and burns,
  Action Groups in ZIP 248), then an implementation and a network upgrade.
- For asynchronous swaps (not needed now): QED-it/orchard#268 (action
  groups, ZIP 228 swap orders) and ZSA support in PCZT.
