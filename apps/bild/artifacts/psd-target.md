# PSD read fidelity — target (owner decision 2026-09-26)

**Target: every fixable deviation is fixed.** With the binding measurement rule (M14: pixels come from the product's own
render path, never from the PSD's saved composite; flattened files do not count) the corpus ceiling is
**266/300 = 88.7 %**. The per-file root-cause table is in `artifacts/psd-fidelity.md` (eleventh round and later).

Why not 90 %: 34 of the failing files are structural limits — flat bitmap/indexed/spot-colour files without independent
layer pixels (they cannot count under M14) and Photoshop's own rasteriser behaviour.

## TODO (later, needs the owner's approval first)

- **≥ 90 %** is reachable only with a separate tolerance for four documented text/effect antialiasing-tail files
  (then 270/300 = 90.0 %, once all fixable defects are fixed). Do not introduce such a tolerance without asking the owner
  again. Reference: PRODUCT-PLAN M15.
