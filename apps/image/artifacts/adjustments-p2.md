# P2 adjustment/filter engine report

## Implemented surface

The engine model, CPU compositor, WebGL compositor, project v2 persistence and PSD reader now support:

- `Basic`, `Colour Lookup`, `Colour`, `Invert`, `Threshold`, `Posterize`, `Brightness/Contrast`, `Photo Filter`, and `Channel Mixer` live adjustment layers in addition to the six existing kinds.
- `.cube` 1D, 3D, and combined 1D+3D files (`parseCubeLut`), sizes 2…65, `DOMAIN_MIN`/`DOMAIN_MAX`, CPU trilinear/tetrahedral sampling, packed GPU LUT textures, and original LUT bytes stored as a document resource with role `lut`.
- One typed Colour adjustment containing independently enabled Black & White and Color Balance sections plus Selective Color ranges.
- Live per-layer Gaussian blur, motion blur, noise, lens correction, unsharp mask, basic smart sharpen, high pass, and luminance/chroma denoise. The immutable filter array is ordered, enableable, cacheable, reorderable and bakeable.
- Destructive sharpen/denoise menu commands route through the same kernels as live filters.
- Brush modes `dodge`, `burn`, and `sponge`; Dodge/Burn support shadows/midtones/highlights and exposure, Sponge supports saturate/desaturate, flow and vibrance. Recorded GPU geometry and worker/CPU replay use the same immutable settings and deterministic formulas.
- PSD adjustment import for levels, curves, hue/saturation, exposure, vibrance, brightness/contrast, black & white, color balance, selective color, invert, threshold, posterize, gradient map endpoints, photo filter, channel mixer, and `.cube` color lookup when ag-psd exposes the bytes.

Important exported APIs include:

```ts
parseCubeLut(source: string | Uint8Array): CubeLut
lookupCube(lut: CubeLut, r: number, g: number, b: number,
  interpolation?: 'trilinear' | 'tetrahedral'): [number, number, number]
installCubeLut(document: CanvasDocument, source: string | Uint8Array,
  resourceId?: string): InstalledCube
addColourLookupAdjustment(session: EditorSession, source: string | Uint8Array,
  interpolation?: 'trilinear' | 'tetrahedral'): string | null

basicColor(r: number, g: number, b: number, settings: BasicSettings): [number, number, number]
colourPanelColor(r: number, g: number, b: number, settings: ColourSettings): [number, number, number]
applyAdjustment(adjustment: LayerAdjustment, rgba: Float32Array, width: number, height: number,
  originX: number, originY: number, resources?: readonly DocumentResource[]): Float32Array

unsharpMask(raster: Raster, amount: number, radius: number, threshold?: number): Raster
smartSharpen(raster: Raster, amount: number, radius: number, threshold: number, reduceNoise: number): Raster
highPass(raster: Raster, radius: number): Raster
denoise(raster: Raster, luminanceStrength: number, colourStrength: number): Raster
applyLiveFilter(raster: Raster, filter: LiveFilter): Raster
applyLiveFilters(raster: Raster, filters: readonly LiveFilter[]): Raster
defaultLiveFilter(kind: LiveFilterKind): LiveFilter
bakeLiveFilters(session: EditorSession, layerId: string): boolean

brushModeColor(r: number, g: number, b: number, settings: BrushSettings,
  coverage: number): [number, number, number]
```

`EditorSession` also exposes add/update/remove/move/begin-live-edit/end-live-edit/apply commands for layer filter stacks. Existing generic adjustment-layer live editing works for all new adjustment union members.

## Files changed

- Adjustment/model contracts: `contracts-v2.ts`, `src/core/model/types.ts`, `src/core/adjustments.ts`, `src/core/document.ts`, `src/core/composite.ts`, `src/core/adjust/{apply,basic,colour,cube,index,raster,resources,commands}.ts`.
- Shared filter engine and live stack: `src/core/filters/{apply,blur,index,live,settings,sharpen}.ts` and the minimal adjustment/filter command additions in `src/core/session.ts`.
- Brush modes: `src/core/brush/{commands,settings,stroke}.ts`; GPU uniforms/formulas in `src/render/{gpuCompositor,shaders}.ts`.
- Rendering and persistence/import: `src/render/{adjustPrograms,liveFilterPasses,softwareCompositor}.ts`, `src/io/project.ts`, and the adjustment-only portion of `src/io/psd/reader.ts`.
- Verification/report: `tests/unit/{adjust-p2,filters-p2,brush-mode-p2}.test.ts`, `tests/e2e/{adjust-p2,adjust-performance}.spec.ts`, and this report.

Shared-file touches were limited to the integration seams required by this lane: `src/core/adjustments.ts` for defaults/validation, `src/core/document.ts` for the complete adjustment-kind registry, and `src/core/composite.ts` for passing document LUT resources to the adjustment applier. `src/core/session.ts` only gained adjustment/filter commands. No UI files were edited.

## Basic formulas

Adobe’s Lightroom Process Version math is proprietary. The implementation therefore uses published Lightroom-style approximations, explicitly rather than claiming binary Adobe compatibility:

1. Decode sRGB, multiply exposure by `2 ** stops`, apply temperature/tint RGB multipliers, then encode sRGB.
2. Highlights and shadows are smooth luminance masks `L²` and `(1-L)²`; whites and blacks use fourth-power endpoint masks.
3. Contrast is a bounded midpoint S-curve. Clarity and texture are lower-strength midpoint presence curves. Basic dehaze moves luminance away from white with a bounded coefficient.
4. Saturation scales distance from Rec.709 luminance. Vibrance additionally falls with existing chroma and reduces the red-dominant skin response.

All sliders except exposure are `-100…100`; exposure is `-5…5` stops. A completely neutral Basic adjustment returns its input exactly. CPU evaluation is float. The GPU uses a cached 65³ float LUT and tetrahedral sampling; the Chromium reference test bounds output to one RGBA8 code value.

## Upstream behavior retained

Existing behavior continues to follow:

- `Compositor/Document/LayerAdjustment.swift` and `ImageAdjustments.swift` for adjustment-layer state and existing adjustment behavior.
- `Compositor/Document/Filters.swift`, `Rendering/NoisePixels.c`, and `Rendering/LensPixels.c` for existing destructive filter semantics.
- `Compositor/Document/BrushStroke.swift` and `Rendering/MetalBrushCoverage.swift` for continuous coverage, replaceable tail geometry, immutable raster publication and exact replay.

The Phase-2 kinds have no upstream implementation and follow PRODUCT-PLAN P5/6.3/6.4/M12 instead.

## Verification performed

- `tests/unit/adjust-p2.test.ts`: Basic reference values; 1D/3D cube parsing/domain/interpolation; resource lookup; Colour sections; invert/threshold/posterize; RGBA16 precision; v2 resource/filter round-trip; synthetic ag-psd adjustment mapping.
- `tests/unit/filters-p2.test.ts`: unsharp threshold; high-pass neutral/edge values; luminance/chroma denoise; RGBA16 output; live-stack ordering/cache/undo/reorder/bake.
- `tests/unit/brush-mode-p2.test.ts`: tonal-range Dodge/Burn, Sponge chroma, deterministic stroke replay and alpha preservation.
- `tests/e2e/adjust-p2.spec.ts`: Basic/LUT/Colour CPU↔GPU agreement within one byte; live unsharp renders identically through the GPU and software compositors without modifying stored pixels; Dodge/Burn/Sponge previews are within one byte of CPU replay and worker commits are byte-identical.
- `tests/e2e/adjust-performance.spec.ts`: 4096² layer, live unsharp, Basic + LUT + Colour, 1024×768 warm viewport. ANGLE Intel HD Graphics 630: median 0.5 ms, p95 10.6 ms, max 14.5 ms (40 measured frames after compile/upload/filter warm-up); target p95 ≤16 ms passed.

Final command results:

```text
npx tsc --noEmit -p .
exit code 0

npx vitest run tests/unit/adjust-p2.test.ts tests/unit/filters-p2.test.ts tests/unit/brush-mode-p2.test.ts
Test Files  3 passed (3)
Tests       16 passed (16)

npx vitest run tests/unit
Test Files  1 failed | 57 passed (58)
Tests       1 failed | 466 passed (467)

npx vitest run tests/unit/tiff.test.ts
Test Files  1 passed (1)
Tests       17 passed (17)

PLAYWRIGHT_BROWSERS_PATH=... E2E_PORT=5781 npx playwright test --project=chromium --output=/tmp/pw-out-p2adj
1 skipped
80 passed (20.8m)

PLAYWRIGHT_BROWSERS_PATH=... E2E_PORT=5781 npx playwright test tests/e2e/adjust-p2.spec.ts --project=chromium
3 passed (40.7s)

PLAYWRIGHT_BROWSERS_PATH=... E2E_PORT=5781 npx playwright test tests/e2e/adjust-performance.spec.ts --project=perf-gpu
1 passed (35.3s)

npm run psd:fidelity
Test Files  1 passed | 1 skipped (2)
Tests       4 passed | 1 skipped (5)
```

The required unqualified unit command is not clean: the unrelated pre-existing 4000×3000 TIFF LZW benchmark exceeds its own 30-second test override when the complete 58-file suite is active. It logged 12.1 seconds for decoding, but fixture generation plus decoding took 51.3 seconds. That same unchanged TIFF file passed all 17 tests in isolation in 28.81 seconds. No TIFF-owned source or test was changed for this lane.

## Deviations and open items

- Texture and clarity use point-local presence curves, not Adobe’s proprietary multiscale local-frequency implementation. Smart Sharpen is the requested basic variant: optional denoise followed by unsharp mask; it has no motion/lens blur deconvolution.
- Selective Color and Color Balance use documented Photoshop-style tonal/CMYK formulations, but exact Adobe rounding and internal color-space behavior are proprietary. Gradient-map PSD import currently maps endpoint colors; intermediate PSD stops are not representable by the existing two-color Gradient Map model.
- Live filters are evaluated by the shared format-generic CPU kernel once per immutable raster/filter-stack pair, cached, and then uploaded/composited by either renderer. This guarantees compositor parity and the measured warm-frame budget, but the first frame of a large changed stack pays CPU kernel cost; native separable GPU blur/sharpen passes remain future work.
- Live blur/sharpen results currently keep the source raster extent during non-destructive rendering, so pixels that would extend beyond a layer's original bounds are clipped. Baking uses the destructive kernel's expansion path. Carrying an expanded raster, transform, and attached mask together through both compositor hook sets remains open.
- RGBA8 and RGBA16 rasters retain native output depth. Float adjustment/compositing kernels operate on `Float32Array`; the document model intentionally has no persistent float raster format (PRODUCT-PLAN A3 excludes 32-bit HDR).
- The licensed PSD oracle corpus (`tests/fixtures/psd/corpus`) is absent in this worktree. `npm run psd:fidelity` completed with four infrastructure tests passed and the corpus-dependent test skipped; synthetic ag-psd mapping tests pass, but no honest before/after `adjustments`-folder fidelity number can be reported here. Existing unsupported parser warnings and non-RGB/ICC limitations remain.
- No UI was implemented. Tilt-shift/field blur and PSD writing remain outside P2-ADJ.
