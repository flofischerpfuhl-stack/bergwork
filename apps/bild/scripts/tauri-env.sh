#!/usr/bin/env bash

tauri_prefix="${FERNWORK_TAURI_PREFIX:-${XDG_CACHE_HOME:-$HOME/.cache}/fernwork-tauri-deps}"
tauri_lib="$tauri_prefix/usr/lib/x86_64-linux-gnu"

export PATH="$HOME/.cargo/bin:$tauri_prefix/usr/bin:$PATH"
export PKG_CONFIG_PATH="$tauri_lib/pkgconfig:$tauri_prefix/usr/share/pkgconfig:${PKG_CONFIG_PATH:-}"
export LIBRARY_PATH="$tauri_lib:${LIBRARY_PATH:-}"
export LD_LIBRARY_PATH="$tauri_lib:${LD_LIBRARY_PATH:-}"
export C_INCLUDE_PATH="$tauri_prefix/usr/include:${C_INCLUDE_PATH:-}"
export CPLUS_INCLUDE_PATH="$tauri_prefix/usr/include:${CPLUS_INCLUDE_PATH:-}"
