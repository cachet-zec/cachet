# Contributing to Cachet

Thanks for looking into this. The project optimizes for one thing: staying
trustworthy — in code quality, in privacy claims, and in what it says the
protocol can do.

## Ground rules

- **Conventional commits** (`feat:`, `fix:`, `docs:`, `chore:`, …), present
  tense, scoped when useful (`feat(console): …`).
- **Warnings are errors.** `cargo clippy --workspace --all-targets -- -D warnings`
  and `pnpm lint` must pass; CI enforces both.
- **The API contract is generated.** After changing handlers or DTOs, run
  `pnpm openapi:export && pnpm openapi:generate`, then commit the
  regenerated `openapi.json` — that file is the reviewable contract.
  `packages/api-client/src/generated/` is gitignored and rebuilt by CI:
  never commit it, and never edit it by hand.
- **Privacy is opposable.** Any change that adds telemetry, third-party
  requests, IP logging, or wildcard CORS will be rejected — the rules are in
  [docs/PRIVACY.md](docs/PRIVACY.md) and they bind this repository.

## The dependency rule (important)

`server/Cargo.lock` pins crates that have been **yanked** from crates.io
(`core2 0.3.3`, `halo2_gadgets 0.4.0`) but are required by the QED-it
protocol forks. The build only works because the lockfile carries them.

- Never run a blanket `cargo update`.
- Update a single crate with `cargo update -p <crate>` and make sure the
  lockfile still contains the yanked entries afterwards.
- The QED-it forks themselves are pinned by git rev in
  `server/Cargo.toml [patch.crates-io]`; bumping a pin is its own PR with the
  regtest integration suite run against it
  (`cargo test -p cachet-chain --test regtest -- --ignored --test-threads=1`).

## Local setup

See the [README quickstart](README.md#quickstart) and
[docs/SETUP.md](docs/SETUP.md) (including the regtest Docker image build and
the Windows-specific notes: LF checkouts, `.cargo/config.toml` at the repo
root, Sapling parameters).

## Before you push

```bash
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings
cargo test
pnpm typecheck && pnpm lint && pnpm build
pnpm format
```

If your change touches the issuance/transfer/burn paths, also run the e2e
suite (`pnpm --filter @cachet/console e2e` — needs the regtest compose stack
up) or say in the PR that you couldn't, and CI will.

## Reporting bugs & security issues

Plain bugs: open a GitHub issue with steps to reproduce. Anything with
security impact: see [SECURITY.md](SECURITY.md) — do not open a public issue.
