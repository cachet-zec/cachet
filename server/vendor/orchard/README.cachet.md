# Vendored orchard (QED-it fork) + signing-parts accessors

Snapshot of `QED-it/orchard` at rev `cf801a5d6701bc128e21678ba0034564af4a2aca`,
the rev QEDIT's Zebra `zsa1` pins and the public ZSA testnet verifies with.
`src`, `benches`, `tests`, the manifest and the licences are copied; `book/`
is left out.

## The patch

`src/builder.rs`, two blocks marked `CACHET PATCH`, nothing else modified:

- `SigningParts::ak()` and `SigningParts::alpha()`;
- on a partially signed bundle (`InProgress<Proof, PartiallyAuthorized>`):
  `sighash()`, `unsigned_parts()` (the parts of each action still awaiting
  a signature) and `with_placeholder_signatures()`, an authorized copy
  with a placeholder in each missing signature, so the bundle can be
  serialized for the counterparty, who recomputes the sighash from it.
  The sighash commits to no signature and no proof, so the placeholder
  changes nothing the counterparty checks; the copy never verifies.

A spend authorization signature is `ask.randomize(alpha).sign(sighash)`. The
builder picks `alpha` and keeps it private, so only the party that built a
bundle can sign its spends. A two-party swap puts both parties' spends in
ONE bundle (one proof, atomic by construction): the party that builds it
must hand `alpha` to the other for the other's spend. That is all this
patch allows; the counterparty checks `rk == ak.randomize(alpha)` before
signing.

Upstream: QED-it's `orchard::pczt` exposes `alpha` but only for ZEC notes
in this rev ("No burn in PCZT V1"). The same accessor is a candidate PR to
QED-it/orchard; when upstream has it, delete this directory and restore
the git pin in `server/Cargo.toml`.

`Cargo.toml`: orchard's own `[patch.crates-io]` and profiles are removed
(cargo ignores them outside the root) and an empty `[workspace]` keeps the
crate standalone; `server/Cargo.toml` excludes this directory.
