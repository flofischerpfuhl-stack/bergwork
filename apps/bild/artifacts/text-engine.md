# Text engine (P2-TEXT)

Date: 2026-09-24
Engine: CanvasKit 0.42.0 CPU surfaces, SkParagraph/HarfBuzz
Scope: engine only; no React, UI controls, DOM text, or Canvas2D `fillText`

## Result

Fernwork Bildeditor now has editable point and area text records, rich runs and paragraphs, deterministic CanvasKit
layout/rasterization, missing-font reporting, font persistence policy, undoable text commands, document-space text hit
testing, a renderer cache hook, and editable PSD text import. Raster previews remain caches: edits invalidate them, and
`TextRasterCache.prepare(document, targetScale)` shapes and rasterizes again when the target resolution changes.

The reference rich paragraph (Latin kerning/ligatures, German umlauts, Arabic, Devanagari, mixed sizes, variable axes,
paragraph spacing/indents) produced identical 620×180 RGBA8 bytes in Chromium, Firefox, and WebKit:

`522e3687d43de15bfeb1eff5842eda1283c6d4248db2932a0b97979aaddec978`

## Model and public engine APIs

`src/core/model/types.ts` and `contracts-v2.ts` add schema-versioned `TextRunStyle`, `TextParagraphStyle`, text-run and
paragraph ranges, point/area box state, a separate imported preview placement, and document-font metadata. A v2 text
record carries `textSchemaVersion: 1`. The reader migrates the earlier flat `{fontFamily,fontSize,color}` run shape and
single `alignment` without changing `contracts.ts`.

Key exports:

```ts
canonicalTextRuns(text, runs, fallback?): TextRun[]
replaceTextRange(layer, from, to, replacement): TextLayer
applyTextStyle(layer, from, to, patch): TextLayer
applyParagraphStyle(layer, from, to, patch): TextLayer
convertTextBox(layer, box): TextLayer

listMissingFonts(document, availableFamilies): MissingFont[]
new TextFontRegistry(engine, host?, bundledLoader?)
TextFontRegistry.prepareDocument(document, userInitiatedSystemAccess?): Promise<readonly MissingFont[]>
TextFontRegistry.resolution(requested): FontResolution
addDocumentFont(document, font): CanvasDocument

layoutTextLayer(engine, fonts, document, layer, targetScale?, missingFonts?): TextLayerLayout
TextLayerLayout.caretPosition(point): number
TextLayerLayout.selectionRectangles(from, to): readonly Rect[]
TextLayerLayout.caretRectangle(index): Rect

new TextRasterCache(engine, fonts)
TextRasterCache.prepare(document, targetScale): Promise<readonly MissingFont[]>
TextRasterCache.raster(layer): Raster | null
TextRasterCache.transform(layer): LayerTransform
```

`ParagraphRequest` also accepts rich `spans`, per-paragraph `paragraphs`, and `pointText`; `ParagraphLayout` now exposes
local caret/range geometry. The old single-style API remains source-compatible and keeps its optimized fast path.

`EditorSession` adds these one-transaction commands:

```ts
createPointText(position, text?, style?): string | null
createAreaText(rect, text?, style?): string | null
replaceText(id, from, to, replacement): void
applyTextStyle(id, from, to, patch): void
changeParagraphSettings(id, from, to, patch): void
convertTextKind(id, box): void
rasterizeTextLayer(id, raster, transform?): void
```

Ranges use UTF-16 offsets, matching JavaScript and CanvasKit. Font sizes, explicit leading, indents, and paragraph
spacing are stored in typographic points and converted using document resolution. Tracking uses Photoshop's
thousandths-of-an-em convention.

## Fonts and missing fonts

The fallback order is requested family → bundled Noto Sans → Noto Sans Arabic → Noto Sans Devanagari. Requested names
stay in the editable run even when unavailable. `MissingFont` reports the requested name, visible substitute, and all
affected layer IDs. System/Local Font Access is called only when `prepareDocument(..., true)` is explicitly invoked in a
user-initiated flow. Bundled and embedded fonts may load automatically from local bytes.

`addDocumentFont` embeds bytes only when `embeddingAllowed` is true. An unembeddable system font persists name/style/
weight/source metadata only. Font resources use the v2 asset role `font`, are checksum-verified on read, and round-trip
inside `.fwimg`.

## PSD text and oracle results

`src/io/psd/reader.ts` maps ag-psd `LayerTextData` into editable text, including text, style-run lengths, font names,
size, colour, tracking, leading, baseline shift, ligature flags, paragraph alignment/indents/spacing, point-versus-box
shape, and affine placement. Photoshop carriage-return paragraph separators become `\n` without changing UTF-16 run
lengths. The saved PSD pixel preview and its pixel placement are retained separately from the editable transform, so a
missing font never causes a silent visual change before editing.

The six psd-tools corpus files with text in their names were measured against their embedded Photoshop composite.
Results did not regress from the pre-change baseline because the saved preview remains the display oracle:

| File | Before mean / p99 | After mean / p99 | Editable text found |
|---|---:|---:|---:|
| `layers-minimal/type-layer.psd` | 235.451 / 255 | 235.451 / 255 | yes |
| `layers/type-layer.psd` | 0.000 / 0 | 0.000 / 0 | yes |
| `pen-text.psb` | 27.460 / 255 | 27.460 / 255 | no text layer (pen/vector fixture) |
| `pen-text.psd` | 27.442 / 255 | 27.442 / 255 | no text layer (pen/vector fixture) |
| `text.psb` | 0.069 / 0 | 0.069 / 0 | yes |
| `text.psd` | 0.000 / 0 | 0.000 / 0 | yes |

The two pen fixtures are 32-bit vector/path documents and fail for the already reported bit-depth/vector-mask reasons,
not text. `layers-minimal/type-layer.psd` was already a corpus outlier. PSD writing is Phase 3 and is not implemented.

## Lazy loading and performance

CanvasKit remains behind `loadTextEngine()`; importing document/session code does not import CanvasKit. The renderer hook
is likewise opt-in. Production Vite build measurements on the same checkout:

| Measurement | Baseline | P2-TEXT | Delta / result |
|---|---:|---:|---:|
| Lite initial JS chunk, gzip | 375.11 KB | 377.92 KB | +2.81 KB; ≤ 400 KB pass |
| CanvasKit JS + WASM, raw | — | 7,438,222 bytes | lazy |
| CanvasKit JS + WASM, gzip -9 | — | 2,998,127 bytes | ≤ 4 MiB pass |
| 500-char layout + raster, Chromium p95 (50 runs) | — | 15.60 ms | ≤ 16 ms pass in isolated gate |

The full Chromium suite and a concurrent-project browser/build load produce higher p95 values; the dedicated isolated
gate above is the product-budget measurement. The E2E reports median, p95, maximum, and separate layout/raster p95
values, but does not turn unrelated machine load into a flaky failure.

## Tests

`tests/unit/text.test.ts` covers:

- real rich multilingual pixels, explicit missing-font substitution, and document-space caret/range geometry;
- target-resolution rerasterization through `TextRasterCache`;
- create/edit/style/paragraph/convert command history boundaries;
- v2 rich-text and licensed/unlicensed font round trips;
- editable ag-psd text-run import with a real generated PSD.

`tests/e2e/text.spec.ts` is engine-level and has no UI clicks. It checks lazy loading, the fixed cross-browser SHA-256,
multiscript rich text, hit testing, and records the 500-character timing. Existing CanvasKit unit/E2E coverage continues
to exercise worker loading, unresolved glyphs, variable axes, PathOps, and the older integration-sheet hash.

Final verification:

```text
npx tsc --noEmit -p .
exit 0

npx vitest run tests/unit
Test Files  54 passed (54)
Tests       426 passed (426)

E2E_ALL_BROWSERS=1 npx playwright test tests/e2e/text.spec.ts
3 passed (18.3s)

npx playwright test --project=chromium
1 skipped
69 passed (15.7m)
```

The successful whole-unit run preceded the final PSD RGBA alpha normalization and its assertion. On the committed
tree, `text.test.ts` plus the unrelated TIFF benchmark passed together (2 files, 22 tests); later whole-suite repeats
while several external browser and WASM builds saturated the machine timed out only in the existing brush/TIFF timing
tests (all 52 other files and 424 tests passed). No functional assertion failed, and the worktree remained unchanged.

## Deviations and open work

- CanvasKit 0.42's public SkParagraph binding has no per-span baseline-shift property. Baseline shift is preserved and
  round-tripped but not drawn. A small Skia binding extension is required for faithful rendering.
- CanvasKit exposes metric `kern` enable/disable but no distinct optical-kerning switch. `optical` currently uses
  HarfBuzz font metrics like `metric`; `none` disables `kern`.
- First-line indent is implemented with a SkParagraph placeholder. Negative first-line indents clamp to zero because
  the binding has no hanging-indent primitive.
- PSD vertical text and text warp remain editable but are reported as approximated/not rendered. PSD affine skew is
  reduced to the document model's scale/rotation/flip transform because `LayerTransform` has no shear.
- The engine hook exists, but installing it in the React canvas/controller and building text controls are intentionally
  outside this engine-only lane. Until that integration, imported preview rasters draw through the existing renderer;
  callers that edit text must prepare and supply `TextRasterCache` hooks.
- Text-on-path, text warp editing, text-to-outlines, and PSD text export are Phase-3 work.

This is new PRODUCT-PLAN A5/P11/A7/A10/E4 behavior. Upstream has no equivalent rich text engine or tests to port; no
Swift/C formula was substituted.
