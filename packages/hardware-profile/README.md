# @bergwork/hardware-profile

This package is the TypeScript side of berg:work's hardware policy. It decides:

- whether the current surface is really using WebGPU, WebGL2, or software rendering;
- how a session recovers from repeated GPU/device loss and persists a software fallback;
- which startup settings a Tauri WebView2 or WebKitGTK shell needs (Android WebView deliberately
  has no launch overrides); and
- which reviewed hardware quirks match a structured set of OS, numeric adapter, driver, backend,
  session, and WebView facts.

The Rust crate owns portable identity/inventory contracts and compute/memory budgets. In
particular, WebKitGTK retains the image editor's measured 512 MiB tile and texture caps and
1024-pixel texture chunks. Neither side imposes a document-pixel ceiling: 200 MP documents are
handled by bounded tile residency and scratch storage.

## Module boundary

**Capabilities, never vendor checks outside this module.** Consumers ask whether a feature or
backend is available and use the returned budget. Adapter names are diagnostic only. If a specific
device/driver combination needs a workaround, add a narrowly matched, expiring rule here instead
of branching in an editor, host, renderer, or job implementation.

`deriveRenderingStatus` labels WebGPU or WebGL2 as hardware only when the adapter used by that
backend is non-fallback. A WebGL2 surface must report its own adapter; a failed WebGPU probe must
not cause a hardware WebGL2 adapter to be mislabeled.

## Add a quirk

1. Add one rule to `quirks-v1.json`. Use numeric vendor/device IDs and bounded dotted-numeric
   driver or WebView versions where possible. Include a concise reason and a real review date in
   `expires`. Do not match a human-readable GPU name.
2. Keep the action as narrow as possible: disable a backend, force software, or reduce a render or
   compute budget. Scales must be between `0.1` and `1.0`.
3. Run `npm run hardware:quirks` at the repository root to regenerate the Rust table.
4. Add a TypeScript match/resolution test and, for new policy behavior, a Rust test.
5. Run `npm run hardware:quirks:check`, `npm test -w @bergwork/hardware-profile`, and
   `cargo test -p bergwork-hardware-profile`.

There are currently zero active rules. A rule is evidence-backed temporary policy, not a device
support list; review or remove it by its expiry date.

