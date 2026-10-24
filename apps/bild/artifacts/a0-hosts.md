# A0 engine boundary, hosts, and profiles

## Public surface

`src/platform/hosts/types.ts` defines the optional version-1 capabilities and
`getCapability(host, name, minimumVersion)` / `hasCapability(...)`:

- `FileSystemHost`: save targets, atomic writes, recent files, OS-open events,
  and optional reads of opaque file references. Without it the v1
  `HostAdapter` picker/download path remains active.
- `FontHost`: system-font metadata and bytes. Without it only bundled OFL fonts
  are available.
- `CodecHost`: native image decoding and explicit HEIC-WASM opt-in. The old
  `ImageDecoderHost` name remains a source-compatible deprecated alias.
- `ComputeHost`: named binary jobs. Both hosts implement
  `checksum-sha256`; unknown jobs return `null` for Worker/WASM fallback.
- `ModelHost`: verified model resolution/cache. Remote fetch requires
  `userInitiated: true`; subject removal resolves model bytes here and passes a
  local blob URL to its worker.
- `ColorHost`: display ICC bytes. The fallback is an explicitly marked sRGB
  assumption.
- `scratch`: a structural registry slot for A4's concurrently-developed
  `ScratchHostCapability`; this lane does not own or modify its files.

`contracts-v2.ts` adds `EditorProfileId`, `MountEditorOptionsV2`, and
`MountEditorV2`. `mountEditor(root, { host, profile: 'pro' | 'lite', ... })`
remains source compatible with the v1 call. Browser hosts default to Lite and
the Tauri entry explicitly selects Pro.

The exported registry API is:

```ts
getCapability<K>(host: HostAdapter | HostCapabilityMap, name: K, minimumVersion?: number): CapabilityFor<K> | null
hasCapability<K>(host: HostAdapter | HostCapabilityMap, name: K, minimumVersion?: number): boolean
capabilitiesOf(host: HostAdapter): HostCapabilityMap
bindCapabilityRegistry<T extends CapabilityHost>(host: T): T
createBrowserHost(): FileTargetHost
profileFor(id: 'pro' | 'lite'): EditorProfile
profileHasFeature(profile: EditorProfile, feature: string, capabilities?: HostCapabilityMap): boolean
mountEditor(root: HTMLElement, options: MountEditorOptionsV2): Promise<EditorHandle>
```

## Implementations

The browser host uses File System Access when its save picker exists, Local
Font Access when `queryLocalFonts` exists, Cache Storage for verified AI model
bytes, a TypeScript SHA-256 compute job, and an assumed sRGB display profile.
Missing browser APIs produce the fallbacks above rather than UA checks.
The registry exposes File System Access open handles and in-place targets; the
existing Lite File-menu open command retains its `<input>` fallback so Firefox,
WebKit, and embedded test hosts keep the same user-activation behavior. Saves
use an in-place target whenever one has been selected through the capability.

The Tauri host provides Rust commands for recursive system-font enumeration
and byte loading, SHA-256, model storage under the application cache directory,
recent files under the application config directory, and startup/second-
instance file events. Linux reads `_ICC_PROFILE` from the X root window through
`xprop`; an unavailable property (including many Wayland sessions) reports the
sRGB fallback. Windows calls `GetICMProfileW` behind `cfg(windows)`. File bytes
still cross standard Tauri command/plugin IPC; A6's future high-volume binary
channel is outside A0.

## Profiles

`src/app/profiles.ts` is the single profile table. Both profiles install the
current PL feature modules and tools. Lite has a 100 MP / 30,000 px policy and
both background-removal models because PRODUCT-PLAN 6.2 marks that feature
PLQ. Pro has the planned 300 MP / 60,000 px policy and records future Pro-only
features plus their required host capabilities. The A4 scratch integration
must lift the core's current 100 MP safety ceiling before a 300 MP document can
actually allocate pixels.

## Enforced engine boundary and exceptions

`tests/unit/engine-boundary.test.ts` scans imports for every TypeScript file in
`src/core`, `src/render`, `src/io`, `src/workers`, and `src/text`. React and
imports into `src/ui`/`src/app` fail. The only platform imports allowed are the
neutral codec/capability types. It also rejects runtime `window`/`document`
global access.

Documented exceptions:

- `src/render/**`: Canvas/WebGL/Pixi types and APIs are renderer responsibilities.
- `src/io/imageImport.ts`, `src/io/heic.ts`, and `src/io/export.ts`:
  `OffscreenCanvas`, `createImageBitmap`, `Blob`, and the JPEG Canvas fallback
  are browser codec paths.

No existing boundary violation required moving code. The headless Node test
creates a document, paints pixels, executes the exposure kernel, adds an
adjustment layer, saves `.fwimg`, reopens it, and compares final pixels without
React or DOM globals.

## Platform status

Linux is implemented and locally checked. Windows font/config/open-event code
uses portable standard-library paths; ICC retrieval is Windows-only code guarded
by `cfg(windows)` and could not be compiled on this Linux machine because the
MSVC target/toolchain is unavailable. macOS remains later per E3 and currently
falls back to sRGB for display ICC.

## Upstream reference and deviations

This is new PRODUCT-PLAN A0/A10 boundary work, so it ports no Swift/C image
algorithm. It follows the existing `HostAdapter`, `FileTargetHost`, and
`ImageDecoderHost` patterns and leaves upstream rendering/document semantics
unchanged. Browser APIs have no exact desktop equivalent: unavailable Local
Font Access falls back to bundled fonts, unavailable File System Access falls
back to the v1 picker/download flow, and unavailable monitor ICC data is
reported as assumed sRGB. Linux ICC discovery uses the X `_ICC_PROFILE`
property; Wayland compositors that do not publish it use that fallback.

The one required shared UI integration outside the lane's primary file list is
`src/app/subjectFeature.tsx`: model fetching previously happened in the worker,
and now its inference adapter obtains verified bytes through `ModelHost` before
passing a local blob URL to the worker. `src/app/standalone.ts` has the minimal
browser-entry default (`profile: 'lite'`). `THIRD_PARTY_NOTICES.md` was also
updated for the added Rust crates as required by the repository rules.

## Tests and verification

New unit coverage comprises four host-registry/browser-fallback tests, three
profile policy/capability tests, and three engine-boundary/headless-workflow
tests. The headless test checks real paint, adjustment, `.fwimg` serialization,
reopen, and final pixels. The profile E2E mounts the same public API as Lite and
Pro and checks the selected profile plus configured menu/tool/model UI.

Final 2026-09-24 results:

```text
npx tsc --noEmit -p .
clean (exit 0)

strict supplemental Tauri-frontend typecheck
clean (exit 0; the root tsconfig does not include src-tauri/frontend)

npx vitest run tests/unit
Test Files  53 passed (53)
Tests       421 passed (421)

Playwright Chromium (E2E_PORT=5481, /tmp/pw-out-a0)
67 passed, 1 skipped, 0 failed (6.4m)
```

The skip is the pre-existing optional BiRefNet quality/reference test when its
large local HQ model is absent; the regular real U²-Netp test and the new
profile E2E passed. `cargo check` completed successfully. `cargo test` passed
2 native host tests (0 failed), plus empty main/doc targets. The Linux release
build (`npm run tauri:build -- --no-bundle`) completed and produced
`src-tauri/target/release/fernwork-bildeditor`. Launching it with
`FERNWORK_HOST_SMOKE=1` reported 926 system fonts and `System display profile`;
it was terminated after the smoke window stayed open.

No upstream test is directly ported because A0 is a new product architecture
boundary rather than an upstream editor operation. Existing engine and E2E
behavior suites remain green.
