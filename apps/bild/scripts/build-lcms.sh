#!/usr/bin/env bash
set -euo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly PINNED_EMSDK="/home/oem/.local/share/fernwork-compositor-lab/tooling/emsdk"
readonly EMSDK_DIR="${EMSDK_DIR:-$PINNED_EMSDK}"
readonly EMCC="$EMSDK_DIR/upstream/emscripten/emcc"
readonly LCMS_VERSION="2.19.1"
readonly LCMS_SHA256="bfc54f7bab59fbc921012014a8032e4cba4abd46db47d46b76416a8c0b2815c8"
readonly LCMS_URL="https://github.com/mm2/Little-CMS/releases/download/lcms${LCMS_VERSION}/lcms2-${LCMS_VERSION}.tar.gz"

if [[ ! -x "$EMCC" ]]; then
  echo "Emscripten 6.0.10 is not installed at $EMSDK_DIR" >&2
  exit 1
fi
if ! "$EMCC" --version 2>/dev/null | head -n 1 | grep -q ' 6\.0\.10 '; then
  echo "Expected Emscripten 6.0.10 at $EMSDK_DIR" >&2
  exit 1
fi

readonly BUILD_DIR="$(mktemp -d)"
trap 'rm -rf -- "$BUILD_DIR"' EXIT
curl --fail --location --silent --show-error "$LCMS_URL" --output "$BUILD_DIR/lcms.tar.gz"
echo "$LCMS_SHA256  $BUILD_DIR/lcms.tar.gz" | sha256sum --check --status || {
  echo "Little CMS ${LCMS_VERSION} archive checksum mismatch" >&2
  exit 1
}
tar -xzf "$BUILD_DIR/lcms.tar.gz" -C "$BUILD_DIR"
readonly SOURCE="$BUILD_DIR/lcms2-${LCMS_VERSION}"

"$EMCC" \
  "$ROOT/src/wasm/lcms/lcms_wrapper.c" \
  "$SOURCE"/src/*.c \
  -I"$SOURCE/include" \
  -I"$SOURCE/src" \
  -O3 \
  -msimd128 \
  -DCMS_NO_PTHREADS=1 \
  --no-entry \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sEXPORT_NAME=createLcmsModule \
  -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH=1 \
  -sFILESYSTEM=0 \
  -sASSERTIONS=0 \
  -sINCOMING_MODULE_JS_API='["locateFile","wasmBinary"]' \
  -sEXPORTED_RUNTIME_METHODS='["HEAPU8"]' \
  -sEXPORTED_FUNCTIONS='["_malloc","_free","_lcms_create_transform","_lcms_do_transform","_lcms_delete_transform","_lcms_create_rgb_profile","_lcms_create_gray_profile","_lcms_create_cmyk_profile"]' \
  -o "$ROOT/src/wasm/lcms/lcms.mjs"

chmod 0644 "$ROOT/src/wasm/lcms/lcms.mjs" "$ROOT/src/wasm/lcms/lcms.wasm"
