// PDFium's FreeText writer can create a DA/DR-only AcroForm without Fields.
// Repair only that empty shell on final export, never in the live document.
// A field-bearing or ambiguous form must never be replaced by an empty tree.
export function completeEmptyAcroFormForExport(pdf, PDFLib) {
  const { PDFArray, PDFDict, PDFName, PDFRawStream } = PDFLib;
  const name = PDFName.of;
  const form = pdf.context.lookup(pdf.catalog.get(name('AcroForm')));
  if (!(form instanceof PDFDict) || form.has(name('Fields')) ||
      !form.has(name('DA')) || !form.has(name('DR')) ||
      form.keys().some(key => !['/DA', '/DR'].includes(String(key)))) return false;

  const seen = new WeakSet();
  let count = 0;
  const safe = (object, depth = 0) => {
    if (!object || typeof object !== 'object' || seen.has(object)) return true;
    if (++count > 100_000 || depth > 64) return false;
    seen.add(object);
    if (object instanceof PDFRawStream) return safe(object.dict, depth + 1);
    if (object instanceof PDFArray) return object.asArray().every(value => safe(value, depth + 1));
    if (!(object instanceof PDFDict)) return true;
    const subtype = String(pdf.context.lookup(object.get(name('Subtype'))) || '');
    const type = String(pdf.context.lookup(object.get(name('Type'))) || '');
    if (object.has(name('FT')) || object.has(name('XFA')) || object.has(name('ByteRange')) ||
        subtype === '/Widget' || type === '/Sig' ||
        (object.has(name('T')) && (object.has(name('Parent')) || object.has(name('Kids'))))) return false;
    return object.values().every(value => safe(value, depth + 1));
  };
  // Enumerating all indirect objects also sees orphan fields; recursion covers
  // inline dictionaries without following cyclic Parent/Page references.
  if (!safe(pdf.catalog) || !pdf.context.enumerateIndirectObjects().every(([, object]) => safe(object))) return false;
  form.set(name('Fields'), pdf.context.obj([]));
  return true;
}
