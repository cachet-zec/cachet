# Upstream contribution — QED-it/zebra NU7 protocol-version crash

_Material for an issue + PR on https://github.com/QED-it/zebra (public fork
of ZcashFoundation/zebra, Apache-2.0/MIT, issues enabled). Verified
2026-08-29: the pinned commit `2b036fd` is the `zsa-integration-demo` head
and no existing issue or PR covers this._

## How to submit (PR from your fork)

```bash
# once: fork QED-it/zebra on GitHub, then
git clone https://github.com/<you>/zebra.git && cd zebra
git checkout -b fix/nu7-regtest-protocol-version origin/zsa-integration-demo
# apply the one-line change in zebra-network/src/constants.rs (below)
git commit -am "Bump CURRENT_NETWORK_PROTOCOL_VERSION to 170_150 for NU7"
git push -u origin fix/nu7-regtest-protocol-version
# open the PR against QED-it/zebra, base branch zsa-integration-demo
```

The change (drop the old value, promote the file's own commented NU7 line):

```rust
pub const CURRENT_NETWORK_PROTOCOL_VERSION: Version = Version(170_150); // NU7 Testnet.
// pub const CURRENT_NETWORK_PROTOCOL_VERSION: Version = Version(170_160); // NU7 Mainnet.
```

## Suggested PR title

`Fix zebrad abort after mining the NU7 activation block on Regtest (protocol version 170_140 < 170_150)`

## Suggested PR description

On `zsa-integration-demo` (tested at `2b036fd`), a single-node regtest
started from `testnet-single-node-deploy/dockerfile` aborts about ten
seconds after the block at the NU7 activation height (height 1 with the
shipped config) is accepted:

```
thread 'tokio-rt-worker' panicked at zebra-network/src/protocol/external/types.rs:41:9:
Zebra does not implement the minimum specified Nu7 protocol version for Regtest { activation_heights: {Height(0): Genesis, Height(1): Nu7}, … }
```

Cause: `zebra-network/src/constants.rs` ships
`CURRENT_NETWORK_PROTOCOL_VERSION = Version(170_140)`, while
`min_specified_for_upgrade` requires `170_150` for `(Testnet(regtest), Nu7)`
(`types.rs` line 119). Once the tip reaches activation, the peer set's
chain-tip watcher calls `Version::min_remote_for_height` and the assert
aborts zebrad. With the shipped `[state] ephemeral = true`, the restart
wipes the chain back to genesis, so a client that saw its block accepted
then fails in confusing ways (template height regresses; a reissuance forks
a fresh chain and fails contextual validation, e.g.
`MissingReferenceNoteOnFirstIssuance`).

Repro: build and run the regtest image per the tx_tool README, mine one
block via `getblocktemplate`/`submitblock`, watch the logs for ~10s. The
bundled test scenarios can complete inside that window, which may be why CI
does not catch it.

This PR bumps the constant to the NU7 Testnet value already present as a
comment in the file. Verified locally: with this change the node survives
sustained mining/submission sessions on regtest (issuance, reissuance,
finalization flows).

## Verification evidence (local)

- Deterministic before/after: identical client integration suite fails
  repeatedly on the unpatched image (template height regression +
  `MissingReferenceNoteOnFirstIssuance`), passes 4/4 on the patched image.
- Panic reproduced 3 times in `docker logs` with the exact message above.
