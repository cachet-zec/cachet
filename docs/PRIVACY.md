# Privacy Principles

These rules are **enforceable, not aspirational**: each one states how to
verify it against the codebase. A change that breaks a rule must update this
document in the same PR and say why — silence is a bug.

## P1 — No telemetry, no analytics

Neither the server nor the console contacts any third-party service at
runtime. No analytics SDK, no error-reporting SaaS, no usage pings.

_Verify:_ `grep -ri "sentry\|posthog\|analytics\|telemetry" console/src server/crates`
returns nothing but this rule's own references; `NEXT_TELEMETRY_DISABLED=1`
is set in CI and documented in SETUP.

## P2 — No client addresses in logs

The server never logs client IPs or request bodies. Log lines carry route,
status, latency, and error kinds only.

_Verify:_ peer addresses are used in exactly two places in
`server/crates/api`, both in memory only, never logged, never persisted:
the rate limiter's key extractor (peer address by default; client-IP
headers such as `X-Forwarded-For` / `X-Real-IP` only behind a declared
proxy — `CACHET_TRUST_PROXY`), pruned every minute; and the write-path throttles in `client_key.rs`
(upload budget, relays in flight), which do not even hold the address —
their key is `BLAKE2b(salt ‖ address)` with a salt drawn at process start
and never written down, so the maps cannot be inverted and the salt dies
with the process. Tracing calls log typed fields, never raw requests.

## P3 — No server-side custody of spending keys

Issuer spending keys never reach the server in any milestone. The current
milestone signs via the chain backend against regtest/testnet wallets; the
target design keeps signing client-side (hardware wallet support is a
release-blocker for any mainnet story).

_Verify:_ no key material type appears in `cachet-api` DTOs; `cachet-domain`
has no key types at all.

## P4 — Derived data, and the three tables that are not

Postgres holds derived state — caches, indexes, journals — plus three
tables that the chain genuinely cannot rebuild, and we say so rather
than round the claim off:

- `asset_descriptions`, the resolution journal (re-derivable from the
  issuer's own records, not from the chain);
- `metadata_bundles`, the content-addressed bundles. The chain commits
  to a bundle's **hash**, never its bytes, so a community minter's
  description and image exist only here;
- `moderation_hidden`, what this operator chose to hide. It is a
  judgment, not a fact about the chain — which is why a mirror that
  disagrees with it can simply not have it.

Dropping the database loses no chain state, no funds and no integrity:
every served bundle is verified against its on-chain hash client-side,
so the store can be replaced but never forged. What it does lose is the
_availability_ of community uploads, which is why the public deployment
backs all three up daily (`infra/prod/server-setup.sh`).

_Verify:_ every table added must document its reconstruction path — or
its explicit non-derivability — in the migration header.

## P5 — No third-party asset fetches in the console

The console bundles all fonts and assets; a viewer's browser talks to the
Cachet server and nowhere else.

_Verify:_ `console/next.config.ts` sets no remote patterns; no `<link>` to
external origins in the layout.

## P6 — Testnet framing everywhere

Every user-facing surface (console header, README, API description) states
the testnet scope, so no one is misled into treating Cachet as
mainnet-ready.

_Verify:_ the console layout renders a `testnet` badge; the OpenAPI `info`
mentions the scope.

## P7 — Reproducible privacy claims

Dependency bumps that could affect P1–P6 (new HTTP clients, new SDKs) are
called out in PR descriptions. The QEDIT fork pins (ADR-001) make the chain
stack auditable at exact revisions.

_Verify:_ `server/crates/chain/Cargo.toml` pins git revs; `pnpm licenses
list` / `cargo deny check` run clean.

## P8 — Residual correlations, stated plainly

Rules P1–P7 remove what we can remove. What remains is stated here so
nobody has to discover it:

- **Relay ↔ IP, transiently.** Submitting a browser-built transaction
  necessarily shows the operator which IP relayed which txid, for the
  duration of the request. This reveals nothing about holdings, past or
  future activity (scanning is local, raw blocks are identical for every
  caller) — but the submission moment itself is visible to the operator,
  as it is to any relay on any chain. Users who want to remove even that
  can reach the instance over Tor, or run their own (see P3's endgame:
  this instance is a convenience, not a chokepoint).
- **Operator ↔ Discord (opt-in).** When the operator configures
  `CACHET_DISCORD_WEBHOOK`, a mint relayed through this instance posts
  the minted asset ids and txid — public chain data — to a Discord
  webhook. Discord thereby learns the _moment_ mints are relayed here;
  it never learns a visitor address (none is read on that path). Unset
  by default.
- **A dishonest operator can front-run a nullifier.** Local scanning
  trusts only notes decryptable under your own key, so a lying server
  cannot make you pay an attacker (forged blocks yield an invalid anchor
  and a chain-rejected transaction). The one residual: if you spend a real
  note against a server feeding you forged tip blocks, the doomed
  transaction you hand to `/relay` still carries that note's real
  nullifier — the operator sees it before the chain does and could later
  link your eventual genuine spend. Same relay ↔ IP trust boundary as
  above; the same answer applies (Tor, or run your own instance).

_Verify:_ the relay handler logs txids only (P2); the console makes no
third-party requests (P5).
