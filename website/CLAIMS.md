# berg:work website claims ledger

Every product, status, format, platform, privacy, price and licence statement published by the generated site is listed here. Status means:

- `WORKS`: implemented and backed by a test, measurement or current internal build.
- `IN PROGRESS`: present in part, with the remaining gap stated on the site.
- `PLANNED`: recorded in the product plan but not yet implemented or released.
- `OWNER`: a recorded owner decision or binding product rule.
- `CONFIRM`: conservative placeholder that still needs the owner's confirmation.

Paths beginning `../17_fernwork` and `~/.local/share/fernwork-compositor-lab/workspaces/claude` are read-only source repositories.

| ID | Published claim | Status | Source |
| --- | --- | --- | --- |
| C01 | The product names are “berg:work PDF” and “berg:work Image”. | OWNER | Owner decision 2026-09-25 ("wir lassens mal bei bergwork image und bergwork pdf"); `website/site.config.mjs`. |
| C02 | The canonical site URL is https://bergwork.app. | OWNER | Owner statement 2026-09-25 ("domains sind himmelcad.com und bergwork.app"); `website/site.config.mjs`. |
| C03 | berg:work covers two planned/working desktop products: a PDF editor and an image editor. | OWNER | Owner brief `.codex/website-v2-bergwork.md`, “What berg:work is”. |
| C04 | Neither product has a public build. | OWNER | Owner brief `.codex/website-v2-bergwork.md`, download-page instruction; image internal-build status at `~/.local/share/fernwork-compositor-lab/workspaces/claude/artifacts/handoff.md:127-135`. |
| C05 | Price and licence terms have not been decided. | OWNER | `../17_fernwork/research/compositor-port/PRODUCT-PLAN.md:541`; owner brief explicitly forbids prices and licence claims. |
| C06 | Linux and Windows are the planned first-release platforms. | OWNER | `../17_fernwork/research/compositor-port/PRODUCT-PLAN.md:172-178,543`; owner brief download instruction. |
| C07 | macOS is not planned for the first release because there is no test device. | OWNER | `../17_fernwork/research/compositor-port/PRODUCT-PLAN.md:543`. |
| C08 | Offline operation and no account are binding image-editor rules. | OWNER | `../17_fernwork/research/compositor-port/PRODUCT-PLAN.md:53`. |
| C09 | No telemetry is the current owner decision. | OWNER | `../17_fernwork/research/compositor-port/PRODUCT-PLAN.md:546`. |
| C10 | Local AI and optional, locally cached models are design rules; remote models are fetched only after an explicit action. | OWNER / WORKS | Rule: `../17_fernwork/research/compositor-port/PRODUCT-PLAN.md:58`; host behaviour: `~/.local/share/fernwork-compositor-lab/workspaces/claude/docs/tauri.md:11-16`. |
| C11 | The image project format is open and documented. | WORKS | `~/.local/share/fernwork-compositor-lab/workspaces/claude/docs/format-v2.md`, especially “Versioning and migration” and “Security and privacy” at lines 160-184; tests cited in `artifacts/roadmap-status.md:98`. |
| C12 | Linux is treated as a first-class platform, while a WebKitGTK brush-performance target remains open. | OWNER / IN PROGRESS | Rule: `../17_fernwork/research/compositor-port/PRODUCT-PLAN.md:64`; measured gap: same file lines 662-669 and `artifacts/roadmap-status.md:102`. |
| C13 | The image desktop shell exists as an internal Tauri build. | WORKS | `~/.local/share/fernwork-compositor-lab/workspaces/claude/artifacts/handoff.md:44-57,127-135`; `artifacts/roadmap-status.md:94`. |
| C14 | The image Tauri build opens and saves through native file dialogs and supports OS-open events. | WORKS | `~/.local/share/fernwork-compositor-lab/workspaces/claude/docs/tauri.md:1-22`; tests/evidence at `artifacts/handoff.md:102-116`. |
| C15 | The image build leaves no process behind after quit. | WORKS | `~/.local/share/fernwork-compositor-lab/workspaces/claude/artifacts/handoff.md:44-46`. |
| C16 | The hardened Windows image build made no observed network connections during a five-minute probe. | WORKS | `~/.local/share/fernwork-compositor-lab/workspaces/claude/artifacts/handoff.md:104-105`; measurement caveat at `../17_fernwork/research/compositor-port/PRODUCT-PLAN.md:646-651`. |
| C17 | The image editor has layers, groups, masks, clipping masks, opacity, locks, colour labels and layer search. | WORKS | `~/.local/share/fernwork-compositor-lab/workspaces/claude/artifacts/roadmap-status.md:14-24`, cited E2E/unit tests. |
| C18 | The image editor implements all 27 planned blend modes. | WORKS | `~/.local/share/fernwork-compositor-lab/workspaces/claude/artifacts/roadmap-status.md:20`; `artifacts/handoff.md:93-94`. |
| C19 | The image editor has rectangle/ellipse, lasso/polygon, magic-wand and range-adjustment selection tools. | WORKS | `~/.local/share/fernwork-compositor-lab/workspaces/claude/artifacts/roadmap-status.md:32-35`. |
| C20 | The image editor has brush/eraser with pressure, spot healing, clone stamp, content-aware fill, smudge, dodge, burn and sponge modes. | WORKS | `~/.local/share/fernwork-compositor-lab/workspaces/claude/artifacts/roadmap-status.md:41-45`. |
| C21 | The image editor has adjustment layers for curves, levels, hue/saturation, exposure, gradient map, grain, a Basic group and colour lookup. | WORKS | `~/.local/share/fernwork-compositor-lab/workspaces/claude/artifacts/roadmap-status.md:51-54`. |
| C22 | The image editor has live filters including Gaussian and motion blur, noise, lens correction, sharpen, high pass and denoise. | WORKS | `~/.local/share/fernwork-compositor-lab/workspaces/claude/artifacts/roadmap-status.md:51-54`; `artifacts/handoff.md:141-143`. |
| C23 | The image editor has free transform, flip, distort, crop and image/canvas sizing; the non-destructive crop field exists but its tool is incomplete. | WORKS / IN PROGRESS | `~/.local/share/fernwork-compositor-lab/workspaces/claude/artifacts/roadmap-status.md:60-62`. |
| C24 | The image editor has point/area text with typography and OpenType support. | WORKS | `~/.local/share/fernwork-compositor-lab/workspaces/claude/artifacts/roadmap-status.md:68-70`. |
| C25 | The image editor has parametric shapes, pen/direct selection, Boolean operations and vector masks. | WORKS | `~/.local/share/fernwork-compositor-lab/workspaces/claude/artifacts/roadmap-status.md:68-70`. |
| C26 | The image editor has drop shadow, stroke, outer glow and overlay layer styles. | WORKS | `~/.local/share/fernwork-compositor-lab/workspaces/claude/artifacts/roadmap-status.md:76`. |
| C27 | The image editor imports PNG, JPEG and TIFF with ICC conversion; it also imports HEIC, WebP, AVIF and GIF. | WORKS | `~/.local/share/fernwork-compositor-lab/workspaces/claude/artifacts/roadmap-status.md:82-84`. |
| C28 | The image editor exports PNG, JPEG, WebP, AVIF and TIFF through one export flow, including artboard/layer export at 1×, 2× and 3×. | WORKS | `~/.local/share/fernwork-compositor-lab/workspaces/claude/artifacts/roadmap-status.md:16-17`. |
| C29 | PSD import works partially: measured native fidelity is 67%, below the 90% target. | IN PROGRESS | `~/.local/share/fernwork-compositor-lab/workspaces/claude/artifacts/handoff.md:149-153,169-171`; `artifacts/roadmap-status.md:85`. |
| C30 | PSD writing and RAW import are planned for Phase 3. | PLANNED | `../17_fernwork/research/compositor-port/PRODUCT-PLAN.md:457-461`; `artifacts/roadmap-status.md:86`. |
| C31 | Local object selection, refine edge, quick mask, colour range and background removal work in the internal build. | WORKS | `~/.local/share/fernwork-compositor-lab/workspaces/claude/artifacts/roadmap-status.md:32-35`; model behaviour at `docs/tauri.md:11-16`. |
| C32 | Object selection currently takes 14–22 seconds in its single-threaded WASM path. | IN PROGRESS | `~/.local/share/fernwork-compositor-lab/workspaces/claude/artifacts/roadmap-status.md:33`; `artifacts/handoff.md:172`. |
| C33 | A 200-megapixel, 20-layer save/reopen workflow completed in Chromium and the Linux Tauri build; latency targets remain open. | WORKS / IN PROGRESS | `~/.local/share/fernwork-compositor-lab/workspaces/claude/artifacts/handoff.md:132-135`; `artifacts/roadmap-status.md:101`. |
| C34 | Image roadmap Phase 0 and Phase 1 are complete; Phase 2 features are implemented but its 90% PSD-fidelity exit target remains open; Phases 3 and 4 are planned. | WORKS / IN PROGRESS / PLANNED | Phase definitions: `../17_fernwork/research/compositor-port/PRODUCT-PLAN.md:424-467`; current status: `~/.local/share/fernwork-compositor-lab/workspaces/claude/artifacts/handoff.md:23-176` and `artifacts/roadmap-status.md:8`. |
| C35 | The image editor deliberately excludes 3D, video/timeline, animation, slices, cloud collaboration, stock/template marketplace, a scripting ecosystem, third-party plug-in compatibility and pixel-for-pixel compatibility with other editors. | OWNER | `../17_fernwork/research/compositor-port/PRODUCT-PLAN.md:32-35`. |
| C36 | The PDF editor works today in Fernwork's browser build; its separate desktop shell has not started. | WORKS / PLANNED | Browser tool list: `../17_fernwork/README.md:24-25`; desktop status: owner brief `.codex/website-v2-bergwork.md`, PDF source note. |
| C37 | PDF text can be edited in place with mixed formatting preserved across export/reopen, undo and redo. | WORKS | `../17_fernwork/test/e2e/pdf-rich-text-editing.spec.ts:75-198`; additional exact-edit coverage listed in `PDF_OPEN_ISSUES.md:7-10`. |
| C38 | PDF pages can be appended, reordered, deleted and rotated, with the result exported. | WORKS | `../17_fernwork/test/e2e/pdf-organize-rotate-after-structure.spec.ts:38-72`; high-level tool list at `../17_fernwork/README.md:24-25`. |
| C39 | PDF files can be merged and split in the browser toolset. | WORKS | `../17_fernwork/README.md:24-25`; implementations `../17_fernwork/tools/pdf-merge.html` and `tools/pdf-split.html`. |
| C40 | PDF redaction previews and permanently removes selected content; find-and-redact handles every match. | WORKS | `../17_fernwork/test/e2e/pdf-redaction-precision.spec.ts:63-139`. |
| C41 | PDF signing supports visible marks and certificate-based signatures, with invalid credentials rejected. | WORKS | `../17_fernwork/test/e2e/pdf-digital-signature.spec.ts:216-475`; visible-signature tests at lines 566-700. |
| C42 | PDF OCR is available and scanned-page OCR text can be selected. | WORKS | Tool entry `../17_fernwork/tools/pdf-ocr.html`; selection evidence `../17_fernwork/test/e2e/pdf-scan-ocr-selection.spec.ts:14-46`. |
| C43 | PDF text can be copied and marked with highlight, underline and strikethrough annotations. | WORKS | `../17_fernwork/test/e2e/pdf-reading-text-markup.spec.ts:63-143`. |
| C44 | PDF forms can be filled and their values persist through undo/redo, reload and export. | WORKS | `../17_fernwork/PDF_POLISH_TODO.md:147`; test named there: `test/e2e/forms.spec.ts`. |
| C45 | PDF watermark/page-number stamps work across page rotation and crop. | WORKS | `../17_fernwork/test/e2e/pdf-page-stamps.spec.ts:101-252`. |
| C46 | PDF compression, encryption/decryption and metadata tools exist in the browser build. | WORKS | `../17_fernwork/README.md:24-25`; implementations including `tools/pdf-compress.html` and PDF shell modules. |
| C47 | PDF snapping is off by default pending a product decision. | IN PROGRESS | `../17_fernwork/PDF_OPEN_ISSUES.md:20`. |
| C48 | On phones at fit-to-width, text can be small when editing; automatic zoom is not implemented. | IN PROGRESS | `../17_fernwork/PDF_OPEN_ISSUES.md:21`. |
| C49 | At some desktop widths, some PDF toolbar labels collapse to icons. | IN PROGRESS | `../17_fernwork/PDF_OPEN_ISSUES.md:22`. |
| C50 | Narrowing a PDF text frame does not automatically fit its height; long words may break within the word. | IN PROGRESS | `../17_fernwork/PDF_OPEN_ISSUES.md:25-26`. |
| C51 | Opening very large PDF documents still has lower-priority performance work remaining. | IN PROGRESS | `../17_fernwork/PDF_OPEN_ISSUES.md:27`; large scanned-document commit timing at `PDF_POLISH_TODO.md:30`. |
| C52 | Individual rotation of nested paths inside form objects is not supported; the group can be rotated. | IN PROGRESS | `../17_fernwork/PDF_POLISH_TODO.md:49`. |
| C53 | Paragraph-wide PDF reflow is not implemented; multiline source paragraphs can still be line objects. | IN PROGRESS | `../17_fernwork/PDF_POLISH_TODO.md:158`. |
| C54 | The planned PDF desktop wrapper will add native open/save integration for the already-working browser editor. | PLANNED | Owner brief `.codex/website-v2-bergwork.md`, PDF page and source note; the desktop shell is explicitly not started. |
| C55 | Himmel:CAD is a sister project for surveying CAD. | OWNER | Root `README.md`, introductory and sister-brand statements; owner brief permits footer mention. |
| C56 | The website uses no analytics, tracking or cookies and makes no third-party runtime requests. | WORKS | Generated source/build contract in `website/src/`, `_headers`, and `check.mjs` external-request gate; current legal facts preserved from `website/datenschutz.html` (pre-v2). |
| C57 | The service worker stores site files in browser Cache Storage for offline access and does not store personal data. | WORKS | `website/src/sw-template.js` and generated privacy page; Cache Storage contains only same-origin static responses. |
| C58 | The site is hosted through Cloudflare Pages, whose server logs can include IP address, requested URL, user agent and TLS metadata for delivery and security. | OWNER | Facts preserved from the pre-v2 `website/datenschutz.html`, “Hosting” and “Serverprotokolle”. |
| C59 | The provider is Florian Fischer, Steig 4, 88167 Grünenbach, Germany; contact is fernwork.absolute836@passmail.net. | OWNER | Facts preserved from the pre-v2 `website/impressum.html`; contact address mandated by owner brief. |
| C60 | Site visitors have the data-subject rights listed in GDPR Articles 15–21 and 77. | OWNER | Facts preserved from the pre-v2 `website/datenschutz.html`, “Ihre Rechte”. |
| C61 | Bergschrift is a modified OFL-licensed display font, renamed because of the Reserved Font Name clause. | WORKS | `website/src/assets/fonts/OFL.txt`; build provenance in root `scripts/build-wordmark-font.py` and the pre-v2 `website/README.md`, “Font licence”. |
