# Fernwork Image project format, version 2

Status: open specification, version 2. The TypeScript boundary types are published in
`contracts-v2.ts`. A working project normally uses the `.fwimg` extension, but readers must detect
the format from `manifest.json`, not from the filename.

## Container and paths

An `.fwimg` file is a ZIP archive. It contains UTF-8 JSON and binary assets:

```text
manifest.json
assets/<asset-id>.<extension>
history/snapshots/snapshot-<n>.json       optional
history/tiles/<sha256>.bin                optional
```

Member paths use `/`, are relative, contain no empty, `.` or `..` component, no control character,
drive prefix or backslash, and are at most 1,024 UTF-8 code units. Duplicate asset IDs are invalid.
Readers verify every asset's lowercase SHA-256 before installing a document. Unknown ZIP members
may be ignored. Writers must not put secrets, external credentials or machine-specific absolute
paths in an archive.

## Limits

- `manifest.json` and each history snapshot: 4 MiB uncompressed.
- Any binary member: 512 MiB uncompressed.
- Canvas or raster side: 1–30,000 pixels; total live image pixels: 100 million; total mask pixels:
  100 million; layer count: 10,000; hierarchy depth: 64.
- Resolution: 1–9,600 pixels per inch. Opacity values are finite and in 0–1.
- History defaults to at most 100 commands and 256 MiB of tiles retained only by history. An
  application may offer a lower configurable limit. Setting `history.enabled` to `false` records no
  commands or snapshots.

Readers reject a project before replacing the current document if a limit, checksum, reference,
type, hierarchy, clipping graph, or schema constraint fails. ZIP decompression limits are checked
from uncompressed sizes.

## Manifest

`manifest.json` is a JSON object with these required fields:

| Field | Type and meaning |
| --- | --- |
| `format` | Literal `"fernwork-image"`. |
| `version` | Integer `2`. |
| `id`, `name` | Stable document ID and display name. |
| `width`, `height` | Integer canvas size in pixels. |
| `resolution` | Finite pixels per inch. |
| `colorSpace` | `"srgb"` in v2. |
| `activeLayerId` | Existing layer ID or `null`. |
| `layers` | Flat bottom-to-top layer list. `parentId` supplies hierarchy. |
| `artboards` | Document-level artboards, painted/exported above the layer model. May be empty. |
| `assets` | Asset table described below. |
| `swatches` | Optional document swatch groups: `[{id, name, swatches: [{id, name, color: {red, green, blue}}]}]`, colours as sRGB floats 0–1 (working space). Absent or empty means none. Also written into every history snapshot. |
| `history` | Optional saved command history. |
| `extensions` | Optional JSON object. Unknown namespaced members must be preserved when possible. |

JSON numbers must be finite; `NaN` and infinities are invalid. IDs are opaque non-empty strings.
Names are non-empty and at most 16 KiB in UTF-8.

## Assets

Each asset has `id`, safe `path`, MIME `mime`, lowercase hexadecimal `sha256`, and `role`. Raster
assets also have integer `width`, `height`, and `channels` (`1` for a mask, `4` for straight-alpha
RGBA). Roles are `image`, `mask`, `pattern`, `embedded`, and `history-tile`.

Image and mask assets may be shared by layers and snapshots. Current writers preserve unchanged
source encodings; modified RGBA8 and mask data is stored as deterministic PNG. A one-channel mask
uses 255 to reveal and 0 to hide. History tiles are raw immutable tile bytes and are content-addressed
by SHA-256, so commands that share an unchanged 256×256 tile store it once. Empty tiles are represented
as `null` in their raster tile list and have no ZIP member.

Linked embedded layers store a URI as metadata and do not cause runtime network access. An embedded
layer instead names an `embedded` asset. Readers must never fetch a URI automatically.

## Layer common object

Every entry has a discriminating `kind`: `pixel`, `group`, `adjustment`, `fill`, `vector`, `text`, or
`embedded`. It also has:

- `id`, `parentId`, `name`, and `visible`;
- `opacity`, `fillOpacity`, and canonical `blendMode`;
- `locks`: booleans `transparency`, `pixels`, `position`, `all`;
- `colorLabel`: `none`, `red`, `orange`, `yellow`, `green`, `blue`, `violet`, or `gray`;
- `transform`: `origin`, `size`, clockwise degrees `rotation`, `flipX`, `flipY`, and sampling
  (`Nearest`, `Smooth`, or `High quality`);
- optional parameter objects represented explicitly as nullable values: `warp`, `crop`, pixel
  `mask`, `vectorMask`, and `clippedTo`;
- arrays `effects` and `filters`.

`warp` is currently `{kind:"quad", schemaVersion:1, corners:[TL,TR,BR,BL]}` in document pixels.
`crop` contains a local rectangle and feather radius and does not destroy source pixels. A pixel mask
references a mask asset and stores an optional independent transform, plus `linked` and `enabled`.
A vector mask stores Bezier paths with anchor/in/out points, `closed`, `enabled`, and `inverted`.
`clippedTo` is the exact source layer ID; cycles, missing endpoints, groups/adjustments as invalid
sources, and chains of 256 or more are rejected.

Effects are versioned unions: v2 defines `dropShadow`, `stroke`, and `colorOverlay`, all with
`schemaVersion:1` and `enabled`. Live filters are versioned unions: `gaussianBlur`, `motionBlur`,
`noise`, and `lensCorrection`. Unknown schema versions are not interpreted. These engines can be
unavailable while the records still round-trip unchanged.

## Kind-specific objects

- `pixel`: `assetId`, nullable for an unpainted layer.
- `group`: no content asset. Its descendants refer to the group in `parentId`.
- `adjustment`: an `adjustment` discriminated union with `kind`, `schemaVersion:1`, and typed
  `parameters`. Defined kinds are Hue/Saturation (legacy master values plus range, inversion,
  per-range adjustments and band handles), Levels
  (channel and four input/output ranges), Curves (channel and four point arrays), Exposure
  (exposure, offset, gamma), Gradient Map (shadow/highlight RGB and reversed), and Grain (amount,
  size, roughness, seed). There is no open-ended parameter dictionary.
- `fill`: a versioned `solid`, `gradient`, or `pattern` union. Gradients contain ordered offset,
  RGB, and opacity stops. Patterns reference a `pattern` asset and carry scale and angle.
- `vector`: Bezier `paths`, versioned fill and optional stroke style, and nullable `previewAssetId`.
  `sourceShape` preserves editable v1 rectangle/ellipse metadata.
- `text`: Unicode `text`, styled `runs` (range, font family, size, RGB), optional paragraph box,
  alignment, and nullable `previewAssetId`.
- `embedded`: `content` has `mode` (`embedded` or `linked`), media type (`image`, `svg`, `pdf`, or
  `project`), source name, and exactly the applicable `assetId` or `uri`; `previewAssetId` is optional.

Vector, text, and embedded records are editable model/serialization data in version 2. A build that
lacks their render engines uses a saved preview when present and otherwise does not render the layer;
it must not silently rasterize or discard the model.

## Artboards

Artboards are not layers. Each item has `id`, `name`, a document-space `rect`, RGBA background, and
`colorLabel`. Their order is document order. Layer membership remains spatial/hierarchical rather
than being encoded by an artboard parent.

Membership rule (`src/core/artboards.ts`): a top-level layer together with its descendants is one
unit; a top-level layer clipped to or live-masked by another unit joins that unit. A unit's bounds
are the union of its layers' content bounds (alpha-trimmed pixels through the layer transform;
the transform box for vector, text and embedded layers without a rendered cache; folders,
adjustment and fill layers have none). The unit belongs to the last artboard in document order whose
rect contains the centre of those bounds. Units without bounds or outside every artboard are loose
and render into every export region they overlap. An artboard export shows its own members and the
loose units, clipped to its rect, over its background.

Artboard rects are whole pixels inside the canvas (`x, y >= 0`); editors grow the canvas to the
right/bottom to fit them. Readers accept records without `background` (white, opaque) or with an
unknown `colorLabel` (`none`) and drop duplicate ids. A file without artboards exports the whole
canvas.

## Saved history

`history` has `schemaVersion:1`, `enabled`, `retainedByteLimit`, `cursor`, `commands`, and `snapshots`.
Commands have a display `name` and IDs for `before` and `after` snapshots. Commands before `cursor`
are the undo stack; commands at and after it are the redo stack in stored order. A snapshot table maps
each ID to a safe JSON path, active layer, and revision. Snapshot JSON holds document metadata and
layer records plus a raster-to-tile list. Tile IDs refer to `history-tile` assets and are shared by
content hash. The current writer also keeps ordinary encoded raster assets as a portability fallback.

On load, invalid history invalidates the archive rather than partially changing the document.
History is optional; absence means a clean session. `enabled:false` deliberately persists an empty
history setting. Selection, viewport, panel, and collapse state are not saved.

## Versioning and migration

Readers select a decoder using `format` and `version`. Additive optional fields may be introduced
only with specified defaults. A changed meaning, new required field, or incompatible union requires
a new integer format version. Typed subobjects use their own `schemaVersion`; their versions advance
independently. Writers emit only version 2 and the `.fwimg` suggestion.

The following inputs remain read-only migration sources:

- `fernwork-compositor`, version 1 archives (historical `.compositor.zip`): matrices, masks, clipping,
  resolution and exact transforms migrate to the v2 model; missing v2 fields receive neutral defaults.
- Mac `.comp` packages with `com.compositor.project`, versions 1–7: the documented version gates are
  validated and data migrates to v2 in memory. The editor does not write this format.

Migration is automatic and non-destructive. Saving a migrated document creates a new v2 `.fwimg`;
it never overwrites the source format implicitly. The legacy `EditorHandle.getManifest()` API still
returns its version-1 contract projection for host compatibility. Hosts that support the additive
`EditorHandleV2` interface can call `getManifestV2()`.

## Security and privacy

Opening and saving require no network. Readers do not execute content, resolve links, load fonts,
fetch assets, or interpret extension data as code. Implementations must protect against ZIP bombs,
path traversal, excessive allocation, malformed image dimensions, duplicate IDs, cycles, and hash
mismatches. The format contains no telemetry fields.
