# Object selection and Refine Edge

## Outcome

The local promptable model is SlimSAM-77 Uniform FP16, split into an image encoder and prompt decoder. Model bytes are not bundled and are never requested at startup. A click on **Enable Object Select** calls `ModelHost.resolveModel` with `userInitiated: true`; the browser host persists verified bytes in Cache Storage and the Tauri host persists them in its application model cache. The worker receives only local blob URLs.

Object Point accepts positive points and additional positive points with Shift; Alt adds a negative point. Object Rectangle emits the model's two box prompt labels. The worker caches at most two embeddings by layer raster identity, tries WebGPU first, falls back to single-thread WASM, selects the highest predicted-IoU mask, removes model padding, and performs guided full-resolution edge upsampling.

## Model decision and licence evidence

Only code and weight licences allowed by the product plan were eligible. Sizes are the downloadable artifacts considered, not parameter-count estimates.

| Candidate | Weight/code licence evidence | Browser artifact size | Same-machine result | Decision |
| --- | --- | ---: | --- | --- |
| SlimSAM-77 Uniform FP16 | Apache-2.0 upstream; the conversion model card explicitly states that the weights retain that licence and gives a reproducible pinned conversion | 12,170,657-byte encoder + 8,550,118-byte decoder = 20,720,775 bytes | Chosen pair: 18.1–20.4 s encoder and 413–508 ms decoder in one-thread WASM | Chosen: smallest verified split, point/box prompts, cached embeddings |
| EfficientSAM-Ti | Apache-2.0 upstream repository and model card | 24,799,761-byte encoder + 16,565,728-byte decoder = 41,365,489 bytes | Direct probe: 27.7 s encoder; 570–830 ms decoder in one-thread WASM | Rejected: roughly twice the download and slower here |
| MobileSAM | Apache-2.0 repository; official checkpoint is 38.8 MB | 38.8 MB checkpoint; split ONNX publishing is community-dependent | Not run: no equally well-provenanced pinned official split selected | Rejected for artifact provenance and size |
| SAM 2.1 Hiera Tiny | Meta states code and checkpoints are Apache-2.0 | 156 MB official checkpoint before browser conversion | Not run: browser conversion is much larger than the selected pair | Rejected for download/memory budget |
| EdgeSAM | Official repository and weights use NTU S-Lab License 1.0 | approximately 38.8 MB split ONNX | Not run | Ineligible: licence is outside MIT/BSD/Apache/ISC/OFL/Zlib |

Evidence checked 2026-09-24:

- SlimSAM conversion/model card and exact hashes: https://huggingface.co/skillsafe-ai/slimsam-77-uniform-fp16
- SlimSAM upstream: https://github.com/czg1225/SlimSAM
- EfficientSAM repository/license: https://github.com/yformer/EfficientSAM
- EfficientSAM ONNX files: https://huggingface.co/yunyangx/EfficientSAM/tree/main
- MobileSAM official repository/checkpoint: https://github.com/ChaoningZhang/MobileSAM
- SAM 2 licence statement: https://github.com/facebookresearch/sam2
- SAM 2.1 Tiny official weight size: https://huggingface.co/facebook/sam2.1-hiera-tiny
- EdgeSAM licence and ONNX links: https://github.com/chongzhou96/EdgeSAM

Pinned manifest:

| Part | Revision | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `vision_encoder_fp16.onnx` | `f860d9a77028ebdafb86473e88b9c0eea67cd8fc` | 12,170,657 | `11aaeb49c75e7b3f4cbf8a32c2c819406520c6b3affb4068ff474b2240c8aa38` |
| `prompt_encoder_mask_decoder_fp16.onnx` | same | 8,550,118 | `df24d49a6f1a5dc0dbbecd84ca0fff9f14c76e63b81fd35c2b92c1321b007f71` |

## Measurements

Machine load was high as noted in the task. The direct ONNX Runtime Web WASM benchmark used one thread, a 1024×768 prepared image representing a 12-MP source (the production preprocessor bounds the long edge at 1024), one positive point, and five procedurally generated textured scenes. They are original generated fixtures; no copyrighted photos are committed.

| Scene | Encoder | Decoder | measured mask IoU |
| --- | ---: | ---: | ---: |
| red ellipse / blue textured background | 20,389 ms | 508 ms | 0.9900 |
| yellow ellipse / blue textured background | 19,827 ms | 453 ms | 0.9883 |
| cyan ellipse / blue textured background | 18,605 ms | 438 ms | 0.9876 |
| green ellipse / blue textured background | 18,697 ms | 413 ms | 0.9866 |
| violet ellipse / blue textured background | 18,118 ms | 452 ms | 0.9865 |

The generated-scene one-click acceptance threshold (IoU ≥ 0.9) passes. The `<100 ms` decoder target does **not** pass in single-thread WASM on this machine. Headless Chromium 153 reports no `navigator.gpu`, so a same-machine WebGPU timing could not be collected. The worker's WebGPU-first path is implemented, with WASM fallback. This remains an open performance issue rather than a claimed pass.

Refine Edge's 96×96 synthetic soft-circle/fur fixture improved mean absolute alpha error from 4.5278 to 2.9808 (34.17% reduction), passing the required ≥30% reduction.

## Verification

- `npx tsc --noEmit -p .`: clean.
- `npx vitest run tests/unit`: 73 test files passed; 586 tests passed; duration 26.80 s.
- Object-selection/refinement unit coverage: explicit-download/no-startup-fetch behavior, preprocessing and prompt encoding, best-mask selection, one-click generated-scene IoU, hair-alpha error reduction, refinement controls, colour decontamination, all four output modes, Quick Mask round-trip, and sampled/preset Colour Range.
- `npx playwright test --project=chromium --output=/tmp/pw-out-p2obj`: 308 passed, 4 pre-existing skips; duration 30.3 min. The two new object-selection E2E tests passed.
- `npx vite build`: passed, including both new worker bundles. Vite emitted only the repository's existing browser-externalization/chunk-size warnings.

## Exported engine API

### Object selection

- `resolveObjectSelectModels(host: ModelHost, progress?, signal?): Promise<ResolvedObjectSelectModels>`
- `prepareSlimSamImage(rgba, width, height, limit?): PreparedImage`
- `encodePrompts(prompts, scaleX, scaleY): { coordinates; labels }`
- `bestPromptMask(logits, scores, width, height): { mask; score }`
- `upscaleObjectMask(mask, maskWidth, maskHeight, rgba, width, height, radius?): Uint8Array`
- `selectObject(session, prompts, options): Promise<ObjectSelectResult | null>`
- `selectSubjectMask(session, mask, width, height, mode?): boolean` — adapter for existing BiRefNet/U²-Netp results
- `layerMaskSelection(mask, width, height, transform, documentWidth, documentHeight): DocumentSelection`
- `ObjectSelectClient.select(...)` and `objectSelectInference`

### Refine Edge, Quick Mask and Colour Range

- `refineEdge(rgba, width, height, inputMask, settings?): RefineEdgeResult`
- `normalizeRefineEdgeSettings(settings?): RefineEdgeSettings`
- `decontaminateColours(rgba, mask, width, height, amount): Uint8Array`
- `applyRefineEdgeResult(session, result, output): boolean`, where output is `selection | layerMask | newLayerWithMask | newLayer`
- `RefineEdgeClient.refine(...)` and `refineEdgeWorker`
- `quickMaskOverlay(selection, width, height, colour?): Uint8Array`
- `selectionMaskOnCanvas(selection, width, height): Uint8Array`
- `selectionFromQuickMask(mask, width, height): DocumentSelection`
- `commitQuickMask(session, mask): boolean`
- `colourRangeMask(rgba, width, height, settings): Uint8Array`
- `colourRangeSelection(...)` and `selectColourRange(...)`

`RefineEdgeSettings` provides radius, smart radius, smooth, feather, contrast, shift edge, colour decontamination amount, and an optional painted hair/fur region. The UI module exposes a compact Object Point/Object Rectangle mode, explicit model-enable button with progress/error/cancellation state, Q toggle, Refine Edge command hook, and Colour Range command hook. The full Refine Edge workspace is intentionally left to the integrator, as requested.

## Upstream reuse and deviations

- `Compositor/Document/SubjectRemoval.swift`, `SubjectRemoval.refined`: control ordering, shift-edge threshold behavior, contrast behavior, and the purpose of guided refinement.
- `Compositor/Document/GuidedMatte.swift`, `GuidedMatte.refine`: guided-filter edge matting and bounded preview strategy, through the existing TypeScript port.
- `Compositor/Document/LayerMask.swift`, `addMask(revealing:)`: layer-grid mask semantics and single undo transaction.
- `Compositor/Document/Selection.swift`: antialiased document selection semantics.

Object selection, Quick Mask, Colour Range, smart radius, hair-region painting, and decontamination are new product-plan work with no upstream implementation. The browser engine uses grayscale guided filtering rather than Apple's Core Image/Vision implementations. Feather uses a three-box Gaussian approximation. Hair/fur recomputation is guided-filter matting on the painted band rather than closed-form matting. Colour Range uses CIE Lab distance plus explicit skin-tone and midtone formulas; it is not pixel-identical to Photoshop.

## Open issues / not implemented

- WebGPU timing and the `<100 ms` prompt budget still need validation on a browser exposing a real GPU; WASM misses the budget.
- Tests cover five deterministic generated photo-like scenes rather than an external photographic corpus. This keeps all fixtures original and licence-clean but is not evidence for broad real-photo quality.
- The existing subject models can feed `selectSubjectMask`, but a new duplicate subject-inference UI button was not added; the existing Remove Background UI remains the user-facing BiRefNet/U²-Netp entry point.
- Refine Edge has engine/worker/output commands and compact hooks, not the large workspace UI reserved for integration.
