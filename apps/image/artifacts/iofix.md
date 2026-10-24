# P2-IOFIX handoff

## Root causes and fixes

### History snapshots

`writeHistory` manually copied only a subset of the document manifest into each snapshot. In particular, it omitted guides, fonts, and resource membership. The live document therefore differed from the history cursor document and `readV2Archive` rejected otherwise valid files as a damaged `history cursor state`. Recovery used the same archive writer, so it failed for the same reason.

History snapshots now serialize every current `CanvasDocument` field: identity and dimensions, resolution, global light angle, layers, artboards, guides, resource references, fonts, and selection. Resource bytes remain deduplicated global ZIP assets; snapshots store resource IDs. Selection masks are stored as mask assets. The writer has a runtime supported-key guard, and the unit test compares the restored snapshot keys with a live document populated with every current field so a future populated field cannot disappear silently. Older snapshots that lack the newly written arrays inherit the live manifest values, which allows archives from the affected writer to open instead of failing cursor validation.

### Original image assets

Unedited rasters intentionally retain their original encoded bytes. Archive reopen previously sent all non-PNG assets through `browserDecode`, while import used the fuller `decodeImageFile` pipeline. That made TIFF unreadable and bypassed explicit ICC/gamma/CMYK conversion. PNG reopen also bypassed the managed import path.

`decodeImageAsset(bytes, remainingPixels, options)` is now the shared underlying import/project decoder. The controller supplies the document limit and host codec capability when opening an archive. Non-PNG images and colour-managed PNGs therefore use exactly the import path, including Little CMS conversion, TIFF decoding, CMYK JPEG conversion, HEIC host/WASM capability, and one EXIF orientation application. Canonical PNG/PNG16 and mask assets retain the existing internal fast path and native bit depth.

Decision: retain original encoded assets and decode them faithfully on reopen instead of replacing every such asset with PNG. This avoids potentially large project-file growth and preserves the original compressed source. It remains compatible with archives written by the affected code because their original TIFF/JPEG/managed-PNG bytes now enter the shared decoder. As in upstream `ImageImporter.decode`, output is normalized to sRGB; the browser port uses its explicit Little CMS/browser/host equivalents rather than Core Image/ImageIO.

## Files and exported API

- `src/io/imageImport.ts`
  - `decodeImageAsset(bytes: Uint8Array, remainingPixels: number, options?: ImageDecodeOptions): Promise<DecodedImageAsset>`
  - `pngNeedsColorConversion(bytes: Uint8Array): boolean`
  - `DecodedImageAsset` carries RGBA pixels, 8/16-bit depth, dimensions, and detected MIME.
- `src/io/project.ts`
  - Local history-document serialization/parsing for all document-level fields.
  - `ImageDecoder` now accepts `Uint8Array | Uint16Array` and optional `bitDepth`.
  - Image assets requiring conversion use the supplied shared decoder; ordinary PNG and masks keep the internal path.
- `src/ui/controller.ts`
  - Archive decoder wiring only: `decodeImageAsset(..., MAX_PIXELS, { host: capabilities.codecs })`.
- `tests/unit/project-iofix.test.ts`
  - Full document-field/history round trip, including exact resource membership and selection pixels.
  - Retained original TIFF bytes reopen through the import decoder with identical pixels.
- `tests/e2e/qa-fwimg.spec.ts`, `tests/e2e/qa-guides.spec.ts`
  - Removed the four fixed known-failure markers without changing assertions.

No dependency or third-party notice changes were needed. `contracts.ts` and `contracts-v2.ts` were not edited.

## Upstream reference

- `Compositor/IO/ImageImporter.swift`, `ImageImporter.decode`: supported-format probing, limits, EXIF orientation, and sRGB conversion.
- `Compositor/IO/ProjectStore.swift`, `ProjectStore.save/readPackage`: validated asset persistence and project reopen behavior. Upstream canonicalizes project images to PNG; this port deliberately retains source encodings for file size while reproducing the import conversion on reopen.
- `CompositorTests/ImageImportTests.swift`, `supportedFormats`, `orientationAndColorConversion`, `limitsAndInvalidFiles`.
- `CompositorTests/ProjectTests.swift`, `projectRoundTripSurvivesSourceRemovalAndPackageMove`.

## Verification

- `npx tsc --noEmit -p .`
  - clean (no output)
- `npx vitest run tests/unit`
  - `Test Files  67 passed (67)`
  - `Tests  524 passed (524)`
  - `Duration  23.40s`
- Chromium task QA (`qa-fwimg`, `qa-guides`)
  - `57 passed (9.0m)` on the initial focused run; the final-code full Chromium run re-exercised and passed all of these cases.
- Firefox + WebKit task QA on final code
  - `114 passed (5.1m)`
- Full Chromium E2E on final code
  - `283 passed`, `1 skipped`, `2 failed (18.8m)` out of 286.
  - The two failures are outside this lane and reproduce when run alone:
    - `tests/e2e/heic.spec.ts:38`: decoded/oriented HEIC pixels pass, but the performance-resource list has no URL containing the literal `libheif`.
    - `tests/e2e/text-tool.spec.ts:78`: the lazy resource assertion sees no URL containing `canvaskit` immediately after selecting the text tool; subsequent text rendering tests pass.
  - Isolated retry: `2 failed`; both failures are the same resource-name assertions.

## Deviations and open issues

- Apple Core Image/ImageIO is unavailable in workers/browsers. Existing explicit Little CMS, local TIFF/JPEG decoders, browser codecs, and optional host HEIC codec are the closest faithful equivalents.
- The full Chromium suite is not globally clean because of the two unrelated lazy-resource-observation failures above. No assertions were weakened and no out-of-scope HEIC/text files were changed.
- Existing known 16-bit colour-management quantization limitations remain outside this task; no new limitation was introduced.
