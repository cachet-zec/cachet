# ADR 004: atomic ZSA swaps in one OrchardZSA bundle

Date: 2026-10-07. Status: accepted (testnet prototype).

## Context

Two people holding different ZSAs should be able to trade them without
trusting each other or a third party. On the pinned stack (QED-it orchard
`cf801a5`, transaction v6, one action group) there is no swap primitive:
ZIP 228's swap orders and action groups need transaction v7, which QEDIT
is still building (QED-it/librustzcash#355).

What v6 already gives: one OrchardZSA bundle may spend and create notes of
several assets, balanced per asset by the binding signature, under one
proof. If both parties' spends and outputs sit in the same bundle, the
trade is atomic by construction: the transaction lands whole or not at
all, and nobody ever holds the other side's units in between.

## Decision

`crates/swap` implements a three-message protocol between two browsers:

1. **Offer** (maker). The maker first moves exactly the units it gives to
   a one-off _swap slot_ (ZIP-32 account `1000 + slot`, four slots), then
   publishes the slot's full viewing key, the note, its Merkle path and
   anchor, what it wants, and a fresh diversified address of its main
   account to be paid at.
2. **Take** (taker). The taker builds the bundle against the offer's
   anchor (its wallet checkpoints every block, so it can witness its own
   notes against a recent root), proves it, signs its own spends, and
   sends the transaction with a placeholder in the maker's signature plus
   the maker action's randomizer `alpha`.
3. **Countersignature** (maker). The maker parses the transaction,
   recomputes the sighash itself, checks that the action it is asked to
   sign spends its offered note with `rk = ak.randomize(alpha)`, that the
   bundle is built on the offer's anchor and burns nothing, that the
   transaction carries no other bundle, and that the outputs it can
   decrypt pay its address what it asked. Only then does it sign.

The sighash commits to every action and value balance and to no
signature or proof, so neither side can alter anything after the other
has signed. Each side's keys stay in its own browser's worker.

Signing someone else's spend needs `alpha`, which orchard's builder keeps
private. orchard is therefore vendored (`server/vendor/orchard`, see its
`README.cachet.md`) with an accessor patch: `SigningParts::{ak, alpha}`
and, on a partially signed bundle, `sighash`, `unsigned_parts` and
`with_placeholder_signatures` (so it can be serialized for the maker).
librustzcash's cached ZSA proving key is made public for the same build.

## What each side learns

- The taker sees the maker's swap slot through its viewing key: by
  design, the offered note and nothing else. The maker's main holdings
  stay private. The taker also sees the address it pays, a fresh
  diversified one that appears nowhere else.
- The maker sees the transaction it countersigns: the taker's spends are
  nullifiers and the taker's outputs are encrypted to the taker, so it
  learns what it is paid and nothing about the taker's holdings.

## Limits (prototype)

- Messages are passed by hand between the two pages; no order book yet.
- The offer's anchor must be within the taker's last 100 scanned blocks.
- Zero fee, as every Cachet transaction on the testnet.
- A maker cancels by withdrawing the slot (spending the note); a taker's
  swap built on it then fails, as a double spend.

## Alternatives rejected

- **PCZT**: QEDIT's `orchard::pczt` exposes `alpha`, but is ZEC-only in
  this rev ("No burn in PCZT V1"); librustzcash's PCZT has no asset field.
- **Handing the swap slot's spending key to the taker**: the taker could
  then spend the note without paying.
- **Waiting for ZIP 228 on v7**: no date. The data model (give/want
  amounts per asset) maps onto ZIP 228 swap orders when it lands.

Upstream: the accessor is a candidate PR to QED-it/orchard, which needs
`alpha` for a ZSA-aware PCZT anyway. When it is upstream, drop the vendor
and restore the git pin.
