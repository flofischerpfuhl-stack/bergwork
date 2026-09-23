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
