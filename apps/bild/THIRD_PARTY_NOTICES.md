# Third-party notices

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

## BiRefNet_lite model weights

The optional best-quality subject model is BiRefNet_lite by Peng Zheng,
Dehong Gao, Deng-Ping Fan, Li Liu, Jorma Laaksonen, Wanli Ouyang, and Nicu
Sebe. The official weights and implementation are MIT licensed. The browser
artifact is a reproducible static ONNX repackaging of those weights and is
downloaded on first use rather than shipped in this repository. Full immutable
provenance, checksums, rationale, and the license text are in
`MODEL_LICENSES.md` and `public/models/birefnet-lite.LICENSE.txt`.
