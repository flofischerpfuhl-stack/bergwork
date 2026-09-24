# Third-party notices

## CanvasKit / Skia

The optional text and vector engine uses `canvaskit-wasm` 0.42.0, built from
Skia and distributed by Google under the BSD 3-Clause License. It is loaded
only when the text/vector engine is requested. The exact npm artifact is pinned
in `package-lock.json` with integrity
`sha512-N3ikotmzYwDVAcpQKDMptBT2P5pIEWS9ywdmrQA2awwaMF9cxKEFuxZZHv9ay1Em9kDjxDsPtwUzDm1uNj136g==`.
Source and license: https://github.com/google/skia/tree/main/modules/canvaskit and
`node_modules/canvaskit-wasm/LICENSE` after installation.

The package includes `@webgpu/types` 0.1.21, also under the BSD 3-Clause
License. It supplies TypeScript declarations only and is not runtime code.

## Bundled Noto Sans fonts

The variable fonts in `public/fonts` are from the Google Fonts Noto families,
copyright The Noto Project Authors, and are distributed under the SIL Open Font
License 1.1. The complete license is in `public/fonts/OFL.txt`.

- `NotoSans-Variable.ttf`, Google Fonts commit
  `2984c575fdce412ee02b2baaba67672b9a9434d8`, SHA-256
  `bfb7bb691513f12e734dc346c03a03f784912432d7e3fa8e56efcf906fe86b3d`
- `NotoSansArabic-Variable.ttf`, Google Fonts commit
  `e5ee31305efa101c2cae65f44d9642df2c8f0b4d`, SHA-256
  `63111b5b2e074dd48cc67692e0a2726d86ee94c1c37fe8598257b7b4e87e869e`
- `NotoSansDevanagari-Variable.ttf`, Google Fonts commit
  `2bc5d431b584d89e646214bf6cfa75494e76ceea`, SHA-256
  `14ec4af41f27482216d1c2229f417ff9b1425e1babb014e57d1d40d03229853e`

## ag-psd

PSD parsing for the offline import/fidelity spike uses `ag-psd` 31.0.2,
copyright (c) 2016 Agamnentzar, under the MIT License. Source and license:
https://github.com/Agamnentzar/ag-psd

The ag-psd license explicitly excludes image and brush files in its repository.
No such files, including ag-psd's test PSDs, are used or redistributed here.

## psd-tools fidelity fixtures

The optional PSD fidelity corpus fetched by `scripts/fetch-psd-corpus.sh` comes
from psd-tools commit `30bf79c2a88e0fc63104ee85713e23b04362153d`,
copyright (c) 2019 Kota Yamaguchi, under the MIT License. The downloaded files
are git-ignored and remain outside the application bundle. Fixture provenance,
checksums, and deliberate exclusions are recorded in
`tests/fixtures/psd/SOURCES.md` and `tests/fixtures/psd/SHA256SUMS`.

## Tauri CLI (development only)

The desktop build uses `@tauri-apps/cli` 2.11.5, copyright the Tauri
Programme within The Commons Conservancy. It is distributed under the Apache
License 2.0 or MIT License and is not included in the application runtime.
Source and licence: https://github.com/tauri-apps/tauri

## Tauri desktop runtime and official plugins

The desktop application uses Tauri 2.11.6, `tauri-plugin-fs` 2.5.2, and
`tauri-plugin-dialog` 2.7.3. Copyright the Tauri Programme within The Commons
Conservancy. They are distributed under the Apache License 2.0 or MIT License.
Sources and licences: https://github.com/tauri-apps/tauri and
https://github.com/tauri-apps/plugins-workspace

## Compositor C rendering kernels

The files in `src/wasm/c` are copied verbatim from Compositor at commit
`a19db9011282399785dc18efcfded904627bdcc2`:

- `AdjustPixels.c` / `.h`
- `BrushPixels.c` / `.h`
- `ContentFill.c` / `.h`
- `HealPixels.c` / `.h`
- `LensPixels.c` / `.h`
- `LevelsPixels.c` / `.h`
- `NoisePixels.c` / `.h`
- `WandPixels.c` / `.h`

Copyright (c) 2026 Wonder Assembly LLC. These files are provided under the MIT
License; the complete license text is reproduced in `src/wasm/c/LICENSE`.

## U²-Netp model weights

`public/models/u2netp.onnx` contains the portable U²-Net salient-object model
by Xuebin Qin, Zichen Zhang, Chenyang Huang, Masood Dehghan, Osmar R. Zaiane,
and Martin Jagersand. The original model and weights are Apache-2.0 licensed.
The ONNX file is the rembg release asset mirrored verbatim by
`edgetools/u2netp`. Full provenance, the pinned checksum, and the license text
are in `MODEL_LICENSES.md`.

## ONNX Runtime Web

Browser inference uses `onnxruntime-web` 1.30.0, copyright Microsoft
Corporation, under the MIT License. Source and license:
https://github.com/microsoft/onnxruntime

## Little CMS

ICC color conversion uses Little CMS 2.19.1, copyright (c) 2023 Marti Maria
Saguer, under the MIT License. The official release archive and its SHA-256 are
pinned in `scripts/build-lcms.sh`.

MIT License

Copyright (c) 2023 Marti Maria Saguer

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## libjpeg-turbo

Four-component and ICC-tagged JPEG decoding uses the libjpeg API library from
libjpeg-turbo 3.1.2. This software is based in part on the work of the
Independent JPEG Group. libjpeg-turbo is distributed under the IJG License,
Modified 3-Clause BSD License, and zlib License. The generated WebAssembly,
exact source release and checksum, build command, and complete applicable
license notices are documented in `src/wasm/jpeg/README.md`,
`src/wasm/jpeg/LICENSE.md`, and `src/wasm/jpeg/README.ijg`.

## Optional HEIC decoder (not loaded by default)

The separately replaceable files `src/wasm/heif/libheif.mjs` and
`src/wasm/heif/libheif.wasm` contain:

- libheif 1.23.5, copyright Struktur AG and contributors, LGPL-3.0-or-later.
  Source: https://github.com/strukturag/libheif/releases/tag/v1.23.5
  (`libheif-1.23.5.tar.gz`, SHA-256
  `fd9036064c4432f0550d15072ddf34956a248279ee9aeaff0fba3fa0f77d8f1a`).
- libde265 1.1.1, copyright Struktur AG and contributors, LGPL-3.0-or-later.
  Source: https://github.com/strukturag/libde265/releases/tag/v1.1.1
  (`libde265-1.1.1.tar.gz`, SHA-256
  `fd48a927e94ed74fc7ce8829d222b9d8599fcbfe8b6448ba66705babc56ab219`).

The complete LGPL-3.0 and incorporated GPL-3.0 texts are in
`src/wasm/heif/LICENSE.LGPL-3.0.txt` and `src/wasm/heif/LICENSE.GPL-3.0.txt`. The
corresponding source can be obtained from the release links above and rebuilt
with `scripts/build-heif-wasm.sh` and the pinned Emscripten toolchain recorded
in `toolchain.json`. The generated JS and WASM are kept separate from the
application and can be replaced with a modified/relinked build. They are
fetched only after a host explicitly opts in with `heicDecoder: 'lgpl-wasm'`.

HEVC/H.265 is covered by patents in a number of jurisdictions. The LGPL
licences for libheif and libde265 do not grant patent licences; distributors
are responsible for assessing any patent-licensing obligations.

The test file `tests/e2e/heic-quadrants.heic` was generated for this project
from an original 64×64 red/green image using Ubuntu libheif 1.17.6 and x265
3.5 (`heif-enc --quality 95`). It contains no third-party artwork. Its SHA-256
is `b496c28c0bb1b99dce93e4c40ac0c5aa506732c9e0c656af8e103b2a91474208`.

## WebP codec

WebP encoding and deterministic decoding of ICC-tagged WebP use libwebp
1.6.0, copyright Google LLC, under the BSD 3-Clause License. The official
release archive, SHA-256, generated WASM checksum, and complete license are
recorded in `src/wasm/webp/README.md` and `src/wasm/webp/LICENSE`. The module is
loaded only when its codec path is requested.

## AVIF codec

AVIF encoding and deterministic decoding of ICC-tagged AVIF use libavif 1.3.0
(BSD 2-Clause), dav1d 1.5.1 (BSD 2-Clause), libaom 3.12.1 (BSD 2-Clause), and
libavif's pinned libyuv conversion subset (BSD 3-Clause). Exact archive and
WASM checksums and the complete applicable license terms are in
`src/wasm/avif/README.md` and `src/wasm/avif/LICENSE`. The 3.8 MiB module is a
separate lazy chunk and is not part of application startup.

## BiRefNet_lite model weights

The optional best-quality subject model is BiRefNet_lite by Peng Zheng,
Dehong Gao, Deng-Ping Fan, Li Liu, Jorma Laaksonen, Wanli Ouyang, and Nicu
Sebe. The official weights and implementation are MIT licensed. The browser
artifact is a reproducible static ONNX repackaging of those weights and is
downloaded on first use rather than shipped in this repository. Full immutable
provenance, checksums, rationale, and the license text are in
`MODEL_LICENSES.md` and `public/models/birefnet-lite.LICENSE.txt`.

## Tauri host support crates

The desktop host uses `tauri-plugin-single-instance` 2.4.5 (MIT or Apache-2.0)
to route second-instance file-open events, `sha2` 0.10 (MIT or Apache-2.0) for
native checksum/model-cache verification, and `windows-sys` 0.61 (MIT or
Apache-2.0) for the Windows `GetICMProfileW` display-profile call. Exact
transitive versions are pinned in `src-tauri/Cargo.lock`.
