#!/usr/bin/env bash
# Inner mint-engine build: compiles both wasm variants and post-processes
# them. Runs on any Linux with rustup + clang; invoked by
# infra/build-mint-engine.sh (inside Docker) and by CI (directly).
#
# Env:
#   REPO   repository root (default: two levels up from this script)
#   TOOLS  cache dir for binaryen + wasm-bindgen-cli (default: $REPO/.wasm-tools)
set -euo pipefail

REPO="${REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
TOOLS="${TOOLS:-$REPO/.wasm-tools}"
OUT="$REPO/console/public/mint-engine"
OUT_MT="$REPO/console/public/mint-engine-mt"
OUT_VERIFY="$REPO/console/public/verify-engine"
cd "$REPO/server"

# Debian's binaryen (v108) predates proper externref-table handling and
# emits modules whose table cannot grow; use a pinned modern release.
# This tool post-processes the wasm shipped to every browser, so the
# download is pinned by version AND verified by checksum — a tampered or
# swapped release asset is rejected rather than silently trusted.
BINARYEN_URL="https://github.com/WebAssembly/binaryen/releases/download/version_123/binaryen-version_123-x86_64-linux.tar.gz"
BINARYEN_SHA256="e959f2170af4c20c552e9de3a0253704d6a9d2766e8fdb88e4d6ac4bae9388fe"
if [ ! -x "$TOOLS/binaryen/bin/wasm-opt" ]; then
    mkdir -p "$TOOLS"
    curl -sL "$BINARYEN_URL" -o "$TOOLS/binaryen.tar.gz"
    echo "$BINARYEN_SHA256  $TOOLS/binaryen.tar.gz" | sha256sum -c - \
        || { echo "binaryen checksum mismatch — refusing to use it" >&2; exit 1; }
    tar xz -C "$TOOLS" -f "$TOOLS/binaryen.tar.gz"
    rm -f "$TOOLS/binaryen.tar.gz"
    mv "$TOOLS/binaryen-version_123" "$TOOLS/binaryen"
fi
export PATH="$TOOLS/binaryen/bin:$PATH"
rustup target add wasm32-unknown-unknown >/dev/null 2>&1

VER=$(grep -A1 'name = "wasm-bindgen"' Cargo.lock | grep version | head -1 | cut -d'"' -f2)
export CARGO_INSTALL_ROOT="$TOOLS"
[ -x "$TOOLS/bin/wasm-bindgen" ] && "$TOOLS/bin/wasm-bindgen" --version | grep -q "$VER" \
    || cargo install wasm-bindgen-cli --version "$VER" --quiet

# ---- single-core build (stable, the universal fallback) ----------------
cargo build --release --target wasm32-unknown-unknown -p cachet-mint-engine
mkdir -p "$OUT"
"$TOOLS/bin/wasm-bindgen" --target web --out-dir "$OUT" \
    target/wasm32-unknown-unknown/release/cachet_mint_engine.wasm
wasm-opt -O2 --enable-bulk-memory --enable-nontrapping-float-to-int \
    --enable-reference-types \
    -o "$OUT/cachet_mint_engine_bg.wasm.opt" "$OUT/cachet_mint_engine_bg.wasm" \
    && mv "$OUT/cachet_mint_engine_bg.wasm.opt" "$OUT/cachet_mint_engine_bg.wasm"

# ---- verification engine (asset-id derivation only) --------------------
# Deliberately separate from the mint engine: this one carries no Halo2
# circuit, so it is small enough to load on an asset page. It proves
# nothing and holds no key - it recomputes an asset id from the issuer
# key and description, which are both public.
cargo build --release --target wasm32-unknown-unknown -p cachet-verify-engine
mkdir -p "$OUT_VERIFY"
"$TOOLS/bin/wasm-bindgen" --target web --out-dir "$OUT_VERIFY" \
    target/wasm32-unknown-unknown/release/cachet_verify_engine.wasm
wasm-opt -O2 --enable-bulk-memory --enable-nontrapping-float-to-int \
    --enable-reference-types \
    -o "$OUT_VERIFY/cachet_verify_engine_bg.wasm.opt" "$OUT_VERIFY/cachet_verify_engine_bg.wasm" \
    && mv "$OUT_VERIFY/cachet_verify_engine_bg.wasm.opt" "$OUT_VERIFY/cachet_verify_engine_bg.wasm"

# ---- threaded build (nightly: std rebuilt with atomics) ----------------
rustup toolchain install nightly --profile minimal >/dev/null 2>&1
rustup component add rust-src --toolchain nightly >/dev/null 2>&1
rustup target add wasm32-unknown-unknown --toolchain nightly >/dev/null 2>&1
# RUSTFLAGS overrides .cargo/config.toml, so the nu7 cfg must ride along.
# The shared/imported memory link args are explicit: without them the
# linker emits a private memory and wasm-bindgen-rayon dies with
# 'DataCloneError: #<Memory> could not be cloned' when spawning workers;
# the TLS exports fail later, in wasm-bindgen ('failed to find
# __wasm_init_tls').
export CARGO_TARGET_DIR="$REPO/server/target-wasm-mt"
RUSTFLAGS='--cfg zcash_unstable="nu7" -C target-feature=+atomics,+bulk-memory,+mutable-globals -C link-arg=--shared-memory -C link-arg=--import-memory -C link-arg=--max-memory=2147483648 -C link-arg=--export=__wasm_init_tls -C link-arg=--export=__tls_size -C link-arg=--export=__tls_align -C link-arg=--export=__tls_base' \
    cargo +nightly build -Z build-std=panic_abort,std \
    --release --target wasm32-unknown-unknown -p cachet-mint-engine --features threads
mkdir -p "$OUT_MT"
"$TOOLS/bin/wasm-bindgen" --target web --out-dir "$OUT_MT" \
    "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/cachet_mint_engine.wasm"
wasm-opt -O2 --enable-bulk-memory --enable-nontrapping-float-to-int \
    --enable-reference-types --enable-threads \
    -o "$OUT_MT/cachet_mint_engine_bg.wasm.opt" "$OUT_MT/cachet_mint_engine_bg.wasm" \
    && mv "$OUT_MT/cachet_mint_engine_bg.wasm.opt" "$OUT_MT/cachet_mint_engine_bg.wasm"

# wasm-bindgen-rayon's generated worker bootstrap still calls the init
# function positionally, which wasm-bindgen deprecated: every spawned
# thread prints a warning, so an 8-thread pool prints eight. The generated
# glue destructures the object form and takes the identical path, so this
# is the same call without the console noise. Re-applied on every build
# because the snippet is regenerated each time.
HELPERS="$OUT_MT/snippets"/wasm-bindgen-rayon-*/src/workerHelpers.no-bundler.js
for f in $HELPERS; do
    [ -f "$f" ] || continue
    sed -i 's/await pkg\.default(data\.module, data\.memory);/await pkg.default({ module_or_path: data.module, memory: data.memory });/' "$f"
done

ls -la "$OUT" "$OUT_MT" "$OUT_VERIFY"
