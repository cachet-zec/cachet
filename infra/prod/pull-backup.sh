#!/usr/bin/env bash
# Copy the newest bundle-store dump off the host, read-only. The daily
# timer (server-setup.sh) keeps seven days of dumps next to the database
# they come from, so a lost machine loses them too; this puts the latest
# one somewhere else. Run it whenever you think of it, or from a
# scheduled task:
#
#   bash infra/prod/pull-backup.sh root@your-host            # -> ~/cachet-backups
#   bash infra/prod/pull-backup.sh root@your-host /some/dir
#
# Fetches only the newest dump, checks the gzip is whole, and skips the
# copy when that file is already here. Nothing on the host is touched.
set -euo pipefail

HOST="${1:?usage: pull-backup.sh user@host [local-dir]}"
DEST="${2:-$HOME/cachet-backups}"
REMOTE_DIR=/opt/cachet/backups

latest=$(ssh -o StrictHostKeyChecking=accept-new "$HOST" \
    "ls -1t $REMOTE_DIR/bundles-*.sql.gz 2>/dev/null | head -1")
if [ -z "$latest" ]; then
    echo "no dump found in $REMOTE_DIR on $HOST: has the timer run yet?" >&2
    exit 1
fi
name=$(basename "$latest")

mkdir -p "$DEST"
if [ -s "$DEST/$name" ]; then
    echo "already here: $DEST/$name"
else
    scp -q -o StrictHostKeyChecking=accept-new "$HOST:$latest" "$DEST/$name.part"
    gzip -t "$DEST/$name.part"
    mv "$DEST/$name.part" "$DEST/$name"
    echo "pulled: $DEST/$name"
fi

size=$(du -h "$DEST/$name" | cut -f1)
kept=$(ls -1 "$DEST"/bundles-*.sql.gz 2>/dev/null | wc -l | tr -d ' ')
echo "newest dump: $name ($size); $kept dump(s) kept locally in $DEST"
