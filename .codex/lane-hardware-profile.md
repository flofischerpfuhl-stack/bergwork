# Lane: hardware profile for berg:work (copied and adapted from Himmel:CAD)

Write in English. The owner decided to **copy** Himmel:CAD's hardware profile into berg:work (no shared crate).

## Context

- berg:work monorepo: `/home/oem/Dokumente/003_Projekte/21_bergwork`. Read `docs/ARCHITECTURE.md` first.
  The repo has no commits and another session has staged website files. **Do not run `git add`, `git commit`,
  `git stash` or anything that changes the index.** Do not touch `website/`, `.codex/` (except your report),
  `apps/`, `scripts/sync-upstream*`, `upstream.lock.json`, `docs/PDF-HOST-CONTRACT.md`.
- Source (read-only): `/home/oem/Dokumente/003_Projekte/10_himmelcad`
  - `docs/adr/0032-module-architecture-and-crs-declaration.md` § 3 Hardware profile
  - Rust: `crates/himmelcad-hardware-profile/` (lib, contracts, compute, quirks, generated_quirks, native,
    hardware_policy)
  - TS: `packages/@himmelcad/hardware-profile/` (index.ts, quirks-v1.json, test)
  - Generator and drift check: `scripts/generate-hardware-quirks.mjs`
  - Recent commits `0a30d7de` and `8e77b9ae` explain the truthful rendering status.
- berg:work apps: a PDF editor (PDFium WASM, OCR, canvas rendering) and an image editor (CanvasKit/WebGL,
  ONNX models for background removal, very large documents up to 200 MP). Shell: Tauri 2 on Windows (WebView2),
  Linux (WebKitGTK) and Android (Android WebView on Googlebooks with Intel Core Ultra or Snapdragon X Elite and
  NPUs). Electron is only a possible desktop fallback. Look at how the image editor already handles memory and
  large documents: `/home/oem/.local/share/fernwork-compositor-lab/workspaces/claude/src/platform/runtimeMemory.ts`,
  `largeDocumentAcceptance.ts`, and the WebKitGTK environment in `scripts/tauri.mjs`.

## Task

Create:
1. `crates/bergwork-hardware-profile/` (Rust, `#![forbid(unsafe_code)]`, WASM-safe core, native probes behind
   `cfg(not(target_arch = "wasm32"))`, Android included) and a root `Cargo.toml` workspace with
   `members = ["crates/*"]` (plus `rust-toolchain.toml` only if needed). Keep from Himmel:CAD what applies to a
   2D document editor: hardware identity and inventory, device capabilities, compute/memory budget (usable
   memory, job concurrency, compute backends incl. an NPU entry), quirk registry and resolution. Drop point
   cloud, splat, frontier, frame telemetry and streaming policies unless a piece is generically needed; say in
   the report what you dropped and why.
2. `packages/hardware-profile/` (TypeScript, package name `@bergwork/hardware-profile`): quirk registry
   validation and matching, renderer fallback controller with persisted GPU-loss recovery, truthful rendering
   status (WebGPU / WebGL2 / software, hardware only when the adapter is non-fallback), and instead of Chromium
   launch switches a `deriveWebViewLaunchSettings` for WebView2 (additional browser arguments), WebKitGTK
   (environment variables) and Android WebView (none, documented).
3. One quirk source `packages/hardware-profile/quirks-v1.json` (zero active rules) with
   `scripts/generate-hardware-quirks.mjs` that generates the Rust table and a `--check` drift mode.
4. Tests: `cargo test -p bergwork-hardware-profile`, and TS tests runnable with `npm test -w @bergwork/hardware-profile`
   (keep dev dependencies minimal; `typescript` is fine). Add root scripts `hardware:quirks` and
   `hardware:quirks:check` to `package.json` without changing the existing scripts.
5. `packages/hardware-profile/README.md`: what the module decides, the rule "capabilities, never vendor checks
   outside this module", and how to add a quirk.

Run all tests and the drift check; they must pass. Write a report to
`/home/oem/Dokumente/003_Projekte/21_bergwork/.codex/out/lane-hardware-profile-report.md` with the file list,
test output summary, what was dropped and open questions.
