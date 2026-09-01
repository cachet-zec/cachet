#!/usr/bin/env bash
# Build the browser mint engine (cachet-mint-engine) to WebAssembly and
# drop the JS bindings into the console's public assets.
#
# Two variants ship:
#   console/public/mint-engine     single-core (works everywhere)
#   console/public/mint-engine-mt  rayon over wasm threads (needs a
#                                  cross-origin-isolated page; the worker
#                                  falls back to the single-core build)
#
# This wrapper provides the Linux toolchain via Docker; the actual build
# steps live in infra/mint-engine-build-inner.sh (also used directly by
# the CI wasm job, so the two can never drift).
# Usage, from the repository root:
#   bash infra/build-mint-engine.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

MSYS_NO_PATHCONV=1 docker run --rm \
    -v "$ROOT:/repo" \
    -v cachet-wasm-cargo:/usr/local/cargo/registry \
    -v cachet-wasm-git:/usr/local/cargo/git \
    -v cachet-wasm-rustup:/usr/local/rustup \
    -v cachet-wasm-tools:/tools \
    -w /repo/server rust:1-bookworm bash -c "
set -e
apt-get update -qq >/dev/null && apt-get install -y -qq clang >/dev/null 2>&1
REPO=/repo TOOLS=/tools bash /repo/infra/mint-engine-build-inner.sh"

echo "done: console/public/mint-engine + console/public/mint-engine-mt"
