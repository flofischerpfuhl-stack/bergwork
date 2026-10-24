# @bergwork/ui — berg:work design base

Tokens, fonts and React components for berg:work Image and berg:work PDF. Structure, measures and behaviour
come from the Himmel:CAD Builder UI lab (`HimmelCAD/apps/builder-ui-lab`, rules in
`HimmelCAD/docs/ui-redesign/UI-REVIEW-REFERENCE.md`, cited below as §); colours and type are berg:work's.

```sh
npm run dev --workspace @bergwork/ui        # demo page (Musterseite) on http://127.0.0.1:5230
npm run typecheck --workspace @bergwork/ui
```

The demo (`demo/`) is a berg:work Image window with mock data: every component in context, light and dark,
round and sharp corners, desktop and phone. It runs no editor code.

## Use

```ts
import '@bergwork/ui/styles.css';           // tokens, fonts, base rules, components
import { TitleBar, SidePanel, TooltipLayer, useAppearance } from '@bergwork/ui';
```

Mount one `TooltipLayer` per page. Set `html[data-theme]` before first paint (see `demo/index.html`) so a
light desktop does not flash dark; `useAppearance` keeps it in step afterwards.

## Rules

- **Type:** Inter for the interface, JetBrains Mono for values (sizes, coordinates, percentages, shortcuts),
  **Bergschrift only in the wordmark** in the title bar. All three ship with the app (SIL OFL 1.1).
- **Colours:** warm stone neutrals; the stone accent of berg:work PDF only where it means something (primary
  button, slider fill, text selection); the site red only in the wordmark. Components read `--bw-*` tokens,
  never hex values.
- **Layout:** islands float over the work area with one gap (`--bw-gap`, 12 px) to each other and the window
  edge; attached things (a menu at its chip) use half. Side panels have a tab rail and no title row and duck
  below a function bar (`--bw-panel-top`). Rows are 28 px, 44 px on touch.
- **States (§3):** an icon never changes with its state; no frame = off, dashed frame = automatic, solid
  frame = on. Only two checkbox kinds: a plain check without a box, and the framed glyph for more states.
  Hover and press are neutral washes; focus rings only for keyboard focus, neutral; text fields show a calm
  frame instead.
- **Menus (§8a):** one row everywhere; checks and glyphs at the row's end; shortcuts quiet on the right;
  width from the content, at most 280 px; submenus open on hover with a safe triangle and flip at the window
  edge; disabled items stay and say why in the tooltip.
- **Fields (§8b):** editable values are always fields, but quiet (fill, no frame; frame on hover and focus);
  fixed choices are dropdowns; computed values are plain text. Number labels can be dragged (`useScrub`).
- **Chips (§8a):** single-choice chips show their value; multi-choice chips show a count (0 included, two
  digits) so they never change size; panel toggles show the frame.
- **Tooltips (§8):** one product tooltip, no browser `title` tooltips; truncated text shows its full text.
- **Appearance (§9):** light / dark / system and round / sharp corners from the title bar.

## Not yet

- Phone layout of the side panels (bottom sheets) and collapse stages of the status bar beyond hiding the
  middle rail.
- A console for messages (the Builder reports in a console, not in toasts).
- Wiring into the editors: berg:work Image (`apps/bild`) and the PDF editor still use their own UI.
