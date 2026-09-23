#!/bin/sh
set -eu

# Verbatim ONNX mirror of the Apache-2.0 U²-Netp weights, pinned to an immutable revision.
url='https://huggingface.co/edgetools/u2netp/resolve/25dee37ab19c5b6ad64ba6578eba63f1ae07720c/u2netp.onnx'
expected='309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8'
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
target="$script_dir/../public/models/u2netp.onnx"
temporary=$(mktemp "${TMPDIR:-/tmp}/u2netp.XXXXXX")
trap 'rm -f "$temporary"' EXIT HUP INT TERM

curl --fail --location --retry 3 --output "$temporary" "$url"
actual=$(sha256sum "$temporary" | awk '{print $1}')
if [ "$actual" != "$expected" ]; then
  echo "u2netp.onnx checksum mismatch: expected $expected, got $actual" >&2
  exit 1
fi
mkdir -p "$(dirname -- "$target")"
install -m 0644 "$temporary" "$target"
echo "Installed $target ($actual)"
