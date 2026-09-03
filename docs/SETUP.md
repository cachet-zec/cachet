# Setup — from zero to an issued asset

Target: a working local stack in under 30 minutes (plus Docker image build
time on the first run).

## Prerequisites

- **Rust ≥ 1.86** (`rustup`), **Node 22**, **pnpm 10**, **Docker**.
- Windows users: everything below works from PowerShell with Docker
  Desktop. Clone with LF endings (`git config --global core.autocrlf false`
  before cloning, or renormalize afterwards) — the upstream shell scripts
  break under CRLF.

## 1. Build the OrchardZSA regtest image (first time only)

```bash
git clone https://github.com/QED-it/zebra.git qedit-zebra
cd qedit-zebra
git checkout 2b036fd6d511011e06f632519c7c9d64c2a8ac2d   # CI-pinned ZSA commit

# REQUIRED until fixed upstream (see docs/upstream/zebra-nu7-panic-issue.md):
# without this, zebrad aborts ~10s after the NU7 activation block is mined
# and the ephemeral chain resets to genesis.
sed -i 's/Version(170_140)/Version(170_150)/' zebra-network/src/constants.rs

docker build -t qedit/zebra-regtest-txv6 -f testnet-single-node-deploy/dockerfile .
```

This compiles Zebra inside Docker — expect 20–60 minutes once.

## 2. Start the stack

```bash
docker compose -f infra/docker-compose.yml up -d
```

Zebra regtest RPC is now on `localhost:18232`, Postgres on `localhost:5432`.

## 3. (Optional) Validate the chain with QEDIT's own scenarios

```bash
git clone https://github.com/QED-it/zcash_tx_tool.git
cd zcash_tx_tool
docker build -t zcash-tx-tool:local .
docker run --add-host=host.docker.internal:host-gateway \
  -e ZCASH_NODE_ADDRESS=host.docker.internal \
  -e ZCASH_NODE_PORT=18232 -e ZCASH_NODE_PROTOCOL=http \
  zcash-tx-tool:local test-issue-one
```

`test-issue-one` issues a single asset; `test-orchard-zsa` runs the full
issue → transfer → burn flow. **Restart the Zebra container between
scenario runs** (they assume a fresh chain):
`docker compose -f infra/docker-compose.yml restart zebra-regtest`.

> `host.docker.internal` works on Docker Desktop (Windows/macOS). On
> native Linux Docker, the regtest RPC is published on loopback only —
> run the tx_tool container with `--network host` instead.

## 4. Install the Sapling proving parameters (first time only)

The transaction builder needs the Sapling parameters (~50 MB) even for
issuance-only transactions. Download them to the standard location:

```bash
# Linux/macOS
./zcutil/fetch-params.sh   # from the zcash_tx_tool clone, or:
mkdir -p ~/.zcash-params && cd ~/.zcash-params
curl -LO https://download.z.cash/downloads/sapling-spend.params
curl -LO https://download.z.cash/downloads/sapling-output.params
```

On Windows (PowerShell), the folder is `%APPDATA%\ZcashParams`:

```powershell
$dir = "$env:APPDATA\ZcashParams"; New-Item -ItemType Directory -Force $dir
curl.exe -sL -o "$dir\sapling-spend.params"  https://download.z.cash/downloads/sapling-spend.params
curl.exe -sL -o "$dir\sapling-output.params" https://download.z.cash/downloads/sapling-output.params
```

## 5. Run the Cachet server

```bash
cargo run --manifest-path server/Cargo.toml --bin cachet-server
```

- API: `http://localhost:8080`
- Interactive docs: `http://localhost:8080/api/docs`
- Contract: `http://localhost:8080/api/openapi.json`

The server talks to the regtest node by default (`CACHET_BACKEND=zsa`,
`CACHET_NODE_URL=http://127.0.0.1:18232`). Set `CACHET_BACKEND=memory` to
run without a node.

The server binds `127.0.0.1` by default: a writable instance exposes
unauthenticated wallet-signing endpoints, so it deliberately does not
reach the network. To serve other machines or containers, set
`CACHET_BIND=0.0.0.0` (read SECURITY.md's self-hosting section first) and
point `CACHET_CORS_ORIGIN` at the console's origin. It doubles as the
public link origin in Discord mint notifications, so set it even when
CORS is not a concern.

Other knobs (all optional): `PORT` (default 8080),
`CACHET_READ_ONLY=1` (public browse-and-verify deployment: wallet-signing
endpoints answer 403), `CACHET_RATE_LIMIT_PER_SEC` (per-client rate
limit, default 30 req/s with bursts of 60, `0` disables),
`CACHET_TRUST_PROXY=1` (key the rate limit and the per-client write
throttles on `X-Forwarded-For` / `X-Real-IP` — only behind a reverse
proxy you control; the throttles themselves are fixed: 60 metadata
uploads a minute and 8 relays in flight per client, 429 beyond),
`CACHET_SYNC_INTERVAL_SECS`
(background registry sync cadence, default 30), `CACHET_IPFS_GATEWAY`
(ZMD-1 manifest resolution, default `https://ipfs.io`),
`CACHET_SNAPSHOT_KEY` (Ed25519 seed enabling signed registry snapshots;
generate with `--generate-snapshot-key`), `CACHET_ADMIN_TOKEN` (enables
the token-gated moderation API and the console's `/admin` page; must be
at least 32 characters or it is refused — see SECURITY.md), and
`CACHET_DISCORD_WEBHOOK` (posts relayed mints to a Discord webhook:
asset ids and txid, never a client address), and `CACHET_FEATURED_ASSETS`
(comma-separated asset ids the landing showcase leads with, in order;
baked into the console at build time by `deploy.sh`, so it is editorial
for the landing only and the console keeps listing everything). The console
builds with `NEXT_TELEMETRY_DISABLED=1` (CI and the prod image both set
it; Next.js telemetry is off).

The asset registry cache connects to Postgres via `CACHET_DATABASE_URL`
(default matches docker-compose:
`postgres://cachet:cachet-dev-only@localhost:5432/cachet`). If the
database is unreachable the server starts anyway and serves listings by
full chain scan — the index is a cache, never a dependency. It detects
chain resets (routine on the ephemeral regtest) and rebuilds itself; the
description journal, the bundle store and the moderation denylist persist
across resets, by design.

### Integration tests against the regtest

With the stack up **on a fresh chain** and params installed:

```bash
cargo test -p cachet-chain --test regtest -- --ignored --test-threads=1
```

### Connecting to the public ZSA testnet

No local node or Docker required — the server talks to QEDIT's public node
directly. A **private seed phrase is mandatory** there: the regtest demo
phrase is public knowledge, and on a shared chain it would let anyone
spend your notes and squat your asset ids.

```bash
# once: generate and save a private issuer seed
cargo run --manifest-path server/Cargo.toml --bin cachet-server -- --generate-seed

CACHET_NETWORK=zsa-testnet \
CACHET_SEED_PHRASE="<your 24 words>" \
CACHET_SCAN_START_HEIGHT=1 \
cargo run --manifest-path server/Cargo.toml --bin cachet-server
```

Notes:

- Default node: `https://dev.zebra.zsa-test.net:443` (override with
  `CACHET_NODE_URL`).
- `CACHET_SCAN_START_HEIGHT` is the wallet/registry birthday. While the
  testnet is young, `1` gives a complete registry; pin whatever you choose
  so wallet state stays consistent across restarts.
- Block production is shared: Cachet submits its own blocks like the
  reference tx_tool, and verifies afterwards that the transaction actually
  landed (a competing producer can win the height — the API then returns a
  clean retryable error).
- The console needs no changes: the network badge follows `/api/v1/chain`.

### End-to-end tests (Playwright)

The full UI lifecycle (issue → list → transfer → burn) against the real
stack. Requires the docker-compose stack up and params installed;
Playwright starts (or reuses) the server and the console itself:

```bash
pnpm --filter @cachet/console e2e
```

First time only: `pnpm --filter @cachet/console exec playwright install chromium`.

## 6. Run the console

```bash
pnpm install
pnpm dev
```

Open `http://localhost:3000/console`: node status, an issuance form,
and asset lookup (`/` is the public landing page).

## Regenerating the TypeScript client

After any API change:

```bash
pnpm openapi:export     # writes packages/api-client/openapi.json from the Rust types
pnpm openapi:generate   # regenerates packages/api-client/src/generated/schema.ts
```

`openapi.json` is committed — it is the reviewable contract snapshot,
and a diff on it is how an API change gets noticed. `src/generated/`
is **not** committed (it is gitignored): CI regenerates it before
typecheck, and so does a fresh clone's first `pnpm typecheck`.

## Troubleshooting

- **`bash\r: No such file or directory` during a Docker build** — CRLF
  checkout; run `git config core.autocrlf false && git rm -rq --cached . &&
git reset --hard` inside the offending clone.
- **Console shows "Node unreachable"** — the server is not running on
  port 8080, or `NEXT_PUBLIC_CACHET_API_URL` points elsewhere.
- **`robots.txt` or a social card names the wrong domain** —
  `NEXT_PUBLIC_CACHET_SITE_URL` defaults to `https://cachetzec.com`. Like
  the API origin it is inlined at build time, so set it when you build
  (`CACHET_SITE_URL=` in `infra/prod/deploy.sh`), not at runtime.
- **tx_tool scenario fails mid-run** — the chain is not fresh; restart the
  `zebra-regtest` service and rerun.
