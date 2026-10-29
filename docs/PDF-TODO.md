# berg:work PDF: TODO

Snapshot of 2026-10-29 (`origin/main` `bdaca2b`, Fernwork pin `c46ed765`, the state live on bergwork.app), from a
hands-on review: the web build and the Linux Tauri release build, driven headless (Chromium 147, desktop 1440×900
and a 390×844 touch phone; the app under Xvfb), on a Google Docs export, a 117-page book, a form and a scan.
Timings come from software rendering on a loaded laptop and are upper bounds; the patterns hold.

This list holds what berg:work owns: the source fork's berg:work additions (islands chrome, mini toolbar, shortcut
overview), the host and the apps. Editor core issues and missing editor features belong to Fernwork and are listed
in Fernwork's `docs/pdf/TODO-editor-feel-and-features.md`. They are fixed there and ported here (see the
`bergwork-pdf-sync` skill).

Status: `[ ]` open · `[~]` in progress · `[x]` done and checked on screen. Effort in person-days (PD).

## Fork UI (berg:work additions in `apps/pdf/editor/`)

- [ ] **Floating bars avoid what they float over.** One positioning rule for the mini toolbar, colour bars and status
  line: bound to the anchor, moved aside on collision, following the object. 3–5 PD.
  - The text mini toolbar covers the rotate handle and the line above the selection.
  - After an image is moved, its opacity bar stays where the image was.
  - A comment's colour bar lies over the neighbouring image.
- [ ] **Status line is unreadable.** “Applying change – you can keep editing” is drawn under the labels of the top
  right island (Document tools, Properties). 0.5 PD.
- [ ] **Zoom popover is clipped.** The popover of the bottom left zoom island is cut off at the left window edge
  (− and “Mouse wheel” half outside). 0.5 PD.
- [ ] **Shortcut overview misses the tool keys.** `ShortcutsDialog` (`?`) lists no tool keys, although H, V, T, I,
  R, E, A, D, C and M are bound (`TOOL_SHORTCUTS` in the shell). Add them, and the Fernwork additions such as
  fit/100 % once they exist. 0.5 PD.
- [ ] **Edit as paragraph is not on `main`.** It lives on `feat/pdf-paragraph-edit` (`9a0124f`), but the sync skill
  describes it as present. Either finish and merge it, or hand it to Fernwork (the Fernwork TODO asks for semantic
  lines and paragraphs, which would replace it). Then correct the skill.

## Desktop apps (`apps/pdf/src-tauri`, `packages/host-tauri`)

Today: the Linux release build works (5:50 min, 72 MB binary with embedded assets), opens a PDF passed on the command
line and has file associations (`pdf`, `bwpdf`, `fwdoc`), single instance and native save. The Rust side is 207
lines of file I/O. `packages/host-tauri` is still empty.

- [ ] **Windows build.** Build `nsis`/`msi`, test WebView2 (cross-origin isolation, WASM threads, memory), paths and
  CRLF. 3–5 PD.
- [ ] **macOS build.** Universal binary, hardened runtime, Developer ID signing and notarisation (99 $/year). 3–5 PD.
- [ ] **Windows code signing.** An OV certificate (150–300 $/year) or Azure Artifact Signing (about 10 $/month; in
  the EU only for organisations). SmartScreen reputation builds up over time; EV no longer skips it. 2–3 PD.
- [ ] **Updates.** Tauri updater with signed manifests: NSIS/MSI, macOS, and on Linux AppImage only. Plus winget and
  AUR; Flatpak later (check Flathub's current rules on AI-written code first, unverified). Use a current
  updater-plugin version. 3–5 PD.
- [ ] **Release CI.** All platforms, signing, artefacts, update manifest. 8–15 PD.
- [ ] **Default PDF app, per OS.** 5–8 PD for the three desktops.
  - **Windows:** apps cannot make themselves the default (UCPD protection). Register a ProgID and
    `Capabilities\FileAssociations`, and offer a “Make default” button that opens
    `ms-settings:defaultapps?registeredApp…`.
  - **macOS:** `CFBundleDocumentTypes` with `com.adobe.pdf`; the system asks the user.
  - **Linux:** `.desktop` `MimeType` plus `xdg-mime default`.
- [ ] **Native printing instead of the WebView.**
  - Windows: PDFium into a device context.
  - macOS: PDFKit `printOperation`.
  - Linux: hand the PDF to CUPS.

  3–6 PD per OS.
- [ ] **German user interface.** The editor is English only. Needs Fernwork's string catalogue (see the Fernwork
  TODO) plus native strings: installer, `.desktop`, Info.plist. 5–10 PD.
- [ ] **Crash reports.** Opt-in only; Sentry EU region; JS errors, Rust panics, minidumps; never document content.
  2–3 PD.
- [ ] **System fonts.** List them in Rust (fontdb, DirectWrite, CoreText), pass them to HarfBuzz and PDFium, respect
  embedding permissions. 2–4 PD.
- [ ] **Shell integration** (later). Explorer thumbnails (`IThumbnailProvider`), the Windows 11 context menu (needs
  package identity), jump lists and recent documents. 8–16 PD.
- [ ] **Signing with system certificates** (later). Windows certificate store (CNG), macOS Keychain, PKCS#11 and
  smartcards; timestamp and LTV through the host contract. 15–30 PD.
- [ ] **Office conversion, desktop only** (later). PDF↔Word/Excel and Office→PDF through LibreOffice headless,
  if it is installed. It is not feasible in the browser.

## Agent interface

The corpus harness (`apps/pdf/tests/harness`, `run-corpus.mjs`) already drives the editor's engine without the UI
in a headless page. That is the basis.

- [ ] **CLI** (`bergwork-pdf-cli`, a separate binary because Tauri's GUI subsystem cannot write to the console).
  Same engine headless. 5–10 PD.
  - Commands: open/info, render a page, extract text, OCR, search-and-redact, replace text, fill a form, page
    operations (rotate, delete, reorder, merge, split, export a range), optimize, protect, save.
  - JSON output, exit codes.
- [ ] **MCP server** (`bergwork-pdf-cli mcp`, stdio). The CLI's operations as tools, local only, no upload.
  3–6 PD.
- [ ] **URL scheme / deep link.** Open file X at page Y, from scripts and other apps. 1–2 PD.

## Printing to berg:work PDF

- [ ] **Windows: no own printer driver.** Third-party V3/V4 drivers are being retired: no new drivers through Windows
  Update since 2026-01-15, security fixes only from 2027-07-01. Windows Protected Print blocks PDFCreator-style
  drivers. A Print Support App v4 virtual printer (MSIX) receives only OXPS/PostScript, which needs an
  XPS/PS→PDF converter, and the usual ones are AGPL. That is 15–30 PD at high risk. Instead, offer “Open with
  berg:work PDF” after Microsoft Print to PDF, or watch a folder. 2–4 PD; test under Windows Protected Print first.
- [ ] **macOS: PDF Services entry.** An alias in `~/Library/PDF Services` appears under “PDF ▾” in every print
  dialog and receives the PDF. Not possible in the Mac App Store. 1–2 PD.
- [ ] **Linux: CUPS backend** (optional). A cups-pdf-style backend that opens the job in the app (needs root at
  install; not from Flatpak). 2–3 PD.

## Web, Android, phones

- [ ] **PWA.** Installable manifest, `file_handlers` (desktop Chromium: open PDFs from the file manager) and
  `share_target` (Android: “Share → berg:work PDF”). 2–5 PD.
- [ ] **Android app for Googlebooks** (as planned in `docs/ARCHITECTURE.md`).
  - The Android WebView has no cross-origin isolation, so no SharedArrayBuffer or WASM threads: PDFium and Tesseract
    need single-thread builds, or native builds through Rust.
  - Intent filters for `application/pdf` with `content://` URIs; save back only with write access, otherwise
    `ACTION_CREATE_DOCUMENT`.
  - Play: target API 36, 16 KB page size for the native libraries.

  10–20 PD, plus the touch work in the Fernwork TODO.
- [ ] **Phone apps** (iOS, Android phones): not planned. The market is full and free (Adobe, Xodo, PDFgear), and
  bergwork.app already works in phone browsers. Reconsider only on demand.
