# Windows WebView2 remote lane: A1 acceptance brief

Do not receive source files by copy/paste, archive, network share, or patch. The only permitted code
transfer is `artifacts/fernwork-image-p0.bundle`, supplied by the integrator. Do not change or commit
the source: this lane returns measurements and evidence only.

## 1. Restore the branch from the bundle

In a Developer PowerShell for Visual Studio (with Git for Windows' `bash.exe` on `PATH`):

```powershell
git clone C:\path\to\fernwork-image-p0.bundle fernwork-p0-a1
cd fernwork-p0-a1
git checkout p0-a1
git log -1 --oneline
git bundle verify C:\path\to\fernwork-image-p0.bundle
```

Record the checked-out commit. Use Node 22.18.x, npm 10.x, the current stable Rust MSVC toolchain,
Visual Studio 2022 Build Tools with “Desktop development with C++”, and the Evergreen WebView2
Runtime. Record `node --version`, `npm --version`, `rustc --version`, Windows build (`winver`), GPU
model/driver, and WebView2 Runtime version.

## 2. Build and smoke-test the real Tauri app

```powershell
npm ci
npm run typecheck
npm run build
npm run tauri:build -- --no-bundle
```

Launch `src-tauri\target\release\fernwork-bildeditor.exe`. Acceptance evidence:

- a native window titled “Fernwork Bildeditor” displays the editor;
- the native File menu is present;
- Ctrl+N opens the editor’s new-project flow and Ctrl+W closes the current project;
- closing the last window and choosing Quit both leave no `fernwork-bildeditor.exe` process;
- no updater, login, telemetry, or network request is started.

Return a screenshot, the build summary, and before/after `Get-Process fernwork-bildeditor
-ErrorAction SilentlyContinue` output.

## 3. Run the identical packaged measurement page

The release binary contains the same `tests/webview/matrix.ts` page used by Linux Tauri/WebKitGTK
and Playwright Chromium. Run it through WebView2, not a separate Chrome window:

```powershell
$env:FERNWORK_WEBVIEW_MATRIX = "1"
$env:FERNWORK_MATRIX_RESULT = "$PWD\webview2-matrix.json"
& .\src-tauri\target\release\fernwork-bildeditor.exe
Get-Content .\webview2-matrix.json
```

Wait up to 15 minutes. Once the JSON file is complete, close the measurement window. Return the JSON
unchanged. It must contain all of these fields:

- WebGL2, `EXT_color_buffer_float`, renderer and `MAX_TEXTURE_SIZE`;
- main-thread and module-worker `OffscreenCanvas`, and a real module-worker result;
- WebGPU, File System Access, and Local Font Access availability;
- default versus `colorSpaceConversion: 'none'` `createImageBitmap` pixels;
- generated 10109×4542 JPEG encoded size, decoded dimensions, and editor-open time;
- 4096² × 10-layer pan, zoom, 200%-pan and 300 px brush distributions, including p95;
- reported JS heap limit plus retained-allocation probe result.

The Phase-0 pass/fail comparison is Pro: 46-MP open ≤1500 ms, pan/zoom p95 ≤16 ms, brush feedback
p95 ≤16 ms. Also report Lite comparisons (≤3000/33/16 ms). A failed budget is a valid result; do
not tune flags or edit the benchmark. Report the exact miss in milliseconds and percent.

## 4. Return package

Return only: environment/version text, command summaries, the unchanged JSON, screenshots, process
cleanup evidence, and a short note for any crash or unsupported API. Do not create a replacement
bundle and do not send source changes. The integrator will enter the numbers in
`artifacts/tauri-webview-matrix.md`.
