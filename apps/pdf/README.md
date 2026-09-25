# berg:work PDF

Tauri 2 app around the Fernwork PDF editor. Not started yet; this directory holds the pinned editor build.

- `upstream/` (not committed): the files listed for `fernwork-pdf` in `../../upstream.lock.json`, laid out as in
  Fernwork (`tools/vendor/pdf-tools`, `pdf-runtime`, `tesseract-5.0.4`) because the bundle still uses absolute
  `/tools/vendor/...` URLs. Recreate it with `npm run sync:install`.
- The editor is mounted with `mount(element)`. The host contract that lets this app supply native files, OCR and
  fonts is drafted in `../../docs/PDF-HOST-CONTRACT.md` and has to land in Fernwork first.
