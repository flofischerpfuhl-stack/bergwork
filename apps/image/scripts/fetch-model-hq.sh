#!/bin/sh
set -eu

# Browser-clean 1024² ONNX export of the MIT BiRefNet_lite weights, pinned to an immutable revision.
url='https://huggingface.co/CoderViking/birefnet-lite-onnx/resolve/dc06453148f01ef4131f17e9b791345e32e8ee78/birefnet-lite-1024.onnx?download=true'
expected='50a57872cc739192446da2a934159f957c81af8b5a161dfda8e3daa51660ca67'
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
target=${1:-"$script_dir/../public/models/birefnet-lite-1024.onnx"}
temporary=$(mktemp "${TMPDIR:-/tmp}/birefnet-lite-1024.XXXXXX")
trap 'rm -f "$temporary"' EXIT HUP INT TERM

curl --fail --location --retry 3 --continue-at - --output "$temporary" "$url"
actual=$(sha256sum "$temporary" | awk '{print $1}')
if [ "$actual" != "$expected" ]; then
  echo "birefnet-lite-1024.onnx checksum mismatch: expected $expected, got $actual" >&2
  exit 1
fi
mkdir -p "$(dirname -- "$target")"
install -m 0644 "$temporary" "$target"
echo "Installed $target ($actual)"
