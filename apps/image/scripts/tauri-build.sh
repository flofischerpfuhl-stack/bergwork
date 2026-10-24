#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_dir"

if [[ "$(uname -s)" == Linux ]]; then
  source scripts/tauri-env.sh
  if ! pkg-config --exists webkit2gtk-4.1 gtk+-3.0 ayatana-appindicator3-0.1; then
    bash scripts/tauri-install-linux-deps.sh
    source scripts/tauri-env.sh
  fi
fi

exec node node_modules/@tauri-apps/cli/tauri.js build "$@"
