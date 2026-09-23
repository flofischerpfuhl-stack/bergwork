# PSD fidelity corpus provenance

The files under `corpus/` are fetched from
[psd-tools](https://github.com/psd-tools/psd-tools), pinned to commit
`30bf79c2a88e0fc63104ee85713e23b04362153d` (commit dated 2026-09-20;
selected 2026-09-23).
They are test fixtures only and are not included in the application bundle or committed to this
repository. Run `scripts/fetch-psd-corpus.sh` to reproduce them and `SHA256SUMS` to verify them.

psd-tools and its test files are distributed under the MIT License, copyright (c) 2019 Kota
Yamaguchi. The upstream license is at
<https://github.com/psd-tools/psd-tools/blob/30bf79c2a88e0fc63104ee85713e23b04362153d/LICENSE>.

The fetch deliberately excludes every `third-party-psds/` and `issues/` directory because the
origin or redistribution terms of files in those directories are not sufficiently established.
Only `.psd` and `.psb` files are copied. No image or brush fixture from the ag-psd repository is
used.
