# Media shot list

Missing files are deliberately omitted from the built pages. The build prints one warning per missing slot.

Screenshots are **2560 × 1600 PNG** (plus a WebP next to it) of the published web apps at **1280 × 800 and 2×**. Videos are **1920 × 1080 H.264 MP4** of one continuous session, **about 30–40 seconds** and under **8 MB**, with a JPEG poster frame; waiting times (a model loading, a preview rendering) are cut, everything else keeps its real speed, and a drawn pointer shows where the mouse is. Only the site's own sample files are used: `apps/pdf/scripts/fixtures/smoke.pdf` and `scanned-page.pdf`, `website/media/backpack.png` (generated for the site) and the site's mine illustration.

All media are produced by scripts, headless:

```bash
node website/media/capture-pdf.mjs https://bergwork.app/app/pdf/ website/src/media
node website/media/capture-image.mjs https://bergwork.app/app/image/ website/src/media
for f in website/src/media/*.png; do magick "$f" -quality 82 "${f%.png}.webp"; done
```

| File | Shot | Page |
| --- | --- | --- |
| `pdf-text-edit.png` | Edit PDF, the heading selected, Font open in the properties panel. | `/pdf/` |
| `pdf-page-organiser.png` | Pages drawer, four pages, page 2 selected (light appearance). | `/pdf/` |
| `pdf-redaction.png` | Find and redact “Keller”: both matches marked, dark bars and the hint on the page. | `/pdf/` |
| `pdf-ocr.png` | OCR done on the sample scan, recognised text in the panel (light appearance). | `/pdf/` |
| `pdf-workflow.mp4` + `pdf-workflow-poster.jpg` | Edit a heading, find and redact a name, pages, save. | `/`, `/pdf/` |
| `image-background-removal.png` | The backpack cut out with its layer mask. | `/image/` |
| `image-layers-masks.png` | Cut-out over the placed mine illustration, Curves above. | `/image/` |
| `image-adjustment-layers.png` | The Curves dialog with an S-curve. | `/image/` |
| `image-export.png` | Export As with preview and estimated size. | `/image/` |
| `image-workflow.mp4` + `image-workflow-poster.jpg` | Import, remove background, place a backdrop, Curves, export. | `/`, `/image/` |

## Add a file

Drop the file and, for video, its poster into `src/media/`, then run `node build.mjs`. The slot is rendered only when every required file exists. To change a slot, edit `content/media.json` and rebuild.
