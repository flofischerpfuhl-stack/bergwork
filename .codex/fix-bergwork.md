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
