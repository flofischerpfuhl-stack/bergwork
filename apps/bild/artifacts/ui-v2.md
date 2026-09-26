# UI v0.2 — floating chrome in the Fernwork PDF design language

Branch `p3-uiv2` (from integration `baa171f`). The owner's brief: take over the new Fernwork PDF UI (reference: the
uncommitted working tree `/tmp/fw-ui`, owner screenshot `claude-tools/shots/uiv2/REFERENCE-fernwork-pdf-owner.png`).
Non-negotiable: the panels and bars float over a full-bleed canvas. Everything else moves towards Fernwork PDF unless
it would get in the way of the work or confuse people coming from Photoshop.

## What changed

### Layout: canvas underneath, chrome on top

- **The canvas fills the whole editor.** Both canvases (the WebGL composite and the 2D overlay) reach from edge to edge.
  Top bar, options bar, tool palette, panel stack and status bar float over them as rounded cards, each with a border
  and a soft shadow.
- **`canvas-pane` is the uncovered work area** between the chrome, so it no longer matches the canvas surface:
  - View coordinates, Fit, 100 %, the zoom buttons, rulers, the welcome card, drop highlight and lock notice all refer to
    it.
  - `CanvasView` draws the view into the larger surface with the offset of the work area (CSS variables
    `--cmp-pane-top/left/right/bottom`, measured from the DOM every frame). View coordinates stay exactly what they
    were, so tools, text input placement, drag-and-drop points and tests that map document to view are unaffected.
  - As a result, **Fit puts the image in the work area and never under the panels**, and rulers sit at its edge: just
    below the options bar and right of the tool palette. Marching ants, transform handles and guides reach under the
    chrome when the image is panned there.
- **Pointer events:**
  - Every chrome card is its own element above the canvas, so clicks, drags and wheel events on it never reach the
    canvas.
  - The canvas keeps receiving pointer input in the gaps between the cards. Leaving the canvas onto a card ends the
    hover (the brush cursor disappears).
  - A tool button click no longer takes the keyboard focus from the editor (see Tab below).
- **Top bar**, from left to right:
  - Menus (Photoshop order and names).
  - New canvas, then the document tabs.
  - Open / Save / Export As.
  - Undo / Redo.
  - A **Panels** toggle, green-tinted while the panel stack is open, like Fernwork PDF's Layers button.
  - Below 1180 px the file buttons go (they are in the File menu) and Panels becomes an icon. Below 900 px the menus fold
    into one menu button, as on phones.
- **Options bar:**
  - It stays where Photoshop has it, under the menu bar and above tools and panels. It is as wide as its content, up to
    the full width.
  - Long bars (Transform) scroll sideways and fade out at the end.
- **Tool palette (left):**
  - A floating vertical card with the tools and foreground/background colours.
  - Editors too short for one column get two columns, as Photoshop's double-column toolbar does.
  - The active tool is the filled accent.
- **Panel stack (right):**
  - Layers, History and module tabs (Colour) in one floating card. The tabs are a segmented control (Fernwork PDF's
    Properties | Layers), and the layer count is a badge on the Layers tab.
  - A × closes the stack. The Panels button or Shift+Tab reopens it, and the state persists.
  - Drag the left edge to resize (220–380 px). The width is a CSS variable, so the panel and the work area follow the
    drag without React renders.
- **Status bar (bottom, centred between palette and panels):**
  - Zoom − / value / + / Fit / 100 %, the document size and colour facts, and the tool hint.
  - Zoom moved here from the top bar: Fernwork PDF has zoom in its bottom bar, and Photoshop shows it at the bottom left.
- **Adjustment, filter and Layer Style panels** open as floating cards next to the panel stack, below the options bar,
  as Photoshop's Properties flyout does. They stay movable and non-modal. The colour picker, a secondary panel, opens
  beside them.
- **Tab / Shift+Tab (Photoshop):**
  - Tab hides tools, options bar, panels and status bar. The top bar with menus and tabs stays, as in Photoshop.
  - Shift+Tab hides only the panels.
  - Fit follows the larger work area.
  - Both are in the View menu with their shortcuts.
  - Tab only toggles while the keyboard is on the editor or the canvas. Inside the chrome it still moves focus, for
    keyboard access.
- **Phones and small windows (compact layouts, same breakpoints as before):**
  - Floating top bar and options bar at the top, and a floating tool strip at the bottom (at the left in landscape).
  - The Layers sheet is a floating card above the strip. Adjustment panels are cards in the work area.
  - A pre-existing bug is fixed: the welcome card overflowed on phones.
- **Tablets (coarse pointer, desktop layout):** controls grow from 32 to 38 px and bars from 44 to 50 px, as Fernwork PDF
  does for touch.

### Visual language (from `/tmp/fw-ui` `pdf-tools-theme.css`)

| | Fernwork PDF | Editor v0.2 |
| --- | --- | --- |
| Surfaces (dark) | panel #050505, panel-2 #0b0b0b, panel-3 #101010 | #070707 (97 % opaque, see below), #0d0d0d, #121212 |
| Surfaces (light) | #fff, #f8fafc, #eef2f7 | same |
| Border | rgba(255,255,255,.12) / rgba(15,23,42,.14) | same |
| Text / muted | #f5f5f5 / #a1a1aa; light #0f172a / #64748b | same |
| Accent | #15803d, strong #16a34a | same, as tokens; bright variant #22c55e for text on dark |
| Bar | 48 px, radius 12, padding 5, shadow 0 10 28 rgba(0,0,0,.35) | 44 px (32 px controls), radius 12, same shadow |
| Buttons | 36 px, radius 8, bordered, panel-2, 12 px/700 | 32 px, radius 8, bordered, panel-2, 12 px/700 |
| Active tool / toggle on / tabs | solid accent / accent tint + green text / raised neutral segment | same three levels |
| Menus/popovers | radius 12, padding 6, items radius 8, hover tint | same (was: blue-filled hover, macOS style) |
| Font | Geist/Inter (Google Fonts) | `Inter, Geist, system…` stack, no web font download |
| Icons | Lucide, stroke 2 at 16 px | own line icons, stroke 2 at ≤16 px and 1.8 above |
| Blur | none on chrome | none |

## Decisions and compromises (with the Photoshop-user reasoning)

1. **Options bar at the top, not above the bottom toolbar.**
   - Fernwork PDF floats tool options above its bottom toolbar.
   - Photoshop users look for tool options directly under the menu bar, and the Transform inspector is far too wide for
     a centred pill.
   - So the options bar keeps Photoshop's place and only takes on Fernwork PDF's look.
2. **Tools in a vertical palette on the left, not a bottom pill bar.**
   - Eighteen tools, each with a single-key shortcut, is Photoshop muscle memory.
   - Fernwork PDF's five grouped tools would hide tools behind popovers.
3. **Menu bar kept, as text menus.**
   - Fernwork PDF has a "Functions" drawer.
   - An image editor with File/Edit/Image/Layer/Select/Filter/View cannot drop its menus without breaking every
     Photoshop tutorial. Menus fold into one button only below 900 px, as on phones.
4. **Document tabs kept, not a document dropdown.**
   - Photoshop users switch documents with tabs.
   - The tabs take the Fernwork PDF chip style.
5. **Canvas background stays a solid neutral grey (#1b1b1b dark, #e2e6ec light), not Fernwork PDF's checkerboard.**
   - In an image editor a checkerboard means transparent pixels.
   - Around the image it would be misread, and a neutral surround is needed to judge tones.
6. **Canvas overlays stay blue (`--cmp-canvas-accent`, #0a84ff); the interface is green.**
   - Transform handles, snapping lines and the pen/text/artboard overlays keep a colour that is clearly not a UI button.
   - It is close to Photoshop's.
7. **Denser than Fernwork PDF:** 32 px controls and 44 px bars on a mouse (Fernwork PDF: 36/48); touch keeps larger
   targets. An image editor needs the canvas space, and Photoshop is denser still.
8. **Chrome surfaces are 97 % opaque instead of 100 %.**
   - Chromium treats an opaque *scrolling* box (tool palette, options bar) as covering its whole layer, shadow included,
     and then skips painting the canvas under the shadow. That left transparent seams in the screenshots.
   - A hair of translucency avoids it and cannot be seen.
   - No backdrop blur (Fernwork PDF has none either), which also keeps painting over a live WebGL canvas cheap.
9. **Font:**
   - Fernwork PDF loads Geist from Google Fonts. The editor sends no requests (no telemetry, offline Tauri), so it uses
     `Inter, Geist, system…`.
   - Where Inter or Geist is installed, or the Fernwork site has already loaded it, it looks the same. Otherwise it falls
     back to the system UI font.
10. **Tab vs. keyboard access.**
    - Photoshop toggles the chrome with Tab everywhere except in text fields.
    - Here Tab toggles only while the keyboard is on the editor or canvas. A mouse click on a tool keeps it there. Inside
      the panels Tab still walks the controls.
11. **Status facts moved from a full-width status strip to a centred floating bar**, with the zoom controls, as the
    Fernwork PDF toolbar does. Photoshop's status bar is also where zoom lives.

## Embedding and theming (berg:work Image and other hosts)

berg:work embeds the editor as a Tauri app, with its own 38 px title bar and VS Code Dark/Light Modern surfaces with a
warm stone-grey accent. The editor guarantees the following.

1. **Colours are CSS custom properties only.**
   - Every interface colour comes from a `--cmp-*` token on the editor root, including the green accent and the
     danger, warning and success colours. No component rule hard-codes a theme colour.
   - A stable hook for hosts: the root element has the class `fw-image-editor` and `data-theme="dark|light"`. A host
     overrides tokens with a more specific selector, for example
     `.host .fw-image-editor { --cmp-accent: #78716c; }` and
     `.host .fw-image-editor[data-theme="light"] { --cmp-panel: …; }`.
   - Derived tokens (`--cmp-accent-soft`, `--cmp-accent-tint`) are computed from `--cmp-accent-hover` on the same element,
     so they follow an overridden accent.
   - Literal colours remain only where they *are* content, not theme:
     - colour-label chips, photo-filter presets, the hue ramp and swatch rims of the colour picker;
     - the transparency checkerboard of layer thumbnails;
     - temperature/tint tracks and the black-to-white output ramp.
2. **Theme switchable from outside.**
   - `mountEditor(root, { theme: 'dark' | 'light' })` sets the start theme.
   - The host page's `html[data-theme="light|dark"]` overrides it **live**: the editor watches the attribute and
     re-themes without a remount, including the canvas surround (`--cmp-canvas-bg` is fed to the WebGL/software present
     pass).
   - Without the attribute the mount option applies.
   - Both themes are complete; see the light screenshots.
3. **Fills the mount element.**
   - The editor is `width: 100%; height: 100%` of its mount element, with nothing sized to 100vw/100vh.
   - All chrome and the Fit insets are relative to the editor's box (absolute positioning inside it). Menus clamp to the
     editor's box, not the window.
   - Popovers (menus, the brush/type/shape popovers) are `position: fixed` at their anchor's on-screen position. A host
     must therefore not put a CSS `transform`/`filter` on an ancestor of the mount element.
4. **No window chrome in the top bar.** No title and no drag region. The host's title bar handles window dragging.

**Tokens** (defaults for dark / light in `src/ui/editor.module.css`):

- Surfaces:
  - `--cmp-canvas-bg`
  - `--cmp-panel`, `--cmp-panel-2`, `--cmp-panel-3`
  - `--cmp-raised`, `--cmp-surface`, `--cmp-bg`
- Controls:
  - `--cmp-control`, `--cmp-control-hover`, `--cmp-control-active`
  - `--cmp-segment-on`
  - `--cmp-border`, `--cmp-border-strong`, `--cmp-hairline`
- Text: `--cmp-text`, `--cmp-text-secondary`, `--cmp-text-tertiary`
- Accent:
  - `--cmp-accent`, `--cmp-accent-hover`, `--cmp-accent-strong`, `--cmp-accent-contrast`
  - `--cmp-accent-soft`, `--cmp-accent-tint` (derived)
  - `--cmp-canvas-accent` (canvas overlays)
- Status colours: `--cmp-danger`, `--cmp-warning`, `--cmp-success`
- Shadows and overlays: `--cmp-shadow`, `--cmp-bar-shadow`, `--cmp-raised-shadow`, `--cmp-overlay`
- Content surfaces:
  - `--cmp-thumb-bg`, `--cmp-preview-bg`, `--cmp-plot-bg` (histogram, curves)
  - `--cmp-checker-a`, `--cmp-checker-b` (export preview)
  - `--cmp-toast-bg`, `--cmp-toast-text`
- Type: `--cmp-font`
- Geometry:
  - `--cmp-radius`, `--cmp-radius-control`
  - `--cmp-inset`, `--cmp-gap`
  - `--cmp-control-size`, `--cmp-bar`, `--cmp-status-bar`, `--cmp-rail-w`, `--cmp-panel-w`
  - `--cmp-pane-*`, which is computed and read by the canvas.

Demo (host page with a 38 px dummy title bar, `html[data-theme]`, and a stone-grey override of `--cmp-*` tokens only):
`claude-tools/shots/uiv2/host-demo-bergwork-light-stone-accent.png`, `…-dark-stone-accent.png` and
`…-live-switch-to-dark.png` (the host flips `data-theme`; the same editor instance follows). Script:
`claude-tools/shots/uiv2/tool/host-demo.mjs`.

## Screenshots

All in `/home/oem/.local/share/fernwork-compositor-lab/claude-tools/shots/uiv2/`:

- `before/before-<size>-<de|en>-<state>.png`: the v0.1 UI.
- `after-<size>-<de|en>-<state>.png`: v0.2, dark.
- `after-…-light.png`: v0.2, light (German).
- Sizes: `desktop-1440` (1440×900), `desktop-1920` (1920×1080), `tablet-768` (768×1024, touch), `phone-390` (390×844, touch,
  DPR 2).
- States: `1-empty`, `2-image-layers`, `2b-layers-sheet` (phone), `3-dialog-export`, `4-adjustment` (Curves).
- `side-by-side-*.png`: Fernwork PDF reference next to v0.2 (notes in `SIDE-BY-SIDE.md`).
- `host-demo-*.png`: the embedding demo.
- Tools: `tool/shots.mjs` (the tour, `SHOT_THEME=light` for the light set), `tool/host-demo.mjs`, `tool/alpha.py`
  (fails on transparent pixels, which is how the scroller seam was found).

## Tests

TEST_RESULTS

## Open points

OPEN_POINTS
