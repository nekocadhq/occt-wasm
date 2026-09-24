#!/usr/bin/env bash
# Copy WASM build artifacts into ts/dist/ before TypeScript compilation.
# Fails fast if the WASM build hasn't been run yet.
set -euo pipefail

SRC="../dist"
DST="dist"

mkdir -p "$DST"

missing=()
# Both builds ship: index.js imports each glue file, so a bundler fails when one
# is missing, even for an app that never loads the threaded build.
FILES=(occt-wasm.js occt-wasm.wasm occt-wasm-mt.js occt-wasm-mt.wasm)

for f in "${FILES[@]}"; do
    if [[ ! -f "$SRC/$f" ]]; then
        missing+=("$f")
    fi
done

if [[ ${#missing[@]} -gt 0 ]]; then
    echo "error: WASM artifacts not found in $SRC/: ${missing[*]}" >&2
    echo "       Run 'cargo xtask build' and 'cargo xtask build --threads' first." >&2
    exit 1
fi

# Without the marker, webpack fails to resolve the glue's Node-only
# `node:module` import and every bundled app breaks. xtask's link step adds it.
for glue in occt-wasm.js occt-wasm-mt.js; do
    if ! grep -q 'webpackIgnore: true \*/ "node:module"' "$SRC/$glue"; then
        echo "error: $SRC/$glue is missing the bundler patch." >&2
        echo "       Rebuild it with 'cargo xtask build' (add --threads for the -mt glue)." >&2
        exit 1
    fi
done

for f in "${FILES[@]}"; do
    cp "$SRC/$f" "$DST/$f"
done

echo "prebuild: copied occt-wasm{,-mt}.{js,wasm} → $DST/"
