#!/usr/bin/env bash
set -euo pipefail

# Unpacks the WebKitGTK/GTK development packages Tauri needs into a user-owned prefix (no sudo). The prefix is
# shared with the Fernwork compositor workspace, which is why it keeps the fernwork-tauri-deps name.

if [[ "$(dpkg --print-architecture)" != "amd64" ]]; then
  echo "This local-prefix bootstrap is pinned to Ubuntu 24.04 amd64." >&2
  exit 1
fi

tauri_prefix="${BERGWORK_TAURI_PREFIX:-${FERNWORK_TAURI_PREFIX:-${XDG_CACHE_HOME:-$HOME/.cache}/fernwork-tauri-deps}}"
download_dir="$tauri_prefix/debs"
mkdir -p "$download_dir" "$tauri_prefix"

roots=(
  libwebkit2gtk-4.1-dev
  libgtk-3-dev
  libayatana-appindicator3-dev
  librsvg2-dev
  libxdo-dev
  patchelf
)

# apt-get download does not resolve dependencies. Resolve the development-package closure with
# apt-cache, retain already-installed headers from /usr, and unpack only missing packages locally.
mapfile -t candidates < <(
  apt-cache depends --recurse --no-recommends --no-suggests --no-conflicts --no-breaks \
    --no-replaces --no-enhances "${roots[@]}" 2>/dev/null \
    | sed -n 's/^  Depends: //p' | sed 's/:any$//' \
    | grep -Ev '^<|:i386$' | grep -E -- '-dev$' | sort -u
)

packages=("${roots[@]}")
for package in "${candidates[@]}"; do
  if dpkg-query -W -f='${db:Status-Status}' "$package" 2>/dev/null | grep -qx installed; then
    continue
  fi
  if apt-cache show "$package" 2>/dev/null | grep -q '^Filename:'; then
    packages+=("$package")
  fi
done
mapfile -t packages < <(printf '%s\n' "${packages[@]}" | sort -u)

pushd "$download_dir" >/dev/null
for package in "${packages[@]}"; do
  if ! compgen -G "${package}_*.deb" >/dev/null; then
    apt-get download "$package"
  fi
done
popd >/dev/null

for archive in "$download_dir"/*.deb; do
  dpkg-deb -x "$archive" "$tauri_prefix"
done

# Development packages contain relative libfoo.so -> libfoo.so.N links while the versioned runtime
# object is already installed in /usr. Make broken links explicitly target that runtime object.
while IFS= read -r -d '' link; do
  target="$(readlink "$link")"
  system_target="/usr/lib/x86_64-linux-gnu/$target"
  if [[ ! -e "$link" && -e "$system_target" ]]; then
    ln -sfn "$system_target" "$link"
  fi
done < <(find "$tauri_prefix/usr/lib/x86_64-linux-gnu" -maxdepth 1 -type l -name '*.so' -print0)

# Debian .pc files use /usr as their prefix. Point only the extracted copies at the local tree;
# dependencies which were already installed continue to resolve from the system pkg-config path.
while IFS= read -r -d '' pc; do
  sed -i "s|^prefix=/usr$|prefix=$tauri_prefix/usr|" "$pc"
  sed -i "s|^libdir=/usr|libdir=$tauri_prefix/usr|;s|^includedir=/usr|includedir=$tauri_prefix/usr|" "$pc"
done < <(find "$tauri_prefix/usr" -name '*.pc' -type f -print0)

{
  echo "# package version architecture"
  for archive in "$download_dir"/*.deb; do
    printf '%s %s %s\n' "$(dpkg-deb -f "$archive" Package)" "$(dpkg-deb -f "$archive" Version)" "$(dpkg-deb -f "$archive" Architecture)"
  done | sort -u
} > "$tauri_prefix/manifest.txt"

echo "Local Tauri development prefix: $tauri_prefix"
cat "$tauri_prefix/manifest.txt"
