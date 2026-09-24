#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
output_dir="${1:-/tmp/fernwork-a6b-results}"
binary="$repo_dir/src-tauri/target/release/fernwork-bildeditor"
source "$repo_dir/scripts/tauri-env.sh"
mkdir -p "$output_dir"

if [[ ! -x "$binary" ]]; then
  echo "missing $binary; build with scripts/tauri-build.sh --features a6-spike --no-bundle" >&2
  exit 2
fi

wait_for_idle() {
  local polls=0 load
  while true; do
    uptime | tee -a "$output_dir/load.log"
    load="$(awk '{print $1}' /proc/loadavg)"
    if awk -v value="$load" 'BEGIN { exit !(value <= 3) }'; then return; fi
    polls=$((polls + 1))
    if (( polls >= 30 )); then
      echo "1-minute load stayed above 3 for 30 minutes" >&2
      exit 3
    fi
    sleep 60
  done
}

run_webview() {
  local name="$1"
  shift
  if [[ -s "$output_dir/$name.json" ]]; then
    echo "preserving completed $name"
    return
  fi
  wait_for_idle
  env -u WEBKIT_DISABLE_DMABUF_RENDERER \
    -u WEBKIT_DMABUF_RENDERER_FORCE_SHM \
    -u WEBKIT_SHOW_DAMAGE \
    -u WEBKIT_DISABLE_COMPOSITING_MODE \
    -u WEBKIT_FORCE_COMPOSITING_MODE \
    -u GDK_SCALE \
    -u FERNWORK_A6_RENDER_ONLY \
    -u FERNWORK_A6_HARDWARE_POLICY \
    -u FERNWORK_A6_ACCELERATED_2D \
    -u FERNWORK_WEBKIT_DMABUF \
    FERNWORK_A6_SPIKE=1 \
    FERNWORK_A6_RUN_LABEL="$name" \
    FERNWORK_A6_RESULT="$output_dir/$name.json" \
    "$@" timeout 20m "$binary"
}

for repeat in 1 2 3; do
  # Explicit opt-out keeps this the pre-product-setting control even after forced SHM is enabled.
  run_webview "default-$repeat" env FERNWORK_WEBKIT_DMABUF=1 FERNWORK_A6_HARDWARE_POLICY=on-demand
  run_webview "shm-$repeat" env FERNWORK_A6_RENDER_ONLY=1 FERNWORK_A6_HARDWARE_POLICY=on-demand \
    WEBKIT_DMABUF_RENDERER_FORCE_SHM=1
done

# Resize is exercised in every run. These optional processes capture a changed GTK scale/DPR;
# one pair is sufficient for the visual check because no DPR timing is reported.
if [[ "${FERNWORK_A6B_SKIP_DPR:-0}" != 1 ]]; then
  for repeat in 1 2 3; do
    run_webview "dpr2-default-$repeat" env FERNWORK_WEBKIT_DMABUF=1 FERNWORK_A6_RENDER_ONLY=1 GDK_SCALE=2
    run_webview "dpr2-shm-$repeat" env FERNWORK_A6_RENDER_ONLY=1 GDK_SCALE=2 WEBKIT_DMABUF_RENDERER_FORCE_SHM=1
  done
fi

python3 - "$output_dir" <<'PY'
import json
import pathlib
import sys
from PIL import Image, ImageChops, ImageStat

directory = pathlib.Path(sys.argv[1])
comparisons = []
for repeat in range(1, 4):
    default = json.loads((directory / f'default-{repeat}.json').read_text())
    shm = json.loads((directory / f'shm-{repeat}.json').read_text())
    for surface in ('window', 'canvas'):
        for scene in ('zoom', 'brush'):
            first_path = pathlib.Path(default['rendering']['captures'][surface][scene])
            second_path = pathlib.Path(shm['rendering']['captures'][surface][scene])
            with Image.open(first_path).convert('RGBA') as first, Image.open(second_path).convert('RGBA') as second:
                entry = {'repeat': repeat, 'surface': surface, 'scene': scene,
                         'default': str(first_path), 'shm': str(second_path),
                         'defaultSize': first.size, 'shmSize': second.size}
                if first.size == second.size:
                    difference = ImageChops.difference(first, second)
                    entry['maximumChannelDifference'] = max(high for _low, high in difference.getextrema())
                    entry['meanChannelDifference'] = sum(ImageStat.Stat(difference).mean) / 4
                    entry['differentBounds'] = difference.convert('RGB').getbbox()
                    entry['defaultChannelExtrema'] = first.getextrema()
                    entry['shmChannelExtrema'] = second.getextrema()
                    entry['defaultIsBlack'] = max(high for _low, high in first.getextrema()[:3]) == 0
                    entry['shmIsBlack'] = max(high for _low, high in second.getextrema()[:3]) == 0
                comparisons.append(entry)
    for surface in ('window', 'canvas'):
        zoom = Image.open(default['rendering']['captures'][surface]['zoom']).convert('RGB')
        brush = Image.open(default['rendering']['captures'][surface]['brush']).convert('RGB')
        comparisons.append({'repeat': repeat, 'surface': surface, 'scene': 'stale-check',
                            'zoomEqualsBrush': ImageChops.difference(zoom, brush).getbbox() is None})
        zoom.close(); brush.close()
(directory / 'visual-comparison.json').write_text(json.dumps(comparisons, indent=2) + '\n')
PY

echo "$output_dir"
