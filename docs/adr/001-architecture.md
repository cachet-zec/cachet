# ADR-001 — Single Rust backend, chain isolation, generated contracts

- **Status:** accepted
- **Date:** 2026-08-29

## Context

Cachet is an issuance console for ZSA built while the protocol itself is
alpha: the only implementation lives in QED-it's forks of `orchard` and
`librustzcash`, published as git branches with no semver releases, and the
protocol targets a post-NU7 network upgrade. The dominant engineering risk is
**upstream churn**, not product complexity.

## Decision

1. **One Rust service.** The API and the chain engine live in a single
   process (`cachet-server`). No Node middle-tier, no internal HTTP hop:
   protocol types flow from the chain crates to the HTTP layer in one
   language.

2. **Crates with one-way dependencies.**
   `api → domain ← chain` (and `api → chain` only for the `ChainBackend`
   trait). `cachet-domain` has zero I/O and compiles in milliseconds;
   `cachet-api` is testable against an in-memory backend.

3. **`cachet-chain` is the only crate allowed to depend on QED-it forks.**
   Every QEDIT dependency is pinned to an **exact git rev**, mirroring the
   `[patch.crates-io]` set of `zcash_tx_tool` (captured in ADR-000). Bumping
   a rev is always its own PR, titled `chore(chain): bump qedit stack to
<rev>`, so churn management is publicly auditable.

4. **Contracts are generated, never hand-written.** utoipa derives OpenAPI
   from the axum handlers and DTOs; `packages/api-client` is generated from
   that document. The committed `openapi.json` is the reviewable contract
   snapshot: a PR that changes it is by definition an API change.

## Consequences

- When a QEDIT release breaks the build, the blast radius is one crate; the
  API contract and the console are untouched by construction.
- The API can be developed and tested without a node,
  while integration tests against regtest live in `cachet-chain`.
- One deployment unit keeps performance honest: no serialization tax
  between "product" and "engine". The bottleneck is the node, by design.
- Cost: contributors need Rust even for API work. Accepted — the target
  contributor pool (Zcash ecosystem) is Rust-native.

## Fallback rule (from the project plan)

If a QEDIT update blocks progress for more than a few days, stay on the last
working rev and treat the bump as a separate issue. Never block a demo on
rebasing their branches.
