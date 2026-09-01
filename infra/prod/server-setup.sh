#!/usr/bin/env bash
# One-time VPS preparation (Debian 13). Run as root ON THE SERVER, or via:
#   ssh user@host 'bash -s' < infra/prod/server-setup.sh
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update
# docker.io ships Docker Engine on Debian; the compose v2 CLI plugin is
# packaged as docker-compose (trixie) — try the known names in order.
apt-get install -y docker.io
apt-get install -y docker-compose-v2 2>/dev/null \
  || apt-get install -y docker-compose 2>/dev/null \
  || apt-get install -y docker-compose-plugin

# Security updates install themselves. The box runs one service from
# prebuilt images, so an unattended patch cycle is strictly safer than a
# human remembering to log in. No automatic reboot: a kernel update waits
# for an operator, and a deploy restarts the stack anyway.
apt-get install -y unattended-upgrades
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'AUTO'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
AUTO
systemctl enable --now unattended-upgrades 2>/dev/null || true

systemctl enable --now docker
mkdir -p /opt/cachet

# Daily backup of the THREE tables not derivable from the chain: the
# content-addressed bundles (the chain holds only their hashes, so
# community images and descriptions live here), the description
# resolution journal, and the operator's moderation list. Local rotating
# dumps, 7 kept; idempotent install.
mkdir -p /opt/cachet/backups
chmod 700 /opt/cachet/backups
cat > /etc/cron.daily/cachet-bundles-backup <<'CRON'
#!/bin/sh
# Dump the bundle store from the compose Postgres; keep the last 7 days.
cd /opt/cachet || exit 0
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U cachet -d cachet --table=metadata_bundles --table=moderation_hidden \
  --table=asset_descriptions \
  | gzip > "backups/bundles-$(date +%Y%m%d).sql.gz" 2>/dev/null
ls -1t backups/bundles-*.sql.gz 2>/dev/null | tail -n +8 | xargs -r rm --
CRON
chmod 755 /etc/cron.daily/cachet-bundles-backup

echo "--- versions:"
docker --version
docker compose version
echo "--- ready: /opt/cachet"
