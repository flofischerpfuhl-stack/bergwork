#!/usr/bin/env bash
# Linux entry for `npm run tauri:dev`: sets up the rootless WebKitGTK environment, then runs the Tauri CLI.
set -euo pipefail

app_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$app_dir"

if [[ "$(uname -s)" == Linux ]]; then
  source scripts/tauri-env.sh
  if ! pkg-config --exists webkit2gtk-4.1 gtk+-3.0 ayatana-appindicator3-0.1; then
    bash scripts/tauri-install-linux-deps.sh
    source scripts/tauri-env.sh
  fi
fi

exec node "${TAURI_CLI_JS:?set by scripts/tauri.mjs}" dev "$@"
