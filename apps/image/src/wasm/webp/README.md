# libwebp WASM codec

`webp.mjs` and `webp.wasm` contain libwebp 1.6.0, built with the repository's
pinned Emscripten 6.0.10 from the official release archive
<https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.6.0.tar.gz>
(SHA-256
`e4ab7009bf0629fd11982d4c2aa83964cf244cffba7347ecd39019a9e38c4564`).
Only the static codec and demux libraries are linked (`-O3 -msimd128`, no
threads, tools, examples, or shared libraries). The codec is loaded through a
dynamic import after WebP decoding or encoding is requested.

libwebp is copyright Google LLC and distributed under the BSD 3-Clause
License. The complete license is in `LICENSE`.

The generated `webp.wasm` SHA-256 is
`2a4dbeffb18d6d947076f4bd0f1770e51a5ac6f3e01dcfb1eede61c93d96b93f`.
