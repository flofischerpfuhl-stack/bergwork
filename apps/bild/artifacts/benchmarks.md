# Core-task benchmark status

Observed 2026-09-24 against the Phase 0 browser UI. The suite is intentionally red where PRODUCT-PLAN.md §7.2 capabilities have not landed. “Automated” below means the listed actions went through the real UI and were followed by pixel or manifest assertions.

| # | Core task | Steps automated and asserted | First missing capability | Current status |
|---:|---|---|---|---|
| 1 | Product photo / social formats | Create canvas; import a generated product image; select and clear its flat background; assert transparent background and preserved product pixels. | Editable drop shadow / layer effects, before three format-specific exports. | Red — expected missing capability |
| 2 | Campaign key visual | Create 16:9 canvas; import color field and photo through File → Import Images; assert ordered layer structure. | Text layers for the headline, before SVG placement, four artboards, and WebP export. | Red — expected missing capability |
| 3 | YouTube thumbnail | Import generated person fixture; remove flat background with Magic Wand; assert transparent and retained pixels. | Editable outline/glow effects. | Red — expected missing capability |
| 4 | Smart Object mockup | Mount editor; open File menu; verify the project-open action is available. | PSD/PSB import, before Smart Object replacement. | Red — expected missing capability |
| 5 | Editable client PSD | Mount editor; open File menu; verify the project-open action is available. | PSD/PSB import, before text editing and PSD write-back. | Red — expected missing capability |
| 6 | Portrait retouch | Import generated blemished portrait; paint with Spot Healing; poll exported pixels until the blemish is replaced. | Dodge/burn tool for eyes. | Red — expected missing capability |
| 7 | Sky replacement | Create canvas; import generated landscape; assert imported layer structure. | Object Selection UI, before edge refinement and adjustment-layer color matching. | Red — expected missing capability |
| 8 | Object removal | Import generated photo; marquee the object; run Content-Aware Fill; assert replacement pixels and unchanged layer structure. | None for the content-aware route specified by the task. | **Green** |
| 9 | Banner set | Import banner photo; draw a real vector shape; assert shape-layer structure. | Artboards and per-artboard resizing for five formats. | Red — expected missing capability |
| 10 | Vector icon | Draw vector rectangle; assert shape layer and opaque exported center pixel. | Boolean operations between shape layers. | Red — expected missing capability |
| 11 | Print / soft-proof | Generate an Adobe RGB ICC-tagged TIFF locally; import it through the UI; assert dimensions, alpha, and that exported sRGB pixels differ from unconverted source values. | CMYK soft-proof controls, before CMYK TIFF export. | Red — expected missing capability |
| 12 | RAW workflow | Mount editor; open File menu; verify image import is available. | RAW/DNG decoding in the Tauri import path. | Red — expected missing capability |
| 13 | 200 MP poster | Create a 20,000 × 10,000 canvas; assert the 200 MP manifest and initial layer. | Pro scratch-backed stress path for safely populating/editing 30 full-size layers. | Red — expected missing capability |
| 14 | Batch recipe | Import first series image; apply Levels through the dialog; assert brighter exported pixels. | Recordable recipes and a 50-image application/export queue. | Red — expected missing capability |
| 15 | Typo poster | Create poster canvas; verify no text tool is exposed. | Editable text layers, variable fonts, and OpenType ligatures. | Red — expected missing capability |
| 16 | Packaging mockup | Import package face; assert its centered layer transform. | Mesh-warp controls. | Red — expected missing capability |
| 17 | Upscale / denoise | Import generated old-photo texture; resize 40 × 40 to 80 × 80 through Image Size; assert resulting dimensions. | Denoise filter. | Red — expected missing capability |
| 18 | Screenshot instructions | Import generated screenshot; apply Gaussian Blur; assert softened boundary pixels. | Arrow and outline-only frame annotation primitives. | Red — expected missing capability |
| 19 | Raster logo | Import generated logo; remove flat background with Magic Wand; assert transparency and retained logo pixels. | Editable contour/stroke for raster artwork. | Red — expected missing capability |
| 20 | Crash recovery | Create and edit project; wait for IndexedDB recovery copy; remount; accept recovery; assert restored layers; verify Undo is disabled. | Persisted undo history after recovery. | Red — expected missing capability |

## Last benchmark run

Command:

```sh
PLAYWRIGHT_BROWSERS_PATH=/home/oem/.local/share/fernwork-compositor-lab/browser-cache E2E_PORT=5381 E2E_BENCHMARKS=1 npx playwright test --project=benchmarks
```

Observed summary:

```text
19 failed
1 passed
```

All 19 expected failures must end at `benchmark-helpers.ts:missing`. A failure earlier in a scenario is a regression, not an accepted red result.
