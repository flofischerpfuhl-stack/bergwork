// AcroForm authoring operates on a native document checkpoint. The caller
// commits the returned PDF and its widget projection as one undoable change.
export function normalizeFormDesignerWidgets(value) {
  return Array.isArray(value) ? value.filter(item => item?.pageId && item?.annotation?.fieldName) : null;
}

// PDFium's DISTINCT page duplication preserves byte-string field names. Some
// producers encode /T as UTF-16 while PDF.js and pdf-lib expose the appended
// native suffix with slightly different separator/replacement characters.
// Exact names remain authoritative; this key is only a unique fallback for
// locating that same field across the two decoders.
export function formFieldNameIdentity(value) {
  return String(value || '').normalize('NFKC').replace(/[\s\uFFFD]/gu, '');
}

export function formFieldNamesCompatible(left, right) {
  if (left === right) return true;
  if (!/[\u2028\uFFFD]/u.test(`${left}${right}`)) return false;
  return formFieldNameIdentity(left) === formFieldNameIdentity(right);
}

export async function editPdfForm(PDFLib, bytes, change, { applyValues, values = {} } = {}) {
  const { PDFDocument, PDFName, PDFHexString, PDFDict, StandardFonts, rgb } = PDFLib;
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const form = pdf.getForm();
  if (form.hasXFA()) throw new Error('XFA forms must be converted to AcroForm before designing fields.');
  const annotationRefs = () => pdf.getPages().map(page => page.node.Annots()?.asArray().map(ref => String(ref)) || []);
  const beforeRefs = annotationRefs();
  applyValues?.(pdf, values);
  const wantedRef = String(change.annotationId || '').replace(/^(\d+)R(\d*)$/u, (_, object, gen) => `${object} ${gen || 0} R`);
  const widgetRef = new Map(pdf.context.enumerateIndirectObjects().map(([ref, object]) => [object, ref.toString()]));
  const fields = form.getFields();
  let matchingFields = change.originalName ? fields.filter(field => field.getName() === change.originalName) : [];
  if (!matchingFields.length && change.originalName) {
    const compatible = fields.filter(field => formFieldNamesCompatible(field.getName(), change.originalName));
    if (compatible.length === 1) matchingFields = compatible;
  }
  const existing = matchingFields.find(field => field.acroField.getWidgets().some(widget => widgetRef.get(widget.dict) === wantedRef))
    || (matchingFields.length === 1 ? matchingFields[0] : null);
  if (change.action !== 'create' && !existing) throw new Error('This field is no longer available. Refresh the field list.');
  if (existing && !(existing instanceof PDFLib.PDFTextField || existing instanceof PDFLib.PDFCheckBox ||
    existing instanceof PDFLib.PDFDropdown || existing instanceof PDFLib.PDFOptionList || existing instanceof PDFLib.PDFRadioGroup)) {
    throw new Error('This field type cannot be changed with the form designer.');
  }
  if (change.action === 'delete') {
    // pdf-lib's removeField resolves a widget through its appearance stream
    // and can leave the actual /Annots reference dangling. Remove the exact
    // widget dictionaries from every page before deleting their objects.
    const dictionaries = new Set(existing.acroField.getWidgets().map(widget => widget.dict));
    dictionaries.add(existing.acroField.dict);
    const refs = new Set(pdf.context.enumerateIndirectObjects()
      .filter(([, object]) => dictionaries.has(object)).map(([ref]) => ref.toString()));
    for (const page of pdf.getPages()) {
      const annots = page.node.Annots();
      for (let index = (annots?.size() || 0) - 1; index >= 0; index -= 1) {
        if (refs.has(String(annots.get(index)))) annots.remove(index);
      }
    }
    form.acroForm.removeField(existing.acroField);
    for (const [ref] of pdf.context.enumerateIndirectObjects()) if (refs.has(ref.toString())) pdf.context.delete(ref);
    form.markFieldAsClean(existing.ref);
  } else {
    const name = String(change.name || '').trim();
    if (!name || name.length > 200 || /[\x00-\x1f]/u.test(name)) throw new Error('Enter a field name of 1–200 characters.');
    const existingName = existing?.getName?.() || change.originalName || '';
    const parent = existingName.includes('.') ? existingName.slice(0, existingName.lastIndexOf('.') + 1) : '';
    if (!name.startsWith(parent) || name.slice(parent.length).includes('.')) throw new Error('Keep the existing field group prefix; the field name itself cannot contain a dot.');
    const duplicate = form.getFieldMaybe(name);
    if (name !== existingName && duplicate) throw new Error('A field with this name already exists.');
    const page = pdf.getPage(change.pageIndex);
    const rect = change.rect;
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width < 2 || rect.height < 2) {
      throw new Error('Use a field width and height of at least 2 pt.');
    }
    const options = [...new Set(String(change.options || '').split('\n').map(value => value.trim()).filter(Boolean))];
    let field = existing;
    let regenerateAppearance = !existing;
    let unchangedWidgetAppearances = [];
    const font = pdf.embedStandardFont(StandardFonts.Helvetica);
    if (!field) {
      const creators = { text: 'createTextField', multiline: 'createTextField', checkbox: 'createCheckBox', dropdown: 'createDropdown', radio: 'createRadioGroup' };
      const creator = creators[change.kind];
      if (!creator) throw new Error('Choose a supported field type.');
      if (['dropdown', 'radio'].includes(change.kind) && options.length < 2) throw new Error('Enter at least two distinct choices, one per line.');
      if (change.kind === 'radio' && options.length > 30) throw new Error('A radio group can contain up to 30 choices.');
      field = form[creator](name);
      if (change.kind === 'multiline') field.enableMultiline();
      if (change.kind === 'dropdown') { field.setOptions(options); field.clear(); }
      const appearance = { ...rect, borderWidth: 1, borderColor: rgb(0.45, 0.48, 0.52), backgroundColor: rgb(1, 1, 1), textColor: rgb(0.1, 0.12, 0.15), font, rotate: page.getRotation() };
      // Explicit rectangles in PDF coordinates avoid pdf-lib's half-border
      // expansion. Radio choices have one independently editable widget each.
      if (change.kind === 'radio') {
        if (change.radioRects?.length !== options.length) throw new Error('The radio choices do not fit on this page.');
        options.forEach((option, index) => {
          field.addOptionToPage(option, page, { ...appearance, ...change.radioRects[index] });
          const widget = field.acroField.getWidgets().at(-1);
          widget.setRectangle(change.radioRects[index]);
          // Use meaningful on-state names as well as /Opt export values.
          // PDF.js exposes the former when filling a radio widget.
          const oldOn = widget.getOnValue();
          for (const state of ['N', 'D', 'R']) {
            const appearance = widget.dict.lookup(PDFName.of('AP'), PDFDict).lookupMaybe(PDFName.of(state), PDFDict);
            if (appearance?.has(oldOn)) {
              appearance.set(PDFName.of(option), appearance.get(oldOn));
              if (oldOn.decodeText() !== option) appearance.delete(oldOn);
            }
          }
        });
      } else {
        field.addToPage(page, appearance);
        field.acroField.getWidgets().at(-1).setRectangle(rect);
      }
    } else {
      if (name !== existingName) field.acroField.setPartialName(name.slice(parent.length));
      const widgets = field.acroField.getWidgets();
      const widget = widgets.find(item => widgetRef.get(item.dict) === wantedRef);
      // A merged terminal field is itself the page widget.
      const target = widget || (widgets.length === 1 ? widgets[0] : null);
      if (!target) throw new Error('Select a specific widget before changing its position.');
      unchangedWidgetAppearances = widgets.filter(widget => widget !== target).map(widget => ({
        widget, appearance: widget.dict.lookupMaybe(PDFName.of('AP'), PDFDict)?.clone(), defaultAppearance: widget.dict.get(PDFName.of('DA')),
      }));
      const oldRect = target.getRectangle();
      regenerateAppearance = Math.abs(oldRect.width - rect.width) > 0.001 || Math.abs(oldRect.height - rect.height) > 0.001;
      target.setRectangle(rect);
      if (field instanceof PDFLib.PDFDropdown || field instanceof PDFLib.PDFOptionList) {
        if (options.length < 2) throw new Error('Enter at least two distinct choices, one per line.');
        // Keep export/display mappings unless the user actually changed them.
        if (change.optionsChanged) {
          regenerateAppearance = true;
          unchangedWidgetAppearances = [];
          const selected = field.getSelected();
          field.setOptions(options);
          const kept = selected.filter(value => options.includes(value));
          if (kept.length) field.select(kept); else field.clear();
        }
      }
    }
    if (change.required) field.enableRequired(); else field.disableRequired();
    const tooltip = String(change.tooltip || '').trim();
    if (tooltip) field.acroField.dict.set(PDFName.of('TU'), PDFHexString.fromText(tooltip));
    else field.acroField.dict.delete(PDFName.of('TU'));
    if (field instanceof PDFLib.PDFTextField) {
      if (change.multiline ?? change.kind === 'multiline') field.enableMultiline(); else field.disableMultiline();
      if (!existing) field.setFontSize(12);
    }
    if (regenerateAppearance) {
      if (field instanceof PDFLib.PDFTextField || field instanceof PDFLib.PDFDropdown || field instanceof PDFLib.PDFOptionList) field.updateAppearances(font);
      else field.defaultUpdateAppearances();
      for (const { widget, appearance, defaultAppearance } of unchangedWidgetAppearances) {
        if (appearance) widget.dict.set(PDFName.of('AP'), appearance); else widget.dict.delete(PDFName.of('AP'));
        if (defaultAppearance) widget.dict.set(PDFName.of('DA'), defaultAppearance); else widget.dict.delete(PDFName.of('DA'));
      }
    }
    form.markFieldAsClean(field.ref);
  }
  const afterRefs = annotationRefs();
  const annotationIndexMaps = beforeRefs.map((refs, pageIndex) => refs.map(ref => afterRefs[pageIndex].indexOf(ref)));
  return {
    bytes: new Uint8Array(await pdf.save({ useObjectStreams: false, updateFieldAppearances: false })),
    annotationIndexMaps,
  };
}

export function remapFormSnapshotBindings(bindings, maps) {
  return (bindings || []).flatMap(binding => {
    if (binding.kind !== 'annotation') return [binding];
    const annotationIndex = maps[binding.pageIndex]?.[binding.locator?.annotationIndex];
    return Number.isInteger(annotationIndex) && annotationIndex >= 0
      ? [{ ...binding, locator: { ...binding.locator, annotationIndex } }] : [];
  });
}
