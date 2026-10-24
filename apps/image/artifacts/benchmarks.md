# Core-task benchmark status

Current run: 2026-09-26, Chromium, one worker, all 20 PRODUCT-PLAN section-7.2 workflows. A green result means the
scenario used the real UI and asserted pixels, saved-file structure or document state. An intentional red ends only
at `benchmark-helpers.ts:missing`; a failure before that line is a regression. Environment skips are never counted as
passes.

## Current state

| Task | Workflow | 2026-09-26 result | Last verified product step |
|---:|---|---|---|
| 1 | Product cutout, shadow, three social exports | Green | Three preset artboards exported as separate PNGs; dimensions and product/shadow/background pixels checked |
| 2 | Campaign key visual | Green | Editable text + placed SVG across four artboards; WebP and PNG dimensions/pixels checked |
| 3 | YouTube thumbnail | Green | Extracted subject, gradient, text and editable Stroke/Glow; exported pixels checked |
| 4 | Smart Object mockup | Green | PSD perspective Smart Object replaced; warp state and four perspective-boundary pixels checked |
| 5 | Editable client PSD | Green | Text edited, saved through Save As as layered PSD; independent `ag-psd` parse retains Background + Headline and live `Winter Sale` text/font |
| 6 | Portrait retouch | Green | Healing, Dodge, Basic correction and Colour Lookup change the expected document pixels/state |
| 7 | Sky replacement | **Environment-skipped** | Local SlimSAM `encoder.onnx`/`decoder.onnx` absent; last model-backed run was green. This run did not execute inference and is not counted green |
| 8 | Object removal | Green | Content-aware removal changes selected pixels and preserves outside pixels |
| 9 | Banner set | Green | Five artboards aligned and exported with checked layout pixels |
| 10 | Vector icon | Green | Boolean vector result exported at multiple scales with dimensions/pixels checked |
| 11 | Print / soft-proof | Green | AdobeRGB import, CMYK soft proof and CMYK TIFF channel/profile state checked |
| 12 | RAW workflow | Green | Generated lossless-JPEG DNG developed to RGBA16 and exported as a parsed 16-bit TIFF |
| 13 | 200 MP poster | **Red — product/platform gap** | 20,000×10,000 Pro document and first filled full-size layer succeed; sampled corner/centre pixels are black. Exact failing step below |
| 14 | Batch recipe | Green | Recipe applied to 50 files; ZIP has all names/dimensions and per-image corrected pixels |
| 15 | Typography poster | Green | Variable font weights and OpenType state checked; ellipse path headline stores a closed four-point path and changes >100 composited pixels |
| 16 | Packaging mockup | Green | Bulge mesh stores 16 points, creates one Warp undo step and exports the expected centre pixel |
| 17 | Upscale / denoise | Green | Upscale dimensions plus heavy-grain noise reduction cross the fixed quality threshold |
| 18 | Screenshot instructions | Green | Arrow/frame vector state and blurred sensitive-region pixels checked |
| 19 | Raster logo | Green | Transparent extraction plus editable contour; alpha/edge pixels checked |
| 20 | Crash recovery | Green | Recovered project retains history and can continue Undo with checked document state |

Observed summary: **18 passed, 1 failed, 1 skipped**. Capability status including task 7's earlier model-backed green is
**19 green / 1 red**; the current run itself is not described as 19 passes.

## The one red task: exact failing step

**Task 13 — 200 MP, 30-layer poster persistence.** The browser benchmark successfully mounts the Pro profile, creates
a 20,000 × 10,000 = 200,000,000-pixel document, fills its first full-size layer and reads black pixels at `(0,0)`,
`(10,000,5,000)` and `(19,999,9,999)`. It then reaches the intentional missing-capability sentinel:

```text
MISSING CAPABILITY: a Pro (Tauri) 200-MP path that holds 30 full-size layers
through save and reopen (PRODUCT-PLAN.md §7.2, task 13)
```

The exact unavailable step is therefore: **create/retain layers 2–30 in the packaged Pro/Tauri path, save the
document, close it, reopen it and verify the 30 layers/pixels**. The benchmark deliberately does not synthesize this
success in Chromium: the full run needs roughly 25 GB of scratch/archive space and its product target is Tauri.
`artifacts/a4d-memory.md` proves the same 200-MP workflow only for 20 layers (4.3 GiB peak in packaged Linux Tauri,
20/20 exact pixel checks). That is useful progress but does not satisfy task 13's 30-layer requirement.

## Harness maintenance in this update

The initial run was **16 passed, 3 failed, 1 skipped in 9.3 minutes**. Tasks 5 and 15 stopped at Phase-2
`missing()` markers even though their Phase-3 capabilities had landed. These were pure harness defects:

- Task 5 now invokes the actual Save As PSD target, checks the `8BPS` signature, then uses independent `ag-psd`
  metadata decoding to assert two editable layers and the changed live text/font. Export As is still asserted to be
  image-only.
- Task 15 now creates an ellipse through the vector UI, creates a second headline on that path through the Type tool,
  asserts the closed four-point path model, and requires more than 100 changed composited alpha pixels.

No product assertion, timeout or quality threshold was removed, weakened or raised. Task 13's missing marker remains.
Task 7's existing offline skip was not converted into a pass.

## Final run

Command:

```sh
PLAYWRIGHT_BROWSERS_PATH=/home/oem/.local/share/fernwork-compositor-lab/browser-cache \
E2E_PORT=6153 E2E_BENCHMARKS=1 \
npx playwright test --project=benchmarks --workers=1 --output=/tmp/pw-out-docs-final
```

Host at start:

```text
14:26:32 up 17:13, 1 user, load average: 14.33, 10.11, 6.46
```

Playwright summary (13.0 minutes):

```text
1 failed
  tests/benchmarks/13-large-poster.spec.ts: 200 MP, 30-layer poster persistence
1 skipped
18 passed (13.0m)
```

Task 9 was reported as the slow file at 5.2 minutes under this load and still completed inside its unchanged
300-second scenario allowance. Raw traces and contexts are in `/tmp/pw-out-docs-final` (temporary, not committed).

## Progress history

| Milestone | State |
|---|---|
| Phase 0 skeleton | 1 green / 19 red |
| Phase 1 | 2 green / 18 red |
| First Phase 2 run | 7 green / 13 red |
| Phase 2 after benchmark-found product fixes (`3509ea4`) | 13 green / 7 red |
| Phase 3 current capability state | 19 green / 1 red |
| Phase 3 current observed run | 18 passed / 1 red / 1 environment-skipped |

The A9 user test with 3–5 Photoshop users remains owner-deferred; these automated workflows do not substitute for it.
