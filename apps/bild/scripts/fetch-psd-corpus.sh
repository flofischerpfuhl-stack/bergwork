#!/usr/bin/env bash
set -euo pipefail

# psd-tools is the licensed primary PSD oracle selected in PRODUCT-PLAN A7/E5.
readonly REPOSITORY='https://github.com/psd-tools/psd-tools.git'
readonly COMMIT='30bf79c2a88e0fc63104ee85713e23b04362153d'
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
readonly DEST_DIR="$ROOT_DIR/tests/fixtures/psd"
readonly WORK_DIR="$(mktemp -d /tmp/fernwork-psd-corpus.XXXXXX)"
trap 'rm -rf -- "$WORK_DIR"' EXIT

git clone --filter=blob:none --no-checkout "$REPOSITORY" "$WORK_DIR/repository"
git -C "$WORK_DIR/repository" sparse-checkout init --cone
git -C "$WORK_DIR/repository" sparse-checkout set tests/psd_files LICENSE
git -C "$WORK_DIR/repository" checkout --detach "$COMMIT"

mkdir -p "$WORK_DIR/corpus"
while IFS= read -r -d '' source; do
  relative="${source#"$WORK_DIR/repository/tests/psd_files/"}"
  case "/$relative/" in
    */third-party-psds/*|*/issues/*) continue ;;
  esac
  case "$relative" in
    *.psd|*.PSD|*.psb|*.PSB) ;;
    *) continue ;;
  esac
  mkdir -p "$WORK_DIR/corpus/$(dirname -- "$relative")"
  cp -- "$source" "$WORK_DIR/corpus/$relative"
done < <(find "$WORK_DIR/repository/tests/psd_files" -type f -print0)

mkdir -p "$DEST_DIR"
rm -rf -- "$DEST_DIR/corpus"
mv -- "$WORK_DIR/corpus" "$DEST_DIR/corpus"
(
  cd -- "$DEST_DIR"
  find corpus -type f \( -iname '*.psd' -o -iname '*.psb' \) -print0 \
    | LC_ALL=C sort -z | xargs -0 sha256sum > SHA256SUMS
)

count="$(wc -l < "$DEST_DIR/SHA256SUMS")"
printf 'Fetched %s PSD/PSB files from psd-tools %s\n' "$count" "$COMMIT"
printf 'SHA-256 manifest: %s\n' "$DEST_DIR/SHA256SUMS"
