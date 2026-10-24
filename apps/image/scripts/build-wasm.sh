#!/usr/bin/env bash
set -euo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly PINNED_EMSDK="/home/oem/.local/share/fernwork-compositor-lab/tooling/emsdk"
readonly EMSDK_DIR="${EMSDK_DIR:-$PINNED_EMSDK}"
readonly EMCC="$EMSDK_DIR/upstream/emscripten/emcc"

if [[ ! -x "$EMCC" ]]; then
  echo "Emscripten 6.0.10 is not installed at $EMSDK_DIR" >&2
  echo "Install and activate it with: ./emsdk install 6.0.10 && ./emsdk activate 6.0.10" >&2
  exit 1
fi
if ! "$EMCC" --version 2>/dev/null | head -n 1 | grep -q ' 6\.0\.10 '; then
  echo "Expected Emscripten 6.0.10 at $EMSDK_DIR" >&2
  exit 1
fi

"$EMCC" \
  "$ROOT"/src/wasm/c/{AdjustPixels,BrushPixels,ContentFill,HealPixels,LensPixels,LevelsPixels,NoisePixels,WandPixels}.c \
  -I"$ROOT/src/wasm/c" \
  -O3 \
  -msimd128 \
  --no-entry \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sEXPORT_NAME=createKernelsModule \
  -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH=1 \
  -sFILESYSTEM=0 \
  -sASSERTIONS=0 \
  -sINCOMING_MODULE_JS_API='["locateFile","wasmBinary"]' \
  -sEXPORTED_RUNTIME_METHODS='["HEAPU8"]' \
  -sEXPORTED_FUNCTIONS='["_malloc","_free","_adjust_gradient_map","_adjust_grain","_rgba_clamp_premultiplied","_brush_alpha_bounds","_layer_extract_alpha","_layer_unpremultiply_opaque","_layer_restore_alpha","_content_fill","_heal_coverage_bounds","_spot_heal","_lens_distort","_levels_apply","_levels_histogram","_noise_add","_wand_mask","_wand_trace"]' \
  -o "$ROOT/src/wasm/kernels.mjs"

chmod 0644 "$ROOT/src/wasm/kernels.mjs" "$ROOT/src/wasm/kernels.wasm"
