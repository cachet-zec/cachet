# Deploying the public read-only instance

The public instance at [cachetzec.com](https://cachetzec.com) runs on a
small VPS (Njalla, Debian 13) as four containers behind Caddy:

```
caddy (TLS, :80/:443) ── cachetzec.com      → console (Next.js, :3000)
                      └─ api.cachetzec.com  → server  (cachet-server, :8080)
server ── postgres (internal only)
```

Design decisions:

- **Read-only** (`CACHET_READ_ONLY=1`): minting, transfers, burns and the
  wallet endpoint answer 403. Description resolution stays open — it is
  verification, not issuance — and so does metadata upload: community
  mints seal full bundles (name, description, image). The storage bound
  is chain-anchored — a garbage collector sweeps bundles that no
  resolved asset description references after a 30-minute grace, a
  per-client upload budget (60/min), a per-client relay budget (10/min)
  and cap of 8 relays in flight, a 256 KB ceiling per sealed image and
  an orphan-pool cap bound the transient window, and a daily
  systemd timer on the host backs up the three tables not derivable
  from the chain.
- **Optional operator surfaces, off by default.** `CACHET_ADMIN_TOKEN`
  enables the token-gated moderation API and the console's `/admin` page
  (404 everywhere without it; a token under 32 characters is refused),
  including the pause switch that stops and resumes minting through the
  instance during a spam wave;
  `CACHET_DISCORD_WEBHOOK` posts relayed mints — asset ids and txid, never
  a client address — to a Discord webhook. Both live in `.env.prod`; see
  `infra/prod/.env.prod.example`.
- **A throwaway seed.** The server requires a seed to boot, but this
  instance never signs anything: it gets a seed generated for it alone.
  The real issuer seed never touches the machine, so a compromised server
  holds nothing worth stealing.
- **The VPS never compiles.** Images are built locally (the QEDIT
  toolchain needs more RAM than the box has) and shipped with
  `docker save | ssh docker load`. The box only runs them.
- **Postgres is derived data, minus three tables** (ADR-001/P4).
  Losing the volume costs a ~1 minute resync for everything the chain can
  rebuild. What it cannot rebuild: `metadata_bundles` (community
  descriptions and images), `asset_descriptions` (the resolution
  journal) and `moderation_hidden` (operator judgment). That is exactly
  what the daily cron above backs up.

## One-time setup

1. VPS with an SSH key, Debian 13. DNS at the registrar:
   `A @ → <ip>`, `A api → <ip>` (`www` optional; Caddy redirects it).
2. Install Docker on the box:
   `ssh root@<ip> 'bash -s' < infra/prod/server-setup.sh`
3. Create `infra/prod/.env.prod` from `.env.prod.example`. All three
   values are mandatory — the server aborts at startup without them:
   a random `POSTGRES_PASSWORD`, a throwaway `CACHET_SEED_PHRASE` from
   `cachet-server --generate-seed`, and a `CACHET_SNAPSHOT_KEY` from
   `cachet-server --generate-snapshot-key`.

## Deploy (and redeploy)

```bash
bash infra/prod/deploy.sh root@<ip>
# or, to stop retyping it:
export CACHET_DEPLOY_HOST=root@<ip>
bash infra/prod/deploy.sh
```

The target is never baked into the script — this is the same file every
self-hoster runs, and it should point at nobody's box by default. The one
two values that cannot come from `.env.prod` are the console's own origin
and its API origin: Next inlines both into the JS bundle at build time, so
they are build args with defaults. The site origin is what `robots.txt`,
`sitemap.xml` and the social-card metadata advertise, so a fork that leaves
it alone would point crawlers at cachetzec.com. Self-hosters override both:

```bash
CACHET_SITE_URL=https://example.org CACHET_API_URL=https://api.example.org   bash infra/prod/deploy.sh root@<ip>
```

Builds both images, ships them, uploads the compose file + Caddyfile +
env, restarts the stack, prunes old layers. Zero-ish downtime; Caddy
keeps its certificates in a volume across restarts.

## Operations

```bash
# status / logs
ssh root@<ip> 'cd /opt/cachet && docker compose -f docker-compose.prod.yml ps'
ssh root@<ip> 'cd /opt/cachet && docker compose -f docker-compose.prod.yml logs -f server'

# operator moderation (availability-only denylist, see packages/registry-spec)
ssh root@<ip> 'cd /opt/cachet && docker compose -f docker-compose.prod.yml \
  exec server cachet-server moderate list'

# one-screen health: load, memory against the ceilings, containers, API errors
bash infra/prod/status.sh root@<ip>

# copy the newest bundle-store dump off the host (default: ~/cachet-backups)
bash infra/prod/pull-backup.sh root@<ip>
```

Backups: `server-setup.sh` installs a systemd timer that dumps, once a
day, the three tables the chain cannot rebuild (metadata bundles,
resolved descriptions, moderation) into `/opt/cachet/backups`, keeping
the seven newest dumps. They live on the same disk as the database, so
`pull-backup.sh` is the copy that survives the machine: run it from a
laptop or a scheduled task. Everything else the registry holds is
recomputed from the chain at boot.

The server's background sync keeps the index at the chain tip every 30s;
after a fresh boot the first full index build takes about a minute.
