# Local Remove and Upscale (Phase 3 GENAI)

Date: 2026-09-25. Product: Fernwork Bildeditor. Scope: PRODUCT-PLAN 6.3, 6.4, A6, E6 and M12.

## Delivered behavior

- **Edit › Remove…** is the single removal workflow. With the optional MI-GAN model cached it runs local ONNX
  inference; without it, the existing PatchMatch content-aware fill remains the fallback. There is no second remover.
  A document selection is the mask. Preview is shown in place, and Apply creates a transparent result patch on a new
  layer by default, preserving the source and committing one undo step.
- **Image › Upscale…** offers 2× and 4×, a 0–100 restoration/denoise-strength blend, and replaces the selected
  layer's raster while retaining its placed document size. This increases its pixel density and is one undo step.
- Both engines tile with overlap and raised-cosine feathering. Remove uses 512 px tiles/64 px overlap; Upscale uses
  512 px tiles/32 px overlap and composites in output space. The AI result is blended against an independent
  Lanczos-3 baseline according to strength. Partial MI-GAN edge tiles are edge-padded to its fixed 512×512 input and
  cropped after inference. Alpha is resized by Lanczos rather than inferred.
- Inputs are capped at 12 MP. The result must also fit the active profile's side and pixel limits. RGBA16 layers keep
  their format, although these model artifacts themselves infer at 8-bit precision.
- The Pro profile exposes the optional AI commands. Lite keeps the same Remove command with the built-in fallback.

## Engine/API surface

- `GENAI_MODELS`, `cachedGenAiModel(...)`, `downloadGenAiModel(...)` in `src/core/genai/models.ts`.
- `aiTiles(...)`, `tileWeight(...)`, extraction/accumulation/finalization helpers in `src/core/genai/tiling.ts`.
- `lanczosRgba(...)` and `blendRgba(...)` in `src/core/genai/resample.ts`.
- `ContentFillInference.run(...)` plugs a model into the existing content-fill state machine;
  `applyContentAwareFill(session, { newLayer: true })` commits a non-destructive patch.
- `GenAiClient.inpaint(...)`, `upscale(...)`, cancellation/progress, and worker timing in
  `src/workers/genAiClient.ts`; the worker prefers WebGPU and falls back to single-thread WASM.
- `genAiTiming(session)` exposes local measurement values to tests. It sends nothing off-device.

`contracts.ts` and `contracts-v2.ts` were not changed. The minimal shared-file changes were the optional transform
argument on `EditorSession.addPixelLayer`, command/menu wiring, strings, the About notice, and the test helper's
optional profile argument.

## Model and licence decision

No weights are bundled. All chosen URLs include immutable repository revisions and all bytes are SHA-256 pinned.

| Candidate | Code / weight evidence | Size and browser fit | Training-data note | Decision |
|---|---|---:|---|---|
| MI-GAN 512 Places2 pipeline | Official code MIT and an explicit, separate [MIT `LICENSE-WEIGHTS`](https://github.com/Picsart-AI-Research/MI-GAN/blob/main/LICENSE-WEIGHTS); official author publishes the ONNX pipeline and its export contract | 28,079,181 B; uint8 NCHW; ONNX Runtime Web works on WASM | Upstream says Places2/Places365. Places tooling/models are MIT, but source-image copyrights are not individually relicensed. This caveat does not override the checkpoint's explicit MIT grant. | **Chosen**: smallest candidate, explicit weight licence, official browser-ready pipeline |
| LaMa / big-lama | [Apache-2.0 repository](https://github.com/advimman/lama/blob/main/LICENSE), but the separately hosted big-lama checkpoint has no explicit checkpoint-specific grant/card | Roughly 200 MB class; conversion needed | Places Challenge images | Rejected: weight provenance less explicit than MI-GAN and much larger |
| FcF | Repository includes inherited NVIDIA files whose headers prohibit use without an express NVIDIA licence; see the [official source](https://github.com/SHI-Labs/FcF-Inpainting/blob/main/train.py) | Large PyTorch checkpoint; conversion needed | Places2 / CelebA-HQ | Rejected: code/weight chain is outside the allowed licence list |
| RealESRGAN_x2plus / x4plus | Official [BSD-3-Clause repository and checkpoints](https://github.com/xinntao/Real-ESRGAN); reproducible dynamic-NCHW ONNX exports with BSD model card | 67,156,218 B / 67,132,609 B | Official paper: DIV2K + Flickr2K + OST. Source-image rights are heterogeneous; no training images are redistributed. The released checkpoints have an unqualified BSD grant. | **Chosen**: official permissive checkpoints and simple tiled ONNX contract |
| SwinIR | [Official Apache-2.0 repository](https://github.com/JingyunLiang/SwinIR) includes checkpoints | Larger/slower transformer and no selected provenance-pinned browser export | DIV2K/Flickr2K/OST, plus other sets for real-world variants | Rejected: no advantage for this web integration and weaker ONNX artifact provenance |
| 4x-UltraSharp and similar community models | Common artifact is CC-BY-NC-SA-4.0; the [licence is explicitly non-commercial](https://openmodeldb.info/models/4x-UltraSharp) | Varies | Model card does not provide a permissive training-data chain | Rejected: non-commercial weights |

Exact selected revisions, sizes, hashes and notices are in `MODEL_LICENSES.md` and `THIRD_PARTY_NOTICES.md`.

## Download, offline and privacy behavior

- Opening a dialog performs only `ModelHost.resolveModel({ id, sha256, userInitiated: false })` with **no URL**. This
  can read verified cached bytes but cannot fetch remotely.
- Only **Download AI model** or **Download and Upscale** calls the URL-bearing path with `userInitiated: true`.
- Progress is byte-based; Cancel aborts the host download or worker job. Browser and Tauri hosts retain verified bytes,
  so subsequent use is offline. Chromium e2e switches the context offline and reads the cached 67,156,218-byte x2
  model successfully.
- No telemetry, account, cloud inference, credit system, prompt service, or implicit network request was added.

Local model tests look in `FERNWORK_GENAI_MODEL_DIR` (default `/tmp/fernwork-genai-models`) for:

- `migan_pipeline_v2.onnx`
- `RealESRGAN_x2plus.onnx`
- `RealESRGAN_x4plus.onnx`

They serve those bytes through Playwright routing, so tests never depend on the public network. Model-dependent cases
skip when the files are absent; command, fallback, no-request, progress and cancellation tests always run.

## Quality and performance measurements

All targets are generated independently of the measured implementation (M14 oracle rule). No model output generated
its own reference.

### Remove

- Generated 512×512 textured blue field, 48×36 red object, 56×44 removal mask: MI-GAN mean absolute RGB error to
  the known clean background was **2.7014 / 255**.
- Fixed 512 model/tile inference: **12,031.5 ms**, ONNX Runtime Web WASM. `uptime` immediately before the run:
  `load average: 28.28, 31.27, 29.49`; after: `28.94, 30.89, 29.52`.
- Existing fallback checks remain: the flat generated scene reconstructs every selected channel within 1/255; the
  striped generated scene matches **114/120** selected pixels. Full-selection/no-source is an explicit error.
- A 913×677 identity tiling test with 512 px tiles verifies complete coverage and **0 differing bytes** after feather
  assembly, including non-multiple dimensions and interior seams.

### Upscale vs independent Lanczos-3

Generated 64×48 high-frequency scene → independent Lanczos downsample to 32×24 → 2× reconstruction:

| Method | PSNR | SSIM |
|---|---:|---:|
| Lanczos-3 | **21.6776 dB** | **0.840875** |
| RealESRGAN_x2plus, 75% strength | 18.1549 dB | 0.636511 |

Real-ESRGAN is worse on this synthetic high-frequency case. That is an important limitation, not a pass hidden by an
AI label; users can set strength to 0% for exact Lanczos output.

- x2 model inference for the 32×24 input: **3,069.5 ms**, WASM, on the final offline-cache rerun. An earlier
  measurement was 4,270.2 ms; its run began at load average `22.45, 26.62, 27.08` and ended at
  `36.56, 29.76, 28.12`.
- x4 model produced exactly 64×48 from 16×12; inference **2,212.4 ms**, WASM; load average before
  `35.99, 30.83, 28.60`, after `32.26, 30.75, 28.71`.
- A Real-ESRGAN 512×512 tile was **not timed**: the default headless/Xvfb environment exposed only the WASM fallback,
  and the much smaller measured inputs already miss an interactive budget. A real-GPU Tauri measurement is prohibited
  on `DISPLAY=:99` by the task constraints. The 512 tiling path is pixel/seam-tested, but its real-GPU speed remains open.

## M12 denoise gap

Real-ESRGAN publishes `realesr-general-x4v3` plus `realesr-general-wdn-x4v3` under its BSD repository and mixes the
two for adjustable denoise. I did **not** enable **Filter › Reduce Noise (AI)**: there is no selected, reproducible,
provenance-pinned ONNX pair for these exact official weights, and substituting the x2/x4 hallucination model would be
misleading. The menu item is present but disabled; the existing deterministic Reduce Noise filter remains available.
Producing and validating that ONNX pair is open work.

## Verification

Focused results:

- TypeScript: clean.
- GenAI + content-fill unit: **2 files, 12 passed** (including fixed-size model padding/cropping).
- Chromium command/policy e2e: **2 passed**; optional MI-GAN, x2 and x4 model cases passed separately.
- Firefox + WebKit command/policy e2e: **4 passed**.

Final gates (unchanged timeouts and assertions):

- `npx tsc --noEmit -p .`: **passed**, no diagnostics.
- `npx vitest run tests/unit`: **78 files passed, 3 failed; 660 tests passed, 3 failed (663); 152.17 s**. All three
  failures were timeouts in existing heavy tests, not assertion mismatches: brush accumulation (20 s), 4000²→8000²
  Lanczos benchmark (120 s; measured 146,675.3 ms), and 4000×3000 TIFF (30 s; measured decode 22,671.1 ms).
- The required 4000×3000 TIFF benchmark was then selected alone without increasing its timeout. At load average
  `41.82, 39.41, 34.07` it again timed out: **1 failed, 16 skipped; 54.32 s**, while its measured decode phase
  completed in **12,233.2 ms**. Load after the run was `41.01, 39.85, 34.57`.
- Complete Chromium was started once with its private port/output directory and all local model fixtures. Sustained
  host contention caused three unrelated legacy UI timeouts (Curves mouse movement and two artboard interactions) at
  their unchanged 90/120 s caps. After three consecutive infrastructure-pattern failures the run was stopped:
  **19 passed, 2 skipped, 3 failed, 316 did not run; 18.6 min**. Load at start was
  `38.77, 39.41, 34.49`. This is an attempted, not a passing, whole-suite gate.

The new command/policy tests and all three optional real-model cases passed independently; Firefox/WebKit exercised
the model-download UI policy tests only, as intended by the model-test Chromium guard.

## Deviations and open work

- Upscale outputs a resized layer raster, not a new document. This is one of the two allowed product outcomes and keeps
  project/tab creation out of an image-processing transaction.
- AI Reduce Noise is deliberately not enabled; see M12 above.
- Real-GPU/WebGPU timing, especially the requested 512×512 Real-ESRGAN tile, remains open.
- The model worker currently runs one inference at a time and cannot interrupt an ONNX `session.run` mid-kernel;
  cancellation is immediate at the client and discards the eventual worker result.
- Training-source image rights are not equivalent to checkpoint licences. The explicit MIT/BSD checkpoint grants are
  recorded, along with the source-data caveats, for legal review before distribution.
