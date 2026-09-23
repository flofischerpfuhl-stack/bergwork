# Model licenses and provenance

## U²-Netp

- Purpose: general salient-object / foreground segmentation.
- Original project and weights: https://github.com/xuebinqin/U-2-Net
- Browser-ready artifact: https://huggingface.co/edgetools/u2netp/tree/25dee37ab19c5b6ad64ba6578eba63f1ae07720c
- File: `public/models/u2netp.onnx`
- Size: 4,574,861 bytes (4.36 MiB).
- SHA-256: `309c8469258dda742793dce0ebea8e6dd393174f89934733ecc8b14c76f4ddd8`.
- License: Apache License 2.0. The original repository identifies the project
  and downloadable `u2netp.pth` weights under this license. The model-card
  mirror identifies the ONNX file as a byte-for-byte copy of the MIT-licensed
  rembg release artifact.
- Conversion: no local conversion. The exact ONNX release artifact (opset 11)
  is redistributed verbatim. `scripts/fetch-model.sh` reproducibly downloads
  the immutable revision and verifies its digest.

U²-Netp was selected because it handles general subjects, is permissively
licensed, and is small enough for local browser inference. Full U²-Net and
IS-Net general-use are around 176 MB; MODNet is specialized for portraits;
BiRefNet lite is provided separately as the opt-in Best model below. BRIA RMBG
was excluded because its weights do not have a suitable permissive commercial
license.

### Apache License

Copyright 2020 Xuebin Qin and U²-Net contributors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

The complete Apache License 2.0 text distributed by the original project is
included beside the model as `public/models/u2netp.LICENSE.txt` and is also
available at https://github.com/xuebinqin/U-2-Net/blob/master/LICENSE.

## BiRefNet_lite 1024

- Purpose: best-quality general dichotomous segmentation, including fine edges.
- Architecture and official source: https://github.com/ZhengPeng7/BiRefNet
- Official source weights: `ZhengPeng7/BiRefNet_lite/model.safetensors` at
  immutable revision `7838f1c3472f827cd8ce13ab5ccc2ce48077360f` (177,634,392
  bytes; SHA-256 `4417d89795250e698c3cb0ae8df15743810065f646f48a694fdfa7ca052d0815`).
- Browser ONNX export: `CoderViking/birefnet-lite-onnx` at immutable revision
  `dc06453148f01ef4131f17e9b791345e32e8ee78`.
- Runtime file: `birefnet-lite-1024.onnx`, 199,681,624 bytes; it is downloaded
  on first use and is not committed to this repository.
- Pinned URL:
  `https://huggingface.co/CoderViking/birefnet-lite-onnx/resolve/dc06453148f01ef4131f17e9b791345e32e8ee78/birefnet-lite-1024.onnx?download=true`.
- SHA-256: `50a57872cc739192446da2a934159f957c81af8b5a161dfda8e3daa51660ca67`.
- Tensor contract: float32 NCHW RGB, ImageNet normalization, fixed 1024×1024
  input; float32 1024×1024 logits output, followed by sigmoid.
- License: MIT. The official model repository describes itself as the official
  tiny-version weights, links to the MIT-licensed BiRefNet project, and the ONNX
  artifact's model card declares MIT and identifies the exact source-weight
  digest above. Commercial use is permitted by MIT. The exact upstream MIT text
  is included as `public/models/birefnet-lite.LICENSE.txt`.

The fp32 static export is intentional. The smaller community fp16 export uses a
dynamic deformable-convolution decomposition that is documented to fall back
from ONNX Runtime Web WebGPU and exhaust the 32-bit WASM heap at 1024². The
selected export replaces that operation with a validated static GridSample
decomposition and is published as working on both WebGPU and WASM. The export
card reports maximum post-sigmoid deviation of 1.3e-9 from the official PyTorch
model. `scripts/fetch-model-hq.sh` downloads and verifies the pinned artifact
for local tests or self-hosting.

### MIT License

Copyright (c) 2024 ZhengPeng. The complete license is in
`public/models/birefnet-lite.LICENSE.txt` and at
https://github.com/ZhengPeng7/BiRefNet/blob/main/LICENSE.
