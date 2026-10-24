# Non-destructive crop (CROP)

Date: 2026-09-25

## Delivered

- The Crop context bar has `Delete Cropped Pixels`, off by default. With it off, `cropDocument` changes the canvas
  dimensions and layer/mask/warp placements while retaining every source raster. A later larger crop restores those
  pixels. With it on, `CropOptions.deletePixels` permanently clears source samples outside the resulting canvas.
- Image > Reveal All (`revealAllDocument`) grows and translates the canvas to the integral union of uncropped source
  layer bounds. Crop and Reveal All are each one history command.
- A selected artboard is the crop target. `cropArtboard` changes that artboard's rectangle without resizing the
  document or moving its layers; destructive mode clears only member-layer pixels. The command is one undo step.
- Layer > Crop to Selection stores `{rect, feather}` on an embedded layer in source-raster pixel coordinates.
  Layer > Clear Crop removes it. Both commands respect effective layer locks and are independently undoable.
- `layerCropCoverage` is shared by CPU compositing and layer-effect alpha generation. WebGL layer and mesh-warp
  shaders implement the same hard-edge/linear-feather formula. The Canvas2D shortcut declines cropped layers so its
  exact CPU path is used.
- Format-v2 write/read retains the parameter, validates its finite bounds and feather, and allows it to be replaced
  after reopen. `docs/format-v2.md` now states the coordinate convention.
- Required German UI: `Ausgeschnittene Pixel löschen`, `Alles einblenden`, `Auf Auswahl zuschneiden`, and
  `Zuschnitt entfernen`.

Public/internal APIs added or extended:

- `CropOptions.deletePixels`
- `clearLayerPixelsOutsideRect`, `layerSourceBounds`, `revealAllDocument`, `layerCropFromDocumentRect`
- `cropArtboard`
- `layerCropCoverage`
- `cropTargetRects` (UI-owned target provider; selected artboards register here without introducing a core-to-UI import)
- `EditorSession.cropEmbeddedLayerToSelection` and `clearEmbeddedLayerCrop`

## Decisions

- Layer crop rectangles are source-pixel-local, not document-space. This keeps the crop stable while the embedded
  layer is moved, scaled, rotated, warped, saved, and reopened.
- Reveal All intentionally ignores the live layer crop and uses source bounds; otherwise it could not reveal pixels
  hidden by an earlier document crop.
- Destructive document crop runs in the existing operations worker. The default preserved crop shares immutable
  rasters and therefore does not duplicate large pixel buffers.
- Straighten was not duplicated in the Crop tool. The WARP lane's existing Image > Straighten implementation remains
  available, which satisfies the task's optional integration without a second workflow.

## PSD bridge

PSD has no portable equivalent of Fernwork's editable per-layer crop parameter. There is currently no product PSD
writer in this integration (`src/io/psd` is read-only). TODO for the future PSD writer: rasterize the layer's cropped
appearance, omit the Fernwork crop parameter, and add an export notice that the editable crop was rasterized. It must
not silently write the uncropped source or claim an editable PSD round trip.

## Verification

- `npx tsc --noEmit -p .`: clean (no output).
- `npx vitest run tests/unit --maxWorkers=2`: 87 files passed, 743 tests passed. Duration 53.95 s at uptime/load
  `up 5:32; 7.65, 8.42, 11.36`.
- Focused unit set (crop, canvas ops, format v2, effects, software renderer): 5 files passed, 41 tests passed.
- Chromium focused/directly affected E2E, one worker: 14 passed. This covered the new crop spec plus
  `editor-workflows`, `effects`, and `gpu-chunks`.
- Crop E2E: a 4x1 red/green/blue/yellow source exported as 2x1 green/blue after crop, then returned byte-exactly to
  all four source pixels after the larger preserved crop. The active-artboard case kept the document at 4x1 while
  changing the artboard from 4x1 to 2x1.
- Per-layer crop WebGL2 versus CPU: maximum asserted channel difference <= 1/255, including feathered edges.

The Playwright runs used browser cache `/home/oem/.local/share/fernwork-compositor-lab/browser-cache`, port 6093,
one worker, and output `/tmp/pw-out-crop`. No real-GPU/Tauri measurement was made under the invisible Xvfb display;
the WebGL2 comparison is the headless Chromium renderer. No dependency or licence notice changed.
