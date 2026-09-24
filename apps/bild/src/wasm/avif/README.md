# AVIF WASM codec

`avif.mjs` and `avif.wasm` contain libavif 1.3.0 with dav1d 1.5.1 for
decoding and libaom 3.12.1 for encoding, built with the repository's pinned
Emscripten 6.0.10. The pinned source archives are:

- libavif 1.3.0: <https://github.com/AOMediaCodec/libavif/archive/refs/tags/v1.3.0.tar.gz>,
  SHA-256 `0a545e953cc049bf5bcf4ee467306a2f113a75110edf59e61248873101cd26c1`
- dav1d 1.5.1: <https://code.videolan.org/videolan/dav1d/-/archive/1.5.1/dav1d-1.5.1.tar.gz>,
  SHA-256 `fa635e2bdb25147b1384007c83e15de44c589582bb3b9a53fc1579cb9d74b695`
- libaom 3.12.1: SHA-256 `9388025e69af0fb4dfc73cbd544ed583bb5775dbddbd7b5aa9790ebbf94206be`
  for <https://aomedia.googlesource.com/aom/+archive/refs/tags/v3.12.1.tar.gz>
- libyuv conversion subset at commit `def473f501acbd652cd4593fd2a90a067e8c9f1a`,
  vendored in the pinned libavif archive.

All four projects use BSD-style licenses. Complete license texts are stored
beside the generated codec. The static build uses `-O3 -msimd128`, no threads,
tools, tests, examples, or shared libraries. The module is reached only through
dynamic imports.
The generated `avif.wasm` SHA-256 is
`4bc49567ec766cac67c3aa4a4148879e86cbe994a58ab08e6b1f8b6b592f138b`.
