Owner-side review of the built site (screenshots at 1440 and 360). Content and claims are good — keep them. Fix these
design and copy problems, then rebuild, rerun `node check.mjs` (all gates must pass) and regenerate screenshots.

Common fixes:
1. **Display font only for short titles.** The display face (wordmark font) is only legible for 1–4 short words.
   Every headline longer than ~24 characters or containing a clause (e.g. "Phase 2 features are present; its exit
   gate is still open.", "Images to measured spatial products, offline.", "Implemented does not mean released.",
   "Commitments, with their current status.", "Each file will include its size and SHA-256 digest.") must either be
   shortened to a short display title (≤ 3 words, e.g. "Roadmap.", "Release status.", "Commitments.", "Scope.") with the
   sentence moved into a mono lead paragraph below, or be set in the mono heading style. Keep at most one display
   title per section. Page hero titles: short display title (the product or page name) + a mono lead sentence.
2. **Never break a word inside a heading.** Remove `overflow-wrap: anywhere`/`word-break` from headings and display
   titles; instead size display titles with a clamp that fits the longest word of that title in its container at
   360, 768 and 1440 px (the display faces are very wide: measure). Add a gate: for every element using the display
   font, no word may be split across lines (e.g. compare each word's client rects via Range) and no heading may
   overflow its container.
3. **Numbers and prices are never set in the display font** (the display glyphs for digits are unreadable, e.g. "€0"
   renders as a black block). Prices, counts and statistics use the mono face, bold, large.
4. **No implementation jargon in public copy.** Visitors do not know what a "release manifest", "file controls",
   "gates", "rows", "slices", "hand-off" or "reconciliation" are. Rewrite such sentences in plain language ("There is no
   public download yet. When there is, this page lists the files for Windows and Linux with size and SHA-256
   checksum."). Keep the facts; drop the internals. The README may keep the technical terms.
5. **Empty download state stays short:** one status block per product (status, planned platforms, what the first
   release covers, notify link). Remove sections that only describe what a future download table will contain.
6. Check every page at 360 px after the changes: no clipped titles, no mid-word breaks, cards not overflowing.
berg:work specific:
- **Bergschrift subset is broken:** Latin capitals S, H, I (and possibly others) are missing, so they render in a
  fallback face ("DOCUMEИTs", "THEIЯ", "Image" with a fallback I). Do not subset Bergschrift by page text; ship it
  with full Latin-1 + Latin Extended-A + the Cyrillic block (or unsubset). Add a gate that every character used in
  display-font elements (after text-transform) exists in the font's cmap.
- Mobile wordmark breaks as "beяg:w / oяk". On narrow screens split exactly into "berg:" / "work" (two spans, as in
  the previous version) or fit it on one line; never elsewhere.
- Download page product cards: "BERG:WORK PDF" breaks mid-word — the product name in cards is a short mono/heading
  title, or the display title fits (rule 2).
- Image page: hero title "Layered image editing in an internal desktop build." → display "berg:work Image" (or
  "Image.") + mono lead. "Phase 2 features are present; its exit gate is still open." → rule 1.
- The PDF page's "Known limitations" list is good but make it read as a compact list, not seven cards.
