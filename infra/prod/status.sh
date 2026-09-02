#!/usr/bin/env bash
# One-screen health of the public instance, read-only. Run it whenever
# you wonder how the machine is doing:
#
#   bash infra/prod/status.sh root@your-host
#
# Reads: load, memory against the ceilings, disk, container health and
# restarts, the API's warnings, errors and relayed mints over the last
# ten minutes, and the chain tip the registry follows. Prints no client
# address (there are none in the logs to print - PRIVACY.md P2).
set -euo pipefail

HOST="${1:?usage: status.sh user@host}"

ssh -o StrictHostKeyChecking=accept-new "$HOST" 'bash -s' <<'REMOTE'
set -u
cores=$(nproc)
echo "== machine =="
# On an LXC host /proc/loadavg is the whole physical host's load, not this
# container's: informative only. The per-container CPU column below is
# what this instance actually uses.
printf "load (1/5/15 min, host-wide on LXC): %s   cores here: %s\n" "$(cut -d" " -f1-3 /proc/loadavg)" "$cores"
free -m | awk '/Mem/{printf "memory: %d MB used of %d MB (%d%%), %d MB available\n", $3, $2, $3*100/$2, $7}'
df -h / | awk 'NR==2{printf "disk: %s used of %s (%s)\n", $3, $2, $5}'
echo
echo "== containers (usage / ceiling, restarts) =="
docker stats --no-stream --format "{{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}" | sort |
  while IFS=$'\t' read -r name mem cpu; do
    restarts=$(docker inspect --format '{{.RestartCount}}' "$name")
    health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$name")
    printf "%-20s %-24s cpu %-8s %-10s restarts %s\n" "$name" "$mem" "$cpu" "$health" "$restarts"
  done
echo
echo "== api, last 10 minutes =="
# The API logs events, not requests (no per-request line exists to count,
# by design): what matters here is whether it is complaining, and whether
# people are minting.
log=$(docker logs --since 10m cachet-server-1 2>&1 || true)
printf "warnings: %s   errors: %s   relayed mints: %s\n" \
  "$(printf '%s\n' "$log" | grep -c ' WARN' || true)" \
  "$(printf '%s\n' "$log" | grep -c ' ERROR' || true)" \
  "$(printf '%s\n' "$log" | grep -c 'relayed a browser-built transaction' || true)"
printf '%s\n' "$log" | grep -E ' (WARN|ERROR)' | tail -3 | sed 's/\x1b\[[0-9;]*m//g' | cut -c1-140 || true
echo
echo "== registry =="
# The API port is not published on the host (only Caddy is), so ask the
# public origin like a visitor would.
curl -s --max-time 5 https://api.cachetzec.com/api/v1/chain 2>/dev/null |
  python3 -c 'import sys,json; d=json.load(sys.stdin); print("chain tip:", d.get("tip_height"), " network:", d.get("network"))' 2>/dev/null ||
  echo "api not answering"
REMOTE
