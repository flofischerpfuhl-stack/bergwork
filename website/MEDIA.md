# Media shot list

Missing files are deliberately omitted from the built pages. The build prints one warning per missing slot.

Screenshots are **2560 × 1600 PNG** captured from a **1280 × 800 window at 2×**. Videos are **1920 × 1080 H.264 MP4**, no more than **30 seconds** and **8 MB**, with a PNG poster frame. Use only redistributable/public fixtures and remove personal data, recent-file paths and private certificate names.

| File | Format and size | Exact shot and dataset | Page |
| --- | --- | --- | --- |
| `pdf-text-edit.png` | PNG, 2560×1600 | Public rich-text fixture; edit two words in a mixed-format heading with page, frame, Layers and text controls visible. | `/pdf/` |
| `pdf-page-organiser.png` | PNG, 2560×1600 | Public multi-page fixture; show a live reorder insertion marker and one rotated thumbnail. | `/pdf/` |
| `pdf-redaction.png` | PNG, 2560×1600 | Redaction E2E fixture; show a selected match, preview and other-match count before applying. | `/pdf/` |
| `pdf-sign-ocr.png` | PNG, 2560×1600 | Public OCR scan fixture; select a recognised word and show a visible-signature preview without private certificate data. | `/pdf/` |
| `pdf-workflow.mp4` + `pdf-workflow-poster.png` | H.264 MP4, 1920×1080, ≤30s, ≤8MB; PNG poster | Public fixtures; open, edit text, reorder, preview a redaction and export in one deliberate take. | `/pdf/` |
| `image-layers-masks.png` | PNG, 2560×1600 | Synthetic campaign artwork; named group, pixel/vector/clipping masks, colour labels and layer search. | `/image/` |
| `image-adjustment-layers.png` | PNG, 2560×1600 | Adjustment E2E scene; Curves, Basic adjustment and expanded sharpen/blur live-filter stack. | `/image/` |
| `image-background-removal.png` | PNG, 2560×1600 | Redistributable product photo; local subject mask in Refine Edge with boundary visible. | `/image/` |
| `image-large-document.png` | PNG, 2560×1600 | Documented 200 MP / 20-layer acceptance fixture in Linux Tauri; show dimensions, layer count and an adjustment. | `/image/` |
| `image-workflow.mp4` + `image-workflow-poster.png` | H.264 MP4, 1920×1080, ≤30s, ≤8MB; PNG poster | Core-task campaign: place photo/SVG, styled text, four artboards, export WebP and PNG. | `/image/` |

## Add a file

Drop the file and, for video, its poster into `src/media/`, then run `node build.mjs`. The slot is rendered only when every required file exists. To change a slot, edit `content/media.json` and rebuild.
