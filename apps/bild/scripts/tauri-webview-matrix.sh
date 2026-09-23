#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_dir"
source scripts/tauri-env.sh

binary="src-tauri/target/release/fernwork-bildeditor"
result="${1:-/tmp/fernwork-webkitgtk-matrix.json}"
if [[ ! -x "$binary" ]]; then
  echo "Build the binary first with npm run tauri:build -- --no-bundle" >&2
  exit 1
fi

FERNWORK_WEBVIEW_MATRIX=1 FERNWORK_MATRIX_RESULT="$result" "$binary" &
pid=$!
for _ in $(seq 1 900); do
  if [[ -s "$result" ]]; then
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    cat "$result"
    exit 0
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    wait "$pid" || true
    echo "The Tauri measurement process exited before writing $result" >&2
    exit 1
  fi
  sleep 1
done
kill "$pid" 2>/dev/null || true
wait "$pid" 2>/dev/null || true
echo "Tauri measurement timed out" >&2
exit 1
