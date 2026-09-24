#!/usr/bin/env bash
set -euo pipefail

# Reproducible launcher for the measurement-only `a6-spike` feature. Build first with:
#   npm run tauri:build -- --features a6-spike --no-bundle
repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
output_dir="${1:-/tmp/fernwork-a6-results}"
binary="$repo_dir/src-tauri/target/release/fernwork-bildeditor"
source "$repo_dir/scripts/tauri-env.sh"
mkdir -p "$output_dir"

if [[ ! -x "$binary" ]]; then
  echo "missing $binary; build the a6-spike release first" >&2
  exit 2
fi

run_webview() {
  local name="$1"
  shift
  env -u WEBKIT_DISABLE_DMABUF_RENDERER \
    -u WEBKIT_DMABUF_RENDERER_FORCE_SHM \
    -u WEBKIT_SHOW_DAMAGE \
    -u WEBKIT_DISABLE_COMPOSITING_MODE \
    -u WEBKIT_FORCE_COMPOSITING_MODE \
    -u GDK_SCALE \
    -u FERNWORK_A6_RENDER_ONLY \
    -u FERNWORK_A6_HARDWARE_POLICY \
    -u FERNWORK_A6_ACCELERATED_2D \
    FERNWORK_A6_SPIKE=1 \
    FERNWORK_A6_RESULT="$output_dir/$name.json" \
    "$@" timeout 15m "$binary"
}

run_webview default env FERNWORK_A6_HARDWARE_POLICY=on-demand FERNWORK_A6_ACCELERATED_2D=1
run_webview hardware-always env FERNWORK_A6_RENDER_ONLY=1 FERNWORK_A6_HARDWARE_POLICY=always FERNWORK_A6_ACCELERATED_2D=1
run_webview hardware-never env FERNWORK_A6_RENDER_ONLY=1 FERNWORK_A6_HARDWARE_POLICY=never FERNWORK_A6_ACCELERATED_2D=1
run_webview accelerated-2d-off env FERNWORK_A6_RENDER_ONLY=1 FERNWORK_A6_HARDWARE_POLICY=on-demand FERNWORK_A6_ACCELERATED_2D=0
run_webview compositing-disabled env FERNWORK_A6_RENDER_ONLY=1 FERNWORK_A6_HARDWARE_POLICY=on-demand FERNWORK_A6_ACCELERATED_2D=1 WEBKIT_DISABLE_COMPOSITING_MODE=1
run_webview compositing-forced env FERNWORK_A6_RENDER_ONLY=1 FERNWORK_A6_HARDWARE_POLICY=on-demand FERNWORK_A6_ACCELERATED_2D=1 WEBKIT_FORCE_COMPOSITING_MODE=1
run_webview dmabuf-disabled env FERNWORK_A6_RENDER_ONLY=1 FERNWORK_A6_HARDWARE_POLICY=on-demand WEBKIT_DISABLE_DMABUF_RENDERER=1
run_webview dmabuf-force-shm env FERNWORK_A6_RENDER_ONLY=1 FERNWORK_A6_HARDWARE_POLICY=on-demand WEBKIT_DMABUF_RENDERER_FORCE_SHM=1
run_webview damage-overlay env FERNWORK_A6_RENDER_ONLY=1 FERNWORK_A6_HARDWARE_POLICY=on-demand WEBKIT_SHOW_DAMAGE=1
run_webview dpr-2 env FERNWORK_A6_RENDER_ONLY=1 FERNWORK_A6_HARDWARE_POLICY=on-demand GDK_SCALE=2

# Keep the native comparison on the same Intel HD 630 as the WebKitGTK runs.
env MESA_VK_DEVICE_SELECT="${FERNWORK_A6_VK_DEVICE:-8086:591b!}" \
  FERNWORK_A6_WGPU=1 FERNWORK_A6_RESULT="$output_dir/wgpu.json" timeout 5m "$binary"

echo "$output_dir"
