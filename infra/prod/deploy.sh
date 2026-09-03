#!/usr/bin/env bash
# Build the production images locally, ship them to the VPS, and (re)start
# the stack. The VPS never compiles anything — the QEDIT toolchain needs
# more RAM than the box has, and the box needs none of it to run.
#
# Usage, from the repository root:
#   bash infra/prod/deploy.sh user@host
#
# The target is deliberately not baked in: this script is the same one any
# self-hoster runs. Set CACHET_DEPLOY_HOST in your shell to avoid retyping
# it. Requires infra/prod/.env.prod (gitignored) — see .env.prod.example.
set -euo pipefail

HOST="${1:-${CACHET_DEPLOY_HOST:-}}"
if [ -z "$HOST" ]; then
    echo "usage: bash infra/prod/deploy.sh user@host   (or set CACHET_DEPLOY_HOST)" >&2
    exit 1
fi
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
REMOTE=/opt/cachet

[ -f "$DIR/.env.prod" ] || {
    echo "missing $DIR/.env.prod (copy .env.prod.example and fill it)" >&2
    exit 1
}

# Fail loudly before doing anything: with Docker Desktop stopped, `docker
# build` errors out and a truncated log reads like a finished deploy while
# production still runs the previous build.
docker info >/dev/null 2>&1 || {
    echo "Docker daemon is not reachable (is Docker Desktop running?). Nothing was built or shipped." >&2
    exit 1
}

echo "==> building images"
docker build -f "$DIR/Dockerfile.server" -t cachet-server:prod "$ROOT"
# Baked into the JS bundle at build time, so neither can come from
# .env.prod. Both default to this deployment; point them at your own:
#   CACHET_SITE_URL=https://example.org CACHET_API_URL=https://api.example.org \
#     bash infra/prod/deploy.sh root@host
# The landing's featured asset ids are baked in too. They are public, so
# they may live in .env.prod next to the secrets for convenience; an
# explicit CACHET_FEATURED_ASSETS in the environment wins.
FEATURED="${CACHET_FEATURED_ASSETS:-$(grep -E '^CACHET_FEATURED_ASSETS=' "$DIR/.env.prod" | cut -d= -f2- || true)}"
docker build -f "$DIR/Dockerfile.console" \
    --build-arg NEXT_PUBLIC_CACHET_API_URL="${CACHET_API_URL:-https://api.cachetzec.com}" \
    --build-arg NEXT_PUBLIC_CACHET_SITE_URL="${CACHET_SITE_URL:-https://cachetzec.com}" \
    --build-arg NEXT_PUBLIC_CACHET_FEATURED_ASSETS="$FEATURED" \
    -t cachet-console:prod "$ROOT"

echo "==> shipping images to $HOST (this is the slow part)"
docker save cachet-server:prod cachet-console:prod | gzip \
    | ssh -o StrictHostKeyChecking=accept-new "$HOST" 'gunzip | docker load'

echo "==> shipping config"
scp -o StrictHostKeyChecking=accept-new \
    "$DIR/docker-compose.prod.yml" "$DIR/Caddyfile" "$DIR/.env.prod" \
    "$HOST:$REMOTE/"

# .env.prod holds the DB password, throwaway seed and snapshot signing key:
# lock it down (scp preserves the source mode, which may be world-readable).
ssh "$HOST" "chmod 700 $REMOTE && chmod 600 $REMOTE/.env.prod"

echo "==> starting the stack"
ssh "$HOST" "cd $REMOTE \
    && docker compose -f docker-compose.prod.yml --env-file .env.prod up -d \
    && docker image prune -f"

echo "==> done. checks:"
ssh "$HOST" "cd $REMOTE && docker compose -f docker-compose.prod.yml ps"
