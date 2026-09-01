# Changelog

All notable changes to Cachet are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/) (0.x: anything may change).

## [Unreleased]

## [0.3.0] - 2026-09-01

### Added

- **The asset id itself is verified, in the browser.** An asset page
  re-hashed the metadata bundle against the `sha256` inside the on-chain
  description and called that "trust the math, not the registry". Nothing
  checked the description, so a registry serving a fabricated description
  with a matching fabricated bundle passed with a green badge. ZIP 227
  makes identity derived rather than assigned, so the page now recomputes
  the asset id from the issuance validating key and the description it was
  served, and compares it with the id it asked for. A registry can serve
  any description; it cannot serve one that derives the right id.
  The check covers every asset with a description, so ZMD-1 and free-text
  names are checkable too, not only sealed ones.
- `cachet-verify-engine`: a second, much smaller wasm module (247 KB
  against the mint engine's 4 MB) carrying the derivation and nothing
  else - no Halo2 circuit, no keys. Loaded once per session, only when
  there is a description to check. Its derivation is tested against a real
  asset confirmed at testnet height 520.

- **A continuity page** (`/continuity`) answering the question infrastructure
  gets asked and rarely answers: what happens if this instance disappears.
  States what would be lost, what would not, and how to take over — with
  the self-hosting and mirroring commands, and the honest remainder that a
  successor inherits neither the domain nor the signing key.
- `GET /api/v1/assets?resolved=true` narrows a listing to assets whose
  description is known. The landing showcase uses it: most of this testnet
  is script-minted under a shared demo key with no description, so an
  unfiltered showcase was five rows of hex.
- The files a public site is expected to serve: `robots.txt` (with the
  sitemap pointer), `sitemap.xml` (entry points only — asset pages change
  with every block), and an Apple touch icon, which Safari probed on every
  visit and turned into a console error. The site origin behind them is a
  build argument (`CACHET_SITE_URL`) like the API origin, so a fork's
  robots.txt stops pointing crawlers at this deployment.

### Changed

- The registry list orders assets whose name is attested first (sealed,
  then ZMD-1, then unverified label, then unresolved). Reordering, not
  filtering: every asset stays listed, the count is unchanged, and one
  click returns to strict chain order.
- The verification badge states what was actually established - full
  verification, description only, or bundle only - instead of one fixed
  sentence. An asset id mismatch outranks a bundle mismatch, because it
  makes everything under it moot.
- One word no longer means two things. "Sealed" named committed metadata
  on the landing and finalized supply everywhere else, which is exactly
  how a reader concludes an unsealed asset has editable metadata (it does
  not — the description hash derives the asset id). The landing step is
  now "Bind"; both supply states are stated instead of one being the
  absence of a stamp ("sealed" / "open supply", the latter in the
  attention colour, since it carries dilution risk for the holder); and
  reissuing announces itself before proving and on the receipt instead of
  silently adding units to an existing asset.
- Names in the landing showcase carry their provenance visibly ("zmd-1",
  "unverified") — the anti-phishing display rule applied where only
  typeface used to carry it.
- The navbar and footer GitHub links land on the repository rather than
  the organization page.
- Working paper v1.1: every engine measurement re-taken after three
  rebuilds had drifted them (4.0 MB module, 1.56 MB zstd on the wire,
  74 percent; load restated as 24 ms warm / ~0.5 s cold); the provenance
  point made with a chain-wide aggregate instead of naming one project's
  batch; issuer moderation verbs added to the CLI listing; P1–P8; and no
  heading is ever the last thing on a page.
- Documentation reconciled with the code as it ships: the three
  non-chain-derivable tables named consistently everywhere, the GC
  keep-set described as the resolved description journal (what the code
  does) rather than "on-chain assets" (what it does not), and DEPLOY's
  one-time setup no longer omits the third mandatory secret.
- CI actions moved off the Node 20 runtimes before their removal
  (checkout v7, setup-node v7, cache v6, upload-artifact v7,
  pnpm/action-setup v6), with automatic package-manager caching opted out
  in the one job that installs no package manager.

### Fixed

- The verification engine was served with `max-age=0`, so every asset
  page revalidated 247 KB per visit. Same cache rule as the mint engines
  now (an hour, plus a stale-while-revalidate day).
- The mint page printed eight copies of a wasm-bindgen deprecation
  warning — one per spawned thread — from the generated rayon worker
  bootstrap. Same call, object form, silence; re-applied by the engine
  build script so the next rebuild does not undo it.
- In attested order the ledger index counted down from the registry
  total, labelling the best-attested assets as the chain's newest. Rows
  are numbered by rank there; the countdown remains only in chain order,
  where it is true.

### Security

- The four postcss advisories are resolved rather than accepted: `next`
  pins postcss 8.4.31 exactly, so the patched line was unreachable until
  a pnpm override reached it. Verified against the build and the
  end-to-end suite.
- The critical halo2_gadgets soundness advisory (under-constrained base
  in variable-base scalar multiplication) is now described in SECURITY.md
  as what it is, with the exposure reasoning stated so a reader can
  disagree with it. The full migration to the fixed circuit is built and
  tested on `chore/bump-qedit-stack` — blocked on consensus, not on this
  repository: the fix changes the verifying key, and the deployed testnet
  still verifies with the old one. Reported upstream (QED-it/zebra#164).

## [0.2.0] - 2026-08-31

Community metadata: anyone can now seal a description and an image
into an asset id from their browser, bounded by a chain-anchored
storage sweep rather than by a restriction.

### Added

- **`scripts/mirror.py`**: mirrors any Cachet registry in one command,
  dependency-free. It re-derives the snapshot digest, verifies the
  operator's Ed25519 signature when `cryptography` is available, and
  re-hashes every referenced bundle against the commitment in its asset
  id — bytes that do not match are refused and the run exits non-zero.
  The "any mirror can serve it, any client can verify it" claim is now
  executable rather than described.

- **Community mints with sealed descriptions and images**: the browser
  mint studio now uploads full metadata bundles, and the public
  read-only instance accepts them. The storage abuse bound is
  chain-anchored: a garbage collector sweeps any bundle that no resolved
  asset description references after a 30-minute grace, a global
  upload budget and a 512 MB orphan-pool cap bound the transient window,
  and a daily host cron backs up the bundle store. Durable storage
  therefore always costs a real zero-knowledge proof and leaves a
  public, attributable trace.

- **Issuer-level moderation and a token-gated admin surface**: the
  operator denylist gains an `issuer` kind (hides every asset under an
  issuance key from listings; direct fetches answer 410), and — when
  `CACHET_ADMIN_TOKEN` is configured — a Bearer-authenticated
  moderation API plus a console `/admin` page (token held in memory
  only). Unset, the admin routes answer 404: the surface does not exist.

- **Mint notifications**: with `CACHET_DISCORD_WEBHOOK` set, a mint
  relayed through the instance posts its asset ids and txid (public
  chain data, never a client address) to a Discord webhook.
  Documented in PRIVACY.md P8; off by default.

- **ZMD-1 full-form manifest verification**: foreign assets whose
  descriptor commits to a manifest (`zmd1|…|<cid>|<blake2b-256>`) get it
  fetched server-side from the operator's IPFS gateway
  (`CACHET_IPFS_GATEWAY`, default ipfs.io), verified byte-for-byte
  against the on-chain hash, cached (content-addressed), and rendered on
  the asset page with a verified badge — name, description, attributes;
  images stay explicit external links. A mismatch is a 422, never a
  silent substitution. Visitors' browsers never contact a gateway.

- **Browser transfers and burns**: the mint studio now carries a full
  wallet. The page fetches raw blocks (`GET /api/v1/chain/transactions`,
  public data identical for every caller) and scans them locally in the
  WASM module — trial decryption, nullifier tracking and Merkle
  witnesses never leave the page, so the server cannot learn which notes
  are the user's. Spends (transfer to any unified address, or burn) are
  proven and signed in the page; the relay now accepts Orchard-bundle
  transactions alongside issuance. Note tracking lives in the new shared
  `cachet-notes` crate (server wallet + browser wallet, one
  implementation).
- **Signed registry snapshots** (`GET /api/v1/snapshot`): a
  deterministic export of every known asset, sealed under the operator's
  Ed25519 key (`cachet-server --generate-snapshot-key`,
  `CACHET_SNAPSHOT_KEY`). Mirrors serve the file as-is; anyone verifies
  it from the wire fields alone. Format and verification procedure in
  the registry spec.
- **Threaded, key-cached browser proving**: a second engine build proves
  over shared-memory wasm threads (COOP/COEP served site-wide), and a
  vendored 30-line patch to zcash_primitives caches the Orchard proving
  key per session, warmed while the user fills the form. Measured: a
  warm mint proves and signs in 5.6 s vs 43.4 s single-core (7.7x).
- **CI wasm job**: both engine variants build in CI from the same script
  as the local Docker wrapper, plus a Node smoke test of the module.
- End-to-end coverage of the browser lifecycle (mint → local scan →
  transfer → burn) against a real regtest chain.

- **Browser mint studio** (`/mint`): seeds are generated and held in the
  page's memory, ZIP-32 derivation, transaction building, the Halo2 proof
  and the BIP-340 signature all run in a Web Worker via the new
  `cachet-mint-engine` WASM module (the QEDIT stack compiled to
  wasm32, single-core halo2 fallback). The server gains
  `POST /api/v1/relay`, which accepts a fully signed issuance transaction
  and mines it: it can refuse, it can never alter, spend or impersonate.
  Open on read-only deployments by design — read-only means "this
  instance signs nothing", and relayed transactions are signed by the
  sender's own browser-held key. After relaying, the page teaches the
  registry its own description through the hash-verified resolution
  endpoint. Verified end to end on regtest: a browser-born issuer key
  minted a sealed supply-1 asset, distinct from the server's identity.

### Fixed

- Issuer-level moderation could never be stored: the moderation table's
  CHECK constraint predated the `issuer` kind, so every issuer hide — the
  admin panel's default — failed against Postgres. Migration 0007 widens
  it (the in-memory store used by tests has no constraint, which is why
  the suite never caught it).
- The bundle sweep treated an empty description journal as "everything is
  garbage" and deleted the whole store: in SQL, `NOT (x = ANY('{}'))` is
  true for every row. A journal that was merely missing — restored dump,
  migration in flight — would have cost bytes the chain cannot
  regenerate. The sweep is now skipped rather than trusted.
- A mint whose description-resolution call failed lost its sealed
  description and image within the hour, silently: the call was
  fire-and-forget through a `.catch` that never fires for HTTP errors. It
  retries, and surfaces the exact bytes to re-resolve with if it cannot.
- The signed snapshot and per-asset event log ignored issuer moderation,
  so the operator would have signed content they had just withheld.
- `GET /api/v1/assets` could 503 for the whole registry if a single
  stored row was not valid UTF-8 (`convert_from` raises).
- The instance-wide upload budget was 30/minute, low enough for a
  workshop of ten to hit and for one client to block everyone. It is a
  600/minute backstop now; the orphan-pool cap remains the storage bound.
- Image compression flattened transparency onto black when falling back
  to JPEG.

### Security

- Admin tokens shorter than 32 characters are refused at startup (warn
  and stay disabled) rather than accepted and guessable.
- Admin moderation validates key length per kind: a truncated asset id
  used to answer 204 and hide nothing — a silent moderation failure.
- The moderation CLI gained `hide-issuer`/`unhide-issuer`, so losing the
  admin token no longer means raw SQL.
- `Bearer` scheme matching is case-insensitive (RFC 7235).

## [0.1.0] - 2026-08-30

First public release, live at [cachetzec.com](https://cachetzec.com) as a
read-only instance on the public ZSA testnet.

### Added

- Issuer provenance: every asset carries its issuance validating key, and
  chain-level collections (assets grouped by issuer) are served at
  `GET /api/v1/collections`, browsable at `/issuers` in the console.
- Console: batch mint form (up to 16 assets, one transaction), inline
  "verify & register" form on unresolved asset pages, registry search
  (name / description / asset id / issuer), Issuers navigation.
- Background registry sync (`CACHET_SYNC_INTERVAL_SECS`, default 30s): the
  index tracks the chain tip continuously so no visitor pays for a cold
  catch-up scan.
- Page titles per route (asset pages resolve their display name
  server-side), Open Graph / Twitter cards with a generated social image,
  and a 404 page.

- Batch issuance: `POST /api/v1/assets/batch` mints up to 16 assets in one
  ZIP 227 issuance bundle — one transaction, one authorizing signature,
  all-or-nothing (proven on regtest: 3 assets, mixed finalization, 1 txid).
- Permissionless description resolution: `POST
/api/v1/assets/{id}/description` records an asset's plaintext description
  only if it hashes to the on-chain commitment (personalized BLAKE2b-256,
  ZIP 227). Open on read-only deployments — verification, not issuance.
- ZMD-1 interop: descriptions matching ZecBit's published descriptor
  grammar display under the canonical `slug #index` form; every display
  name now carries a `name_source` (`envelope` / `zmd1` / `free_text`) and
  the console renders unverified free-text labels distinctly
  (anti-phishing display rule shared with ZIP 227 guidance).

- Mint studio: issue OrchardZSA assets with metadata sealed into the asset id
  (content-addressed bundle, SHA-256 committed in the on-chain description).
- Verifiable registry: public asset listing with names and images, plus
  in-browser re-verification of every bundle against its on-chain commitment.
- Public asset history: per-asset mints, burns and finalization with txids —
  transfers are shielded and never listed.
- Wallet panel: spendable balances of the tracked accounts, incremental
  trial-decryption sync with chain-reset detection.
- Read-only mode (`CACHET_READ_ONLY=1`) for public deployments: every
  mutating endpoint answers 403, browsing and verification stay open.
- Two networks: local OrchardZSA regtest (Docker) and the public ZSA testnet
  (`CACHET_NETWORK=zsa-testnet`).
- Postgres-backed registry index (derived data only, reconstructible from
  chain scans), OpenAPI-generated TypeScript client, Playwright e2e suite
  against a real regtest chain.

### Security

- Operator denylist (`cachet-server moderate …`): availability-only
  moderation of stored bundles and description texts, with reasons,
  timestamps and reversibility. Hidden bundles answer 410
  `hidden-by-operator`; the chain facts are untouched, honoring the rule
  that a registry can withhold but never lie.
- Read-only deployments no longer expose the operator's wallet:
  `GET /api/v1/wallet` answers 403 there and the console hides the panel —
  the operator's shielded balances are exactly the kind of information
  this project exists to keep private.

- Strict CORS (explicit origin, no wildcard), `X-Content-Type-Options:
nosniff` on the API, `Referrer-Policy: no-referrer` and frame denial on the
  console. No telemetry, no analytics, no IP logging (docs/PRIVACY.md).
