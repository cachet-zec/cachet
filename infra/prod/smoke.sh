#!/usr/bin/env bash
# Post-deploy smoke check for the public instance: fifteen seconds of
# curl that verify the whole deployment. Run after every deploy:
#   bash infra/prod/smoke.sh
# Exits non-zero on the first failure.
set -euo pipefail

SITE="${CACHET_SITE:-https://cachetzec.com}"
API="${CACHET_API:-https://api.cachetzec.com}"
pass=0

check() {
  local label="$1"; shift
  if "$@" > /dev/null 2>&1; then
    echo "  ok  $label"
    pass=$((pass + 1))
  else
    echo "FAIL  $label"
    exit 1
  fi
}

has_header() { curl -s -D- -o /dev/null "$1" | grep -qi "$2"; }
http_200() { [ "$(curl -s -o /dev/null -w '%{http_code}' "$1")" = "200" ]; }
body_has() { curl -s "$1" | grep -q "$2"; }

echo "smoke: $SITE + $API"

check "console up"                    http_200 "$SITE"
check "mint page up"                  http_200 "$SITE/mint"
check "working paper served"          http_200 "$SITE/cachet-whitepaper.pdf"
check "engine (threaded) served"      http_200 "$SITE/mint-engine-mt/cachet_mint_engine_bg.wasm"
check "api chain info"                http_200 "$API/api/v1/chain"
check "api asset listing"             http_200 "$API/api/v1/assets"
check "raw blocks page"               http_200 "$API/api/v1/chain/transactions?start_height=1&limit=5"
check "snapshot signed"               body_has "$API/api/v1/snapshot" '"signature"'
check "snapshot key exposed"          body_has "$API/api/v1/chain" '"snapshot_public_key"'
check "read-only guard (mint = 403)" bash -c "[ \"\$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{\"description\":\"smoke\",\"amount\":1}' $API/api/v1/assets)\" = '403' ]"
check "CSP on console"                has_header "$SITE" "content-security-policy"
check "HSTS on console"               has_header "$SITE" "strict-transport-security"
check "cross-origin isolation"        has_header "$SITE/mint" "cross-origin-embedder-policy"
check "CORP on api"                   has_header "$API/api/v1/chain" "cross-origin-resource-policy"
check "compression on engine"         bash -c "curl -s -o /dev/null -H 'Accept-Encoding: gzip' -D- $SITE/mint-engine/cachet_mint_engine_bg.wasm | grep -qi 'content-encoding: gzip'"

echo "smoke: $pass/15 checks green"
