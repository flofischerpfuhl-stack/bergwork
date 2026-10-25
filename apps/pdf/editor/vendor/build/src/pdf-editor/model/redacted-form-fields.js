// Form fields under a redaction. The redaction export (pdf-editor/engine/
// redaction-export.js) hides every form widget under a mark and tags it with
// REDACTED_WIDGET_FLAG, because PDFium cannot edit the AcroForm field tree.
// After the entered values are written, the shell removes the tagged widgets,
// every field left without widgets (with its value) and then every object
// nothing refers to any more: pdf-lib writes all objects of its context, so a
// removed field's value or appearance stream would otherwise stay in the file.
import { REDACTED_WIDGET_FLAG } from '../engine/redaction-export.js';

/** Cheap gate on the bytes: without a widget there is nothing to remove. */
export function pdfBytesMayHaveRedactedWidgets(bytes) {
  const probe = bytes.subarray(0, Math.min(bytes.length, 64 << 20));
  return new TextDecoder('latin1').decode(probe).includes('/Widget');
}

/** Returns the number of widgets removed; 0 leaves `pdf` unchanged. */
export function removeRedactedFormFieldsFromPdf(PDFLib, pdf) {
  const name = key => PDFLib.PDFName.of(key);
  const lookup = value => (value instanceof PDFLib.PDFRef ? pdf.context.lookup(value) : value);
  const removed = new Set();
  for (const page of pdf.getPages()) {
    const annots = lookup(page.node.get(name('Annots')));
    if (!(annots instanceof PDFLib.PDFArray)) continue;
    for (let index = annots.size() - 1; index >= 0; index -= 1) {
      const annotation = lookup(annots.get(index));
      if (!(annotation instanceof PDFLib.PDFDict) || String(annotation.get(name('Subtype'))) !== '/Widget') continue;
      const flags = lookup(annotation.get(name('F')));
      if (!(flags instanceof PDFLib.PDFNumber) || !(flags.asNumber() & REDACTED_WIDGET_FLAG)) continue;
      annots.remove(index);
      removed.add(annotation);
    }
  }
  if (!removed.size) return 0;
  const prune = array => {
    for (let index = array.size() - 1; index >= 0; index -= 1) {
      const node = lookup(array.get(index));
      if (!(node instanceof PDFLib.PDFDict)) continue;
      if (removed.has(node)) { array.remove(index); continue; }
      const kids = lookup(node.get(name('Kids')));
      if (!(kids instanceof PDFLib.PDFArray) || !kids.size()) continue;
      prune(kids);
      // A field whose every widget was redacted goes, with its value.
      if (!kids.size()) array.remove(index);
    }
  };
  const acroForm = lookup(pdf.catalog.get(name('AcroForm')));
  const fields = acroForm instanceof PDFLib.PDFDict ? lookup(acroForm.get(name('Fields'))) : null;
  if (fields instanceof PDFLib.PDFArray) prune(fields);
  deleteUnreachableObjects(PDFLib, pdf);
  return removed.size;
}

function deleteUnreachableObjects(PDFLib, pdf) {
  const { trailerInfo } = pdf.context;
  const reachable = new Set();
  const stack = [trailerInfo.Root, trailerInfo.Info, trailerInfo.Encrypt].filter(Boolean);
  while (stack.length) {
    const value = stack.pop();
    if (value instanceof PDFLib.PDFRef) {
      const key = value.toString();
      if (reachable.has(key)) continue;
      reachable.add(key);
      const target = pdf.context.lookup(value);
      if (target) stack.push(target);
    } else if (value instanceof PDFLib.PDFDict) {
      for (const [, entry] of value.entries()) stack.push(entry);
    } else if (value instanceof PDFLib.PDFArray) {
      for (let index = 0; index < value.size(); index += 1) stack.push(value.get(index));
    } else if (value instanceof PDFLib.PDFStream) {
      stack.push(value.dict);
    }
  }
  for (const [ref] of pdf.context.enumerateIndirectObjects()) {
    if (!reachable.has(ref.toString())) pdf.context.delete(ref);
  }
}
