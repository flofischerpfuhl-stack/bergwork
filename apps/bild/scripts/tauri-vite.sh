#!/usr/bin/env bash
set -euo pipefail

mode="${1:-}"
case "$mode" in
  dev)
    exec node node_modules/vite/bin/vite.js --config src-tauri/frontend/vite.config.ts
    ;;
  build)
    exec node node_modules/vite/bin/vite.js build --config src-tauri/frontend/vite.config.ts
    ;;
  *)
    echo "usage: $0 dev|build" >&2
    exit 2
    ;;
esac
