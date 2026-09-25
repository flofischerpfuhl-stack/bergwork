#!/usr/bin/env bash
# Sourced by tauri-dev.sh and tauri-build.sh: points pkg-config, the linker and the loader at the rootless
# WebKitGTK prefix. BERGWORK_TAURI_PREFIX wins, then FERNWORK_TAURI_PREFIX, then the prefix the Fernwork
# compositor workspace already uses.

tauri_prefix="${BERGWORK_TAURI_PREFIX:-${FERNWORK_TAURI_PREFIX:-${XDG_CACHE_HOME:-$HOME/.cache}/fernwork-tauri-deps}}"
tauri_lib="$tauri_prefix/usr/lib/x86_64-linux-gnu"

export PATH="$HOME/.cargo/bin:$tauri_prefix/usr/bin:$PATH"
export PKG_CONFIG_PATH="$tauri_lib/pkgconfig:$tauri_prefix/usr/share/pkgconfig:${PKG_CONFIG_PATH:-}"
export LIBRARY_PATH="$tauri_lib:${LIBRARY_PATH:-}"
export LD_LIBRARY_PATH="$tauri_lib:${LD_LIBRARY_PATH:-}"
export C_INCLUDE_PATH="$tauri_prefix/usr/include:${C_INCLUDE_PATH:-}"
export CPLUS_INCLUDE_PATH="$tauri_prefix/usr/include:${CPLUS_INCLUDE_PATH:-}"
