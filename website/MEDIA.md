# Media shot list

Missing files are deliberately omitted from the built pages. The build prints one warning per missing slot.

The site shows many **small** pictures, each next to a short explanation, and **one short take per product**. Every
picture is cropped to what its text explains, so the interface stays readable at about 560 CSS px.

- **Screenshots:** the published web apps at 1280 × 800 and 2×, light appearance, locale en-US, cropped with a clip
  (typically 600–900 × 300–640 CSS px, so 1200–1800 px wide files). PNG plus a WebP next to it. `content/media.json`
  gives the pixel size; the page marks them as 2× (`srcset … 2x`), so they are never shown larger than they are sharp.
- **Takes:** one continuous session, 10–18 s, H.264 MP4 (yuv420p, faststart, no audio) under 4 MB, plus a JPEG poster
  of the end state. Playwright's own recorder only gives 1×, so the scripts grab 2× frames of the action area
  (`grabFrames` in `media/video.mjs`, about five per second), run the session four times slower than a hand would and
  play it back a little more than four times faster. Waits (a model loading, a preview rendering) are cut. A drawn
  pointer shows the mouse. On the page they loop muted while visible and have their own pause button.
- **Samples only:** `apps/pdf/scripts/fixtures/smoke.pdf` and `scanned-page.pdf`, `website/media/backpack.png`
  (generated for the site) and the site's mine illustrations.

All media are produced by scripts, headless:

```bash
node website/media/capture-pdf.mjs https://bergwork.app/app/pdf/ website/src/media
node website/media/capture-image.mjs https://bergwork.app/app/image/ website/src/media
python3 website/media/og-images.py
```

`capture-pdf.mjs` takes `--only=name,name` and `--no-video`; a local build of the app (any static server with the
headers from `_headers`) is faster and steadier than the live site on a slow connection.

| File | Shows | Page |
| --- | --- | --- |
| `pdf-move.mp4` + poster | Edit PDF: the heading dragged elsewhere, a drawing and its label picked up together, moved and turned, the heading retyped. | `/`, `/pdf/` |
| `pdf-text-edit.png` | The heading as a text object, Font open (family, style, size, colour). | `/pdf/` |
| `pdf-select-many.png` | A marquee over the table: 20 cells selected, Arrange and Group. | `/pdf/` |
| `pdf-precise.png` | A rectangle selected with handles and Edit path points, Position & size open. | `/pdf/` |
| `pdf-insert.png` | The Insert menu. | `/pdf/` |
| `pdf-pages.png` | The Pages panel, page 2 selected. | `/pdf/` |
| `pdf-redaction-find.png`, `pdf-redaction.png` | Find and redact “Keller”, then the marked contact line with its hint. | `/pdf/` |
| `pdf-sign.png` | The Sign panel: Handwritten or Certificate; Draw, Type, Image. | `/pdf/` |
| `pdf-ocr.png` | OCR done on the sample scan, recognised text in the panel. | `/pdf/` |
| `pdf-tools.png` | The Document tools menu. | `/pdf/` |
| `image-move.mp4` + poster | Background removed, the cut-out moved, scaled and turned on a new scene, text added. | `/`, `/image/` |
| `image-*.png` | One picture per row on `/image/`: cut-out, transform, layers, adjustment layer, text, shapes, layer styles, selection, export. See `content/media.json`. | `/image/` |
| `src/assets/img/og-*.jpg` | Open Graph pictures (1200 × 630): site, PDF, Image. | all pages, the apps |

## Add a file

Drop the file and, for video, its poster into `src/media/`, then run `node build.mjs`. The slot is rendered only when
every required file exists. To change a slot, edit `content/media.json` and rebuild; the text next to a picture lives
in the page module (`src/pages/*.mjs`).
