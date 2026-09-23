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
