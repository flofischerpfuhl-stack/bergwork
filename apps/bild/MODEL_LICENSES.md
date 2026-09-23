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
BiRefNet lite is higher quality but substantially larger and its browser WASM
path has much higher memory requirements. BRIA RMBG was excluded because its
weights do not have a suitable permissive commercial license.

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
