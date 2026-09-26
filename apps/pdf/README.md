# berg:work PDF

Tauri 2 app around the Fernwork PDF editor. Internal builds only; there is no public release.

## Layout

| Path | Owns |
| --- | --- |
| `upstream/` | Pinned editor build (not committed): the files listed for `fernwork-pdf` in `../../upstream.lock.json`, laid out as in Fernwork (`tools/vendor/pdf-tools`, `pdf-runtime`, `tesseract-5.0.4`). Recreate it with `npm run sync:install`. Never edited here. |
| `web/` | Host page owned by berg:work: `index.html`, `main.js` (Fernwork's bootstrap without site navigation, service worker and file-open router), `host.js` (title bar, settings and the host object passed to `mount`), `native-files.js` (native open/save), `licenses-view.js`, `theme-preference.js`, `theme.css` (palette, title bar, licences dialog), `fonts/` and the title-bar icons. Plain ES modules, no bundler. |
| `scripts/build-frontend.mjs` | Assembles `dist/` (not committed): `web/` at the root, the pinned build under `dist/tools/vendor/` (the bundle still loads its workers, WASM and fonts from absolute `/tools/vendor/...` URLs) and `licenses.json`. |
| `scripts/collect-licenses.mjs` | Licence data for the app and `THIRD_PARTY_NOTICES.md` (see Licences). |
| `scripts/tauri*.sh`, `scripts/tauri.mjs` | Tauri CLI entry points; on Linux they point the build at a rootless WebKitGTK prefix (see below). |
| `src-tauri/` | Rust app, `tauri.conf.json` (window, CSP, bundles, file associations), capabilities, icons (copied from `branding/logos/generated/bergwork-pdf/tauri/`), Linux desktop template and MIME definition. |

## Build and run

From the repository root:

```sh
npm install
npm run sync:install                      # once, and after every pin change
npm run tauri:build -w @bergwork/pdf      # release binary, .deb, .rpm and .AppImage
npm run tauri:dev -w @bergwork/pdf        # debug build, serves dist/ without a dev server
npm run build:web -w @bergwork/pdf        # only assemble dist/
```

Outputs land in the workspace `target/`: the binary is `target/release/bergwork-pdf`, the packages are in
`target/release/bundle/{deb,rpm,appimage}/`. Windows (`nsis`, `msi`) is configured in
`src-tauri/tauri.windows.conf.json` but has not been built yet.

`tauri:dev` builds `dist/` once and does not watch `web/`; restart it after changes to the host page. For
`cargo build`, `cargo clippy` or running the binary by hand on Linux, source the environment first:
`source apps/pdf/scripts/tauri-env.sh`.

### Linux without root

The WebKitGTK and GTK development packages do not have to be installed system-wide. `scripts/tauri-env.sh` uses
the prefix from `BERGWORK_TAURI_PREFIX`, else `FERNWORK_TAURI_PREFIX`, else `~/.cache/fernwork-tauri-deps` (shared
with the Fernwork compositor workspace). If `pkg-config` cannot find the libraries there,
`scripts/tauri-install-linux-deps.sh` downloads the `.deb` files with `apt-get download` and unpacks them into the
prefix (Ubuntu 24.04 amd64 only). For the AppImage, `tauri-build.sh` puts `scripts/appimage-pkgconf/` on the
`PATH`, so linuxdeploy's GTK plugin takes GTK modules, pixbuf loaders and GSettings schemas from the system rather
than from the prefix, which holds only headers and link stubs.

## Host, title bar and files

`web/index.html` draws berg:work's own title bar above the editor: the PDF mark (a variant per theme), the
`berg:work` wordmark in Bergschrift (`web/fonts/`, OFL) in the site red, `| PDF`, a settings button (theme
System/Light/Dark, version, licences) and macOS-style window controls on the right (close outermost). The bar
is the window's drag area; a double click maximises. On Linux the window is transparent with rounded corners
(`tauri.linux.conf.json`), square when maximised.

The editor is mounted with `mount(element, { host })`. `host.js` supplies only `shell.setTitle` (the window
title, `• name — berg:work PDF` for unsaved changes); the document name is in the editor's own top bar, and the
editor shows no fullscreen toggle because the shell offers no `setFullscreen`. The editor's `titleBar` slots are
not used.

Files (`web/native-files.js`, commands in `src-tauri/src/lib.rs`):

- Opening a PDF or `.bwpdf`/`.fwdoc` project from the file manager, or passing it on the command line, opens it
  in the editor; a second launch forwards its files to the running window (single instance).
- Save, Save as and Export use the native save dialog (`window.showSaveFilePicker` is provided for the editor),
  so Save overwrites the chosen file afterwards. Other downloads the editor starts also go through the dialog.
- The Rust side reads and writes only paths the user chose or the system passed in; writes go to a temporary
  file that replaces the target.

Outside Tauri all window and file calls fall back to the browser behaviour and the controls stay hidden, so
`dist/` can be opened in a normal browser for tests (serve it with `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`, as the app does); `?preview` shows the window controls inert.

The palette follows VS Code's Dark/Light Modern surfaces with a warm stone grey as accent (red would read as
Close, blue does not fit berg:work); the page accent is a mid grey because it also draws selection frames and
handles on the white page.

## Licences

`npm run licenses -w @bergwork/pdf` regenerates `THIRD_PARTY_NOTICES.md` (committed) from the pinned editor
build's `licenses.json` and the Rust crates compiled into the app (`cargo metadata`, normal dependencies, host
target). `build:web` writes the same data to `dist/licenses.json`, which the app shows under Settings →
Licences. `npm run licenses:check -w @bergwork/pdf` fails when the notices are out of date.

The rest of the host contract (native PDFium/OCR, fonts, printing, close with unsaved changes) is drafted in
`../../docs/PDF-HOST-CONTRACT.md` and has to land in Fernwork first.

## Naming

The product name in `tauri.conf.json` is `bergwork PDF`: Tauri rejects `:` there because the name also becomes
file names, the Windows install directory and shortcut names. Everything the user reads says `berg:work PDF`: the
window title, the Linux launcher (`src-tauri/linux/bergwork-pdf.desktop`) and the package descriptions. The
binary is `bergwork-pdf`, the Debian package `bergwork-pdf`, the identifier `app.bergwork.pdf`.
