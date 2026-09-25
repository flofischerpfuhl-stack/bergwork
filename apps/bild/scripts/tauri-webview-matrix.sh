#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_dir"
source scripts/tauri-env.sh

binary="src-tauri/target/release/fernwork-bildeditor"
result="${1:-/tmp/fernwork-webkitgtk-matrix.json}"
if [[ ! -x "$binary" ]]; then
  echo "Build the measurement binary first with VITE_FERNWORK_MEASUREMENT=1 npm run tauri:build -- --features measurement --no-bundle" >&2
  exit 1
fi

result_base="${result%.json}"
load_log="$result_base.load.log"

wait_for_idle() {
  local polls=0 load
  while true; do
    uptime | tee -a "$load_log" >&2
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

run_once() {
  local output="$1" pid
  rm -f "$output"
  wait_for_idle
  FERNWORK_WEBVIEW_MATRIX=1 FERNWORK_MATRIX_RESULT="$output" "$binary" &
  pid=$!
  for _ in $(seq 1 900); do
    if [[ -s "$output" ]]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      return
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" || true
      echo "The Tauri measurement process exited before writing $output" >&2
      exit 1
    fi
    sleep 1
  done
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  echo "Tauri measurement timed out" >&2
  exit 1
}

for repeat in 1 2 3; do
  run_once "$result_base.run-$repeat.json"
done
cp "$result_base.run-3.json" "$result"
cat "$result"
