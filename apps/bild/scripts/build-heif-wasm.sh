#!/usr/bin/env bash
set -euo pipefail

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly PINNED_EMSDK="/home/oem/.local/share/fernwork-compositor-lab/tooling/emsdk"
readonly HEIF_VERSION="1.23.5"
readonly HEIF_SHA256="fd9036064c4432f0550d15072ddf34956a248279ee9aeaff0fba3fa0f77d8f1a"
readonly DE265_VERSION="1.1.1"
readonly DE265_SHA256="fd48a927e94ed74fc7ce8829d222b9d8599fcbfe8b6448ba66705babc56ab219"
readonly BUILD_ROOT="${HEIF_BUILD_DIR:-/tmp/fernwork-heif-wasm}"

if [[ ! -f "$PINNED_EMSDK/emsdk_env.sh" ]]; then
  echo "Pinned Emscripten 6.0.10 is not installed at $PINNED_EMSDK" >&2
  exit 1
fi
# shellcheck disable=SC1091
source "$PINNED_EMSDK/emsdk_env.sh" >/dev/null
if ! emcc --version 2>/dev/null | head -n 1 | grep -q ' 6\.0\.10 '; then
  echo "Expected Emscripten 6.0.10 from $PINNED_EMSDK" >&2
  exit 1
fi

mkdir -p "$BUILD_ROOT/downloads" "$BUILD_ROOT/src" "$BUILD_ROOT/build"

fetch() {
  local url="$1" output="$2" checksum="$3"
  if [[ ! -f "$output" ]]; then curl -fL --retry 3 -o "$output" "$url"; fi
  printf '%s  %s\n' "$checksum" "$output" | sha256sum --check --status || {
    echo "Checksum mismatch: $output" >&2
    exit 1
  }
}

readonly HEIF_ARCHIVE="$BUILD_ROOT/downloads/libheif-$HEIF_VERSION.tar.gz"
readonly DE265_ARCHIVE="$BUILD_ROOT/downloads/libde265-$DE265_VERSION.tar.gz"
fetch "https://github.com/strukturag/libheif/releases/download/v$HEIF_VERSION/libheif-$HEIF_VERSION.tar.gz" "$HEIF_ARCHIVE" "$HEIF_SHA256"
fetch "https://github.com/strukturag/libde265/releases/download/v$DE265_VERSION/libde265-$DE265_VERSION.tar.gz" "$DE265_ARCHIVE" "$DE265_SHA256"

readonly HEIF_SOURCE="$BUILD_ROOT/src/libheif-$HEIF_VERSION"
readonly DE265_SOURCE="$BUILD_ROOT/src/libde265-$DE265_VERSION"
if [[ ! -d "$HEIF_SOURCE" ]]; then tar -xf "$HEIF_ARCHIVE" -C "$BUILD_ROOT/src"; fi
if [[ ! -d "$DE265_SOURCE" ]]; then tar -xf "$DE265_ARCHIVE" -C "$BUILD_ROOT/src"; fi

readonly DE265_BUILD="$BUILD_ROOT/build/libde265-$DE265_VERSION"
if [[ ! -f "$DE265_BUILD/libde265/libde265.a" ]]; then
  mkdir -p "$DE265_BUILD"
  pushd "$DE265_BUILD" >/dev/null
  emcmake cmake "$DE265_SOURCE" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
    -DENABLE_SIMD=OFF -DENABLE_AVX2=OFF -DENABLE_ENCODER=OFF -DENABLE_SHERLOCK265=OFF \
    -DENABLE_INTERNAL_DEVELOPMENT_TOOLS=OFF -DWITH_FUZZERS=OFF
  emmake make -j"${JOBS:-$(nproc)}" de265
  popd >/dev/null
fi
# libheif's single include-root probe expects this generated header beside the public headers.
cp "$DE265_BUILD/libde265/de265-version.h" "$DE265_SOURCE/libde265/de265-version.h"

readonly HEIF_BUILD="$BUILD_ROOT/build/libheif-$HEIF_VERSION"
if [[ ! -f "$HEIF_BUILD/libheif/libheif.a" ]]; then
  mkdir -p "$HEIF_BUILD"
  pushd "$HEIF_BUILD" >/dev/null
  emcmake cmake "$HEIF_SOURCE" \
    -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
    -DENABLE_PLUGIN_LOADING=OFF -DENABLE_MULTITHREADING_SUPPORT=OFF -DENABLE_PARALLEL_TILE_DECODING=OFF \
    -DWITH_EXAMPLES=OFF -DWITH_GDK_PIXBUF=OFF -DWITH_LIBSHARPYUV=OFF -DWITH_UNCOMPRESSED_CODEC=OFF \
    -DWITH_LIBDE265=ON -DWITH_LIBDE265_PLUGIN=OFF \
    -DLIBDE265_INCLUDE_DIR="$DE265_SOURCE" -DLIBDE265_LIBRARY="$DE265_BUILD/libde265/libde265.a" \
    -DWITH_X265=OFF -DWITH_X264=OFF -DWITH_AOM_DECODER=OFF -DWITH_AOM_ENCODER=OFF \
    -DWITH_DAV1D=OFF -DWITH_OpenH264_DECODER=OFF -DWITH_JPEG_DECODER=OFF -DWITH_JPEG_ENCODER=OFF \
    -DWITH_OpenJPEG_DECODER=OFF -DWITH_OpenJPEG_ENCODER=OFF -DWITH_FFMPEG_DECODER=OFF \
    -DWITH_KVAZAAR=OFF -DWITH_SvtEnc=OFF -DWITH_RAV1E=OFF -DWITH_VVDEC=OFF -DWITH_VVENC=OFF
  emmake make -j"${JOBS:-$(nproc)}" heif
  popd >/dev/null
fi

em++ "$ROOT/src/wasm/heif/bridge.c" \
  -I"$HEIF_SOURCE/libheif/api" -I"$HEIF_BUILD" -O3 --no-entry \
  -Wl,--whole-archive "$HEIF_BUILD/libheif/libheif.a" "$DE265_BUILD/libde265/libde265.a" -Wl,--no-whole-archive \
  -lembind \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createHeifModule -sENVIRONMENT=web,worker \
  -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=2147483648 -sFILESYSTEM=0 -sASSERTIONS=0 \
  -sINCOMING_MODULE_JS_API='["locateFile","wasmBinary"]' -sEXPORTED_RUNTIME_METHODS='["HEAPU8"]' \
  -sEXPORTED_FUNCTIONS='["_malloc","_free","_compositor_heif_decode","_compositor_heif_release","_compositor_heif_result_data","_compositor_heif_result_size","_compositor_heif_result_width","_compositor_heif_result_height"]' \
  -o "$ROOT/src/wasm/heif/libheif.mjs"

chmod 0644 "$ROOT/src/wasm/heif/libheif.mjs" "$ROOT/src/wasm/heif/libheif.wasm"
echo "Built optional LGPL HEIF decoder in src/wasm/heif"
