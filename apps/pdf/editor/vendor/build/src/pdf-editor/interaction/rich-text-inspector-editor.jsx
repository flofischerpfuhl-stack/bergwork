import React, { useEffect, useMemo, useRef, useState } from 'react';
import { STEP_COMMIT_DELAY_MS } from './geometry-properties.jsx';
import { InspectorSelect, PropSection } from './inspector-controls.jsx';
import {
  applyCharacterFormatting,
  applyCharacterRgbFormatting,
  characterColorWithRgb,
  createRichTextDocument,
  replaceRichText,
  resolveTypingStyle,
} from '../model/rich-text-document.js';
import {
  graphemeSelection,
  matchingFontFace,
  selectedCharacterState,
  textareaReplacement,
} from './rich-text-inspector-state.js';
import {
  libraryFontById,
  libraryFace,
  libraryFontIdFromOption,
} from './bundled-font-library.js';
import {
  buildPdfFontOptionGroups,
  PDF_STANDARD_FONT_OPTIONS,
} from './font-selector-options.js';
import { base14RichResources } from '../text/base14-rich-frame.js';

const selectionFrom = (node, text) => graphemeSelection(
  text, node?.selectionStart ?? 0, node?.selectionEnd ?? 0,
);

const documentContentIdentity = document => JSON.stringify({
  text: document?.text,
  runs: document?.runs,
  paragraphs: document?.paragraphs,
  defaultCharacterStyle: document?.defaultCharacterStyle,
  defaultParagraphStyle: document?.defaultParagraphStyle,
});

const LOCAL_HISTORY_MAX_BYTES = 2 * 1024 * 1024;
const LOCAL_HISTORY_MAX_ENTRIES = 100;
const snapshotBytes = snapshot => JSON.stringify(snapshot).length * 2;

// Sizes keep float precision internally; show at most two decimals.
function displaySize(value) {
  const number = Number(value);
  return Number.isFinite(number) ? String(Math.round(number * 100) / 100) : '';
}

function standardRichResource(option) {
  const face = String(option?.pdf || '').toLowerCase();
  const family = face.includes('times') ? 'Times' : face.includes('courier') ? 'Courier' : 'Helvetica';
  const weight = face.includes('bold') ? '700' : '400';
  const style = face.includes('italic') ? 'italic' : face.includes('oblique') ? 'oblique' : 'normal';
  return base14RichResources().find(resource => resource.family === family &&
    resource.weight === weight && resource.style === style) || null;
}

function richStandardOptionValue(option) {
  return `standard:${option.id}`;
}

export function RichTextInspectorEditor({ document, availableFontResources = [], onCommit, onUploadFont,
  onRequestFontFamily, onRequestHistory,
  externalWholeTextControls = false, disabled = false, textExtras = null, fontExtras = null,
  textSectionTitle = 'Text', fontSectionTitle = 'Font', preserveStandardTraits = true,
  // berg:work mini toolbar: only the character-formatting row, every change committed at once, and the range a
  // canvas text editor has selected ({ text, start, end } in UTF-16 offsets) as the target instead of this editor's
  // own textarea. `compactExtras` follow the row (paragraph alignment).
  compact = false, externalSelection = null, compactExtras = null, onBeforeCompactCommit = null }) {
  const [draft, setDraft] = useState(document);
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const [typingPatch, setTypingPatch] = useState({});
  const [compositionText, setCompositionText] = useState(null);
  const [sizeDraft, setSizeDraft] = useState(null);
  const [commitPending, setCommitPending] = useState(false);
  const [fontLoading, setFontLoading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [historyNotice, setHistoryNotice] = useState('');
  const [textSelectionActive, setTextSelectionActive] = useState(false);
  const textareaRef = useRef(null);
  const baselineRef = useRef(document);
  const draftRef = useRef(document);
  const selectionRef = useRef(selection);
  const beforeInputRef = useRef(null);
  const focusedRef = useRef(false);
  const textSelectionActiveRef = useRef(false);
  const cancelledRef = useRef(false);
  const composingRef = useRef(false);
  const pendingCompositionBlurRef = useRef(false);
  const compositionTextRef = useRef(null);
  const sizeDraftRef = useRef(null);
  const sizeStepTimerRef = useRef(0);
  const fontPickerOpenRef = useRef(false);
  const finishSizeRef = useRef(null);
  useEffect(() => () => window.clearTimeout(sizeStepTimerRef.current), []);
  const commitPendingRef = useRef(false);
  const fontLoadingRef = useRef(false);
  const uploadEpochRef = useRef(0);
  const uploadEquivalentIdentityRef = useRef(null);
  const undoRef = useRef([]);
  const redoRef = useRef([]);
  const lastTextMutationRef = useRef(null);
  const historySequenceRef = useRef(0);
  const expectedInputSelectionRef = useRef(null);

  useEffect(() => () => { uploadEpochRef.current += 1; }, []);

  useEffect(() => {
    const incomingIdentity = documentContentIdentity(document);
    const baselineIdentity = documentContentIdentity(baselineRef.current);
    if (incomingIdentity === baselineIdentity) {
      if (uploadEquivalentIdentityRef.current && uploadEquivalentIdentityRef.current !== incomingIdentity) {
        uploadEquivalentIdentityRef.current = null;
      }
      return;
    }
    // Registering a font updates the parent catalogue before the rich-text
    // commit advances this editor's baseline. Ignore that equivalent pre-upload
    // document until the parent supplies the accepted committed document.
    if (incomingIdentity === uploadEquivalentIdentityRef.current) return;
    uploadEquivalentIdentityRef.current = null;
    uploadEpochRef.current += 1;
    baselineRef.current = document;
    draftRef.current = document;
    setDraft(document);
    setTypingPatch({});
    fontLoadingRef.current = false;
    setFontLoading(false);
    setUploadError('');
    textSelectionActiveRef.current = false;
    setTextSelectionActive(false);
    undoRef.current = [];
    redoRef.current = [];
    lastTextMutationRef.current = null;
    setHistoryNotice('');
    const end = document.text.length;
    selectionRef.current = { start: end, end };
    setSelection(selectionRef.current);
  }, [document]);

  // A range selected in the canvas editor is the formatting target while its text is the committed text; typed but
  // uncommitted text has no rich-text offsets yet, so it formats the whole frame only after the edit is applied.
  const externalRangeKey = externalSelection
    ? `${externalSelection.start}:${externalSelection.end}:${externalSelection.text}` : '';
  const externalSelectionStale = Boolean(externalSelection) && externalSelection.text !== draft.text;
  useEffect(() => {
    if (!compact) return;
    const usable = externalSelection && externalSelection.text === draftRef.current.text &&
      externalSelection.end > externalSelection.start;
    textSelectionActiveRef.current = Boolean(usable);
    setTextSelectionActive(Boolean(usable));
    selectionRef.current = usable
      ? graphemeSelection(draftRef.current.text, externalSelection.start, externalSelection.end)
      : { start: 0, end: draftRef.current.text.length };
    setSelection(selectionRef.current);
    // externalRangeKey stands for the selection and its text.
  }, [compact, externalRangeKey, draft.text, document]); // eslint-disable-line react-hooks/exhaustive-deps

  const typingStyle = useMemo(
    () => resolveTypingStyle(draft, selection, typingPatch),
    [draft, selection, typingPatch],
  );
  const formattingSelection = textSelectionActive
    ? selection
    : { start: 0, end: draft.text.length };
  const state = selectedCharacterState(draft, formattingSelection, typingStyle);
  const displayText = compositionText ?? draft.text;
  const fontResourcePool = useMemo(() => {
    const resources = new Map();
    for (const resource of [...draft.fontResources, ...availableFontResources]) {
      if (resource?.resourceId && resource?.family && !resources.has(resource.resourceId)) resources.set(resource.resourceId, resource);
    }
    return [...resources.values()];
  }, [draft.fontResources, availableFontResources]);
  const documentFamilies = [...new Set(fontResourcePool
    .filter(resource => resource.kind !== 'base14')
    .map(resource => resource.family))];
  const fontOptionGroups = buildPdfFontOptionGroups({
    allowLibrary: true,
    documentOptions: documentFamilies.map(family => ({ value: family, label: family })),
    standardValue: richStandardOptionValue,
  });
  const selectedStandardOption = PDF_STANDARD_FONT_OPTIONS.find(option =>
    standardRichResource(option)?.resourceId === state.resourceId);
  const fontPickerValue = selectedStandardOption
    ? richStandardOptionValue(selectedStandardOption)
    : state.family ?? '';

  const rememberSelection = node => {
    const next = selectionFrom(node, draftRef.current.text);
    if (node && (node.selectionStart !== next.start || node.selectionEnd !== next.end)) {
      node.setSelectionRange(next.start, next.end);
    }
    const previous = selectionRef.current;
    const expected = expectedInputSelectionRef.current;
    const followsInput = expected && next.start === expected.start && next.end === expected.end;
    expectedInputSelectionRef.current = null;
    if (next.start !== previous.start || next.end !== previous.end) {
      setTypingPatch({});
      if (!followsInput) lastTextMutationRef.current = null;
    }
    selectionRef.current = next;
    setSelection(next);
  };
  const restoreSelection = () => requestAnimationFrame(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.focus();
    node.setSelectionRange(selectionRef.current.start, selectionRef.current.end);
  });
  const currentSnapshot = () => ({
    document: draftRef.current,
    selection: { ...selectionRef.current },
    typingPatch: { ...typingPatch },
  });
  const pushBounded = (stack, snapshot) => {
    const bytesForEntry = snapshotBytes(snapshot);
    if (bytesForEntry > LOCAL_HISTORY_MAX_BYTES) {
      setHistoryNotice('Local rich-text undo is unavailable for this unusually large text frame. Apply or cancel the edit before using document Undo.');
      return false;
    }
    const entry = { ...snapshot, bytes: bytesForEntry, sequence: historySequenceRef.current += 1 };
    stack.push(entry);
    const totalEntries = () => undoRef.current.length + redoRef.current.length;
    const totalBytes = () => [...undoRef.current, ...redoRef.current]
      .reduce((total, item) => total + item.bytes, 0);
    while (totalEntries() > LOCAL_HISTORY_MAX_ENTRIES || totalBytes() > LOCAL_HISTORY_MAX_BYTES) {
      const oldestUndo = undoRef.current[0];
      const oldestRedo = redoRef.current[0];
      if (!oldestRedo || (oldestUndo && oldestUndo.sequence < oldestRedo.sequence)) undoRef.current.shift();
      else redoRef.current.shift();
    }
    return true;
  };
  const recordLocalMutation = (kind, group = false, groupStart = null) => {
    const now = Date.now();
    const last = lastTextMutationRef.current;
    redoRef.current = [];
    if (!(group && last?.kind === kind && last.afterCaret === groupStart && now - last.time < 750)) {
      pushBounded(undoRef.current, currentSnapshot());
    }
    lastTextMutationRef.current = { kind, time: now, afterCaret: null };
  };
  const restoreSnapshot = entry => {
    draftRef.current = entry.document;
    selectionRef.current = graphemeSelection(
      entry.document.text, entry.selection.start, entry.selection.end,
    );
    setDraft(entry.document);
    setSelection(selectionRef.current);
    setTypingPatch(entry.typingPatch || {});
    compositionTextRef.current = null;
    setCompositionText(null);
    restoreSelection();
  };
  const localHistory = direction => {
    const source = direction === 'undo' ? undoRef.current : redoRef.current;
    if (!source.length) return false;
    const destination = direction === 'undo' ? redoRef.current : undoRef.current;
    const entry = source.pop();
    pushBounded(destination, currentSnapshot());
    restoreSnapshot(entry);
    lastTextMutationRef.current = null;
    return true;
  };
  const applyPatch = (patch, options = {}) => {
    const range = textSelectionActiveRef.current
      ? selectionRef.current
      : { start: 0, end: draftRef.current.text.length };
    recordLocalMutation('format');
    if (range.start === range.end) {
      setTypingPatch(current => ({ ...current, ...patch }));
    } else {
      const next = applyCharacterFormatting(draftRef.current, range, patch);
      draftRef.current = next;
      setDraft(next);
    }
    if (compact || !textSelectionActiveRef.current) void finish();
    else if (options.restoreSelection !== false) restoreSelection();
  };
  const applyRgb = rgb => {
    const range = textSelectionActiveRef.current
      ? selectionRef.current
      : { start: 0, end: draftRef.current.text.length };
    recordLocalMutation('format');
    if (range.start === range.end) {
      setTypingPatch(current => ({
        ...current,
        color: characterColorWithRgb(typingStyle.color, rgb),
      }));
    } else {
      const next = applyCharacterRgbFormatting(draftRef.current, range, rgb);
      draftRef.current = next;
      setDraft(next);
    }
    if (compact || !textSelectionActiveRef.current) void finish();
    else restoreSelection();
  };
  const finish = async () => {
    if (cancelledRef.current || commitPendingRef.current) return;
    focusedRef.current = false;
    // Compare content, not identity: while a commit is pending the parent hands the accepted document back as a new
    // object, so draft and baseline can be equal documents in different objects. Committing that again gave the kernel
    // a no-op ("did not produce a native PDF change") and left the frame in a state the next edit corrupted.
    if (draftRef.current !== baselineRef.current &&
        documentContentIdentity(draftRef.current) !== documentContentIdentity(baselineRef.current)) {
      const committed = draftRef.current;
      const baseline = baselineRef.current;
      commitPendingRef.current = true;
      setCommitPending(true);
      try {
        // berg:work: a range picked in the on-page editor is formatted once that editor has closed, so the frame
        // is not committed underneath an open editing session.
        if (compact && onBeforeCompactCommit) await onBeforeCompactCommit();
        const accepted = await onCommit?.(committed, baseline);
        if (accepted === false) throw new Error('Rich-text commit was rejected.');
        baselineRef.current = committed;
        undoRef.current = [];
        redoRef.current = [];
        lastTextMutationRef.current = null;
      } catch {
        draftRef.current = baseline;
        const caret = Math.min(selectionRef.current.start, baseline.text.length);
        selectionRef.current = graphemeSelection(baseline.text, caret, caret);
        setDraft(baseline);
        setSelection(selectionRef.current);
        setTypingPatch({});
        undoRef.current = [];
        redoRef.current = [];
        lastTextMutationRef.current = null;
      } finally {
        commitPendingRef.current = false;
        setCommitPending(false);
      }
    }
  };
  const acceptTextareaValue = (value, range) => {
    const change = textareaReplacement(draftRef.current.text, value, range);
    const inputType = String(range?.inputType || 'insertText');
    recordLocalMutation(inputType, /^(?:insertText|deleteContentBackward|deleteContentForward)$/u.test(inputType), range.start);
    const style = range.start === range.end ? typingStyle : null;
    const next = replaceRichText(draftRef.current, change.selection, change.replacement, style);
    const caret = change.selection.start + change.replacement.length;
    draftRef.current = next;
    selectionRef.current = { start: caret, end: caret };
    expectedInputSelectionRef.current = { ...selectionRef.current };
    if (lastTextMutationRef.current) lastTextMutationRef.current.afterCaret = caret;
    setDraft(next);
    setSelection(selectionRef.current);
    setCompositionText(null);
  };
  const faceForPatch = (resources, current, patch, fallbackEntry = null) => {
    const exact = matchingFontFace(resources, current, patch);
    if (exact || !fallbackEntry || patch.family !== fallbackEntry.family) return exact;
    const fallback = libraryFace(
      fallbackEntry,
      patch.weight ?? current.weight,
      patch.style ?? current.style,
    );
    return resources.find(resource => resource.family === fallbackEntry.family &&
      resource.weight === fallback.weight && resource.style === fallback.style) || null;
  };
  const chooseFace = (patch, resources = fontResourcePool, fallbackEntry = null) => {
    const current = state.resourceId
      ? draftRef.current.fontResources.find(resource => resource.resourceId === state.resourceId)
      : typingStyle;
    const face = faceForPatch(resources, current || typingStyle, patch, fallbackEntry);
    if (!face) return;
    if (!draftRef.current.fontResources.some(resource => resource.resourceId === face.resourceId)) {
      const next = createRichTextDocument({
        ...draftRef.current,
        fontResources: [...draftRef.current.fontResources, face],
      });
      draftRef.current = next;
      setDraft(next);
    }
    applyPatch({ resourceId: face.resourceId, family: face.family, weight: face.weight, style: face.style });
  };
  const selectedStyles = formattingSelection.start === formattingSelection.end
    ? [typingStyle]
    : draft.runs.filter(run => run.start < formattingSelection.end && run.end > formattingSelection.start).map(run => run.style);
  const facePlan = patch => selectedStyles.map(style => matchingFontFace(fontResourcePool, style, patch));
  const applyFacePlan = (patch, resources = fontResourcePool, fallbackEntry = null) => {
    const range = textSelectionActiveRef.current
      ? selectionRef.current
      : { start: 0, end: draftRef.current.text.length };
    if (range.start === range.end) { chooseFace(patch, resources, fallbackEntry); return; }
    let current = draftRef.current;
    const currentSelectedStyles = current.runs
      .filter(run => run.start < range.end && run.end > range.start)
      .map(run => run.style);
    const requiredFaces = currentSelectedStyles.map(style => faceForPatch(resources, style, patch, fallbackEntry));
    if (requiredFaces.some(face => !face)) return;
    const existingIds = new Set(current.fontResources.map(resource => resource.resourceId));
    const additions = requiredFaces.filter(face => {
      if (existingIds.has(face.resourceId)) return false;
      existingIds.add(face.resourceId);
      return true;
    });
    if (additions.length) {
      current = createRichTextDocument({ ...current, fontResources: [...current.fontResources, ...additions] });
    }
    let next = current;
    for (const run of current.runs.filter(item => item.start < range.end && item.end > range.start)) {
      const face = faceForPatch(resources, run.style, patch, fallbackEntry);
      if (!face) return;
      next = applyCharacterFormatting(next, {
        start: Math.max(run.start, range.start),
        end: Math.min(run.end, range.end),
      }, { resourceId: face.resourceId, family: face.family, weight: face.weight, style: face.style });
    }
    if (range.start === 0 && range.end === current.text.length) {
      const defaultFace = faceForPatch(resources, current.defaultCharacterStyle, patch, fallbackEntry);
      if (defaultFace) {
        const defaultCharacterStyle = { ...next.defaultCharacterStyle,
          resourceId: defaultFace.resourceId, family: defaultFace.family,
          weight: defaultFace.weight, style: defaultFace.style };
        const usedIds = new Set([
          defaultCharacterStyle.resourceId,
          ...next.runs.map(run => run.style.resourceId),
        ]);
        const usedResources = next.fontResources.filter(resource => usedIds.has(resource.resourceId));
        const replacesBase14Catalog = usedResources.length > 0 &&
          usedResources.every(resource => resource.kind === 'embedded');
        next = createRichTextDocument({
          ...next,
          defaultCharacterStyle,
          fontResources: replacesBase14Catalog
            ? next.fontResources.filter(resource => resource.kind === 'embedded')
            : next.fontResources,
        });
      }
    }
    recordLocalMutation('format');
    draftRef.current = next;
    setDraft(next);
    if (compact || !textSelectionActiveRef.current) void finish();
    else restoreSelection();
  };
  const chooseFontOption = async value => {
    setUploadError('');
    const requestEpoch = uploadEpochRef.current;
    const baselineIdentity = documentContentIdentity(baselineRef.current);
    let resources = fontResourcePool;
    let patch = null;
    let fallbackEntry = null;
    const libraryId = libraryFontIdFromOption(value);
    try {
      if (libraryId) {
        const entry = libraryFontById(libraryId);
        if (!entry) throw new Error('That bundled font family is unavailable.');
        const registered = resources.filter(resource => resource.family === entry.family);
        const hasEveryFace = entry.faces.every(face => registered.some(resource =>
          resource.weight === face.weight && resource.style === face.style));
        if (!hasEveryFace) {
          if (typeof onRequestFontFamily !== 'function') {
            throw new Error('This editor cannot register a bundled font family.');
          }
          setFontLoading(true);
          const additions = await onRequestFontFamily(entry);
          if (requestEpoch !== uploadEpochRef.current ||
              baselineIdentity !== documentContentIdentity(baselineRef.current)) return;
          resources = [...new Map([...resources, ...(additions || [])]
            .filter(resource => resource?.resourceId)
            .map(resource => [resource.resourceId, resource])).values()];
        }
        patch = { family: entry.family };
        fallbackEntry = entry;
      } else if (String(value).startsWith('standard:')) {
        const option = PDF_STANDARD_FONT_OPTIONS.find(item => `standard:${item.id}` === value);
        const resource = standardRichResource(option);
        if (!resource) throw new Error('That standard PDF font face is unavailable.');
        if (preserveStandardTraits && ['helvetica', 'times', 'courier'].includes(option.id)) {
          patch = { family: resource.family };
        } else {
          resources = [...new Map([...resources, resource].map(item => [item.resourceId, item])).values()];
          patch = { resourceId: resource.resourceId, family: resource.family, weight: resource.weight, style: resource.style };
        }
      } else {
        patch = { family: value };
      }
      applyFacePlan(patch, resources, fallbackEntry);
    } catch (error) {
      if (requestEpoch === uploadEpochRef.current &&
          baselineIdentity === documentContentIdentity(baselineRef.current)) {
        setUploadError(String(error?.message || 'Font selection failed.'));
        restoreSelection();
      }
    } finally {
      if (requestEpoch === uploadEpochRef.current) setFontLoading(false);
    }
  };
  const preserveButtonSelection = event => event.preventDefault();
  const boldPatch = { weight: state.weight === '700' ? '400' : '700' };
  const boldFaces = facePlan(boldPatch);
  const allSelectedSlanted = selectedStyles.length > 0 && selectedStyles.every(style => ['italic', 'oblique'].includes(style.style));
  const italicTarget = allSelectedSlanted ? 'normal' : 'italic';
  let italicPatch = { style: italicTarget };
  let italicFaces = facePlan(italicPatch);
  if (italicTarget === 'italic' && italicFaces.some(face => !face)) {
    italicPatch = { style: 'oblique' };
    italicFaces = facePlan(italicPatch);
  }
  const underlinePatch = { decoration: { underline: state.decoration.underline !== true } };
  const strikePatch = { decoration: { strike: state.decoration.strike !== true } };

  const finishSize = () => {
    window.clearTimeout(sizeStepTimerRef.current);
    const value = Number(sizeDraftRef.current);
    // An unchanged (rounded) display value is not a size change.
    if (state.fontSize != null && sizeDraftRef.current === displaySize(state.fontSize)) {
      sizeDraftRef.current = null;
      setSizeDraft(null);
      return;
    }
    if (sizeDraftRef.current && Number.isFinite(value) && value > 0 &&
        Number.isFinite(Math.fround(value)) && Math.fround(value) > 0) {
      applyPatch({ fontSize: value }, { restoreSelection: false });
    }
    sizeDraftRef.current = null;
    setSizeDraft(null);
  };
  finishSizeRef.current = finishSize;
  const leaveEditor = event => {
    // Text-layout controls are rendered in this component so they can share
    // the Text disclosure, but they are not part of the rich-text editing
    // session. Treat their focus boundary like the former sibling controls:
    // entering them finishes a pending text edit, while leaving them must not
    // replay the editor draft after their own native layout commit.
    // React portals bubble their synthetic blur through this component even
    // though the listbox is not a DOM descendant. It belongs to the external
    // combobox that opened it, so it must not finish the rich-text draft.
    if (!event.currentTarget.contains(event.target)) return;
    const leftExternalControls = event.target?.closest?.('[data-rich-text-external-controls]');
    if (leftExternalControls) return;
    const enteredExternalControls = event.relatedTarget?.closest?.('[data-rich-text-external-controls]');
    if (event.currentTarget.contains(event.relatedTarget) && !enteredExternalControls) return;
    if (fontPickerOpenRef.current || fontLoadingRef.current) return;
    if (composingRef.current) { pendingCompositionBlurRef.current = true; return; }
    textSelectionActiveRef.current = false;
    setTextSelectionActive(false);
    finish();
  };

  // A canvas edit with typed, unapplied text has no matching rich-text offsets: format after it is applied.
  const controlsDisabled = disabled || commitPending || fontLoading || (compact && externalSelectionStale);
  // A native select loses focus when it becomes disabled. Keep the family
  // selector focused while its async face registration runs so equivalent
  // parent renders cannot end the editor session and invalidate the request.
  const fontSelectDisabled = disabled || commitPending || (compact && externalSelectionStale);
  const uploadFontFromPicker = file => {
    if (!onUploadFont) return;
    focusedRef.current = true;
    cancelledRef.current = false;
    setUploadError('');
    fontLoadingRef.current = true;
    setFontLoading(true);
    const uploadEpoch = uploadEpochRef.current;
    const baselineIdentity = documentContentIdentity(baselineRef.current);
    uploadEquivalentIdentityRef.current = documentContentIdentity(document);
    return Promise.resolve().then(() => onUploadFont(file)).then(resource => {
      if (uploadEpoch !== uploadEpochRef.current ||
          baselineIdentity !== documentContentIdentity(baselineRef.current) || !resource) return;
      const resources = [...new Map([
        ...draftRef.current.fontResources,
        resource,
      ]
        .filter(item => item?.resourceId).map(item => [item.resourceId, item])).values()];
      // The picker has one upload action, so it preserves the former primary
      // inspector behavior: register the exact face and apply it to the active
      // range (or the whole frame when no text range is active).
      const facePatch = {
        resourceId: resource.resourceId,
        family: resource.family,
        weight: resource.weight,
        style: resource.style,
      };
      const range = textSelectionActiveRef.current
        ? selectionRef.current
        : { start: 0, end: draftRef.current.text.length };
      recordLocalMutation('font-resource');
      let next = createRichTextDocument({ ...draftRef.current, fontResources: resources });
      if (range.start === range.end) {
        setTypingPatch(current => ({ ...current, ...facePatch }));
      } else {
        next = applyCharacterFormatting(next, range, facePatch);
        if (range.start === 0 && range.end === next.text.length) {
          const defaultCharacterStyle = { ...next.defaultCharacterStyle, ...facePatch };
          const usedIds = new Set([defaultCharacterStyle.resourceId, ...next.runs.map(run => run.style.resourceId)]);
          const usedResources = next.fontResources.filter(item => usedIds.has(item.resourceId));
          next = createRichTextDocument({
            ...next,
            defaultCharacterStyle,
            fontResources: usedResources.length > 0 && usedResources.every(item => item.kind === 'embedded')
              ? next.fontResources.filter(item => item.kind === 'embedded')
              : next.fontResources,
          });
        }
      }
      draftRef.current = next;
      setDraft(next);
      if (compact || !textSelectionActiveRef.current) {
        // Font registration can cause an equivalent parent render. Let that
        // render reconcile against the old baseline before advancing the
        // accepted baseline, otherwise the stale equivalent prop can look like
        // a document replacement and discard the just-applied face.
        return new Promise(resolve => requestAnimationFrame(() => {
          void finish().finally(resolve);
        }));
      }
      restoreSelection();
    }).catch(error => {
      if (uploadEpoch === uploadEpochRef.current &&
          baselineIdentity === documentContentIdentity(baselineRef.current)) {
        uploadEquivalentIdentityRef.current = null;
        setUploadError(String(error?.message || 'Font upload failed.'));
      }
    }).finally(() => {
      if (uploadEpoch === uploadEpochRef.current) {
        fontLoadingRef.current = false;
        setFontLoading(false);
      }
    });
  };
  const textSummary = String(displayText || '').replace(/\s+/gu, ' ').trim();
  const fontTraits = [
    state.weight === '700' ? 'B' : '',
    ['italic', 'oblique'].includes(state.style) ? 'I' : '',
    state.decoration.underline === true ? 'U' : '',
    state.decoration.strike === true ? 'S' : '',
  ].filter(Boolean).join(' ');
  const fontSummary = `${state.family || 'Mixed'}${state.fontSize == null ? '' : ` · ${displaySize(state.fontSize)} pt`}${fontTraits ? ` · ${fontTraits}` : ''}`;
  const formattingRow = (
  <div className={`oo-rich-text-toolbar ${externalWholeTextControls ? 'has-external-whole-text-controls' : ''}`} role="toolbar" aria-label="Character formatting">
    {!externalWholeTextControls && <InspectorSelect label="Font" disabled={fontSelectDisabled} value={fontPickerValue}
      dataValue={state.family ?? ''}
      groups={state.family == null
        ? [{ label: '', options: [{ value: '', label: 'Mixed' }] }, ...fontOptionGroups]
        : fontOptionGroups}
      onChange={value => { void chooseFontOption(value); }} searchable searchLabel="Search fonts"
      emptyText="No fonts match" fontPreview onUploadFile={onUploadFont ? uploadFontFromPicker : null}
      uploadDisabled={controlsDisabled} onOpenChange={value => { fontPickerOpenRef.current = value; }} />}
    <div className="oo-rich-text-face-toggles">
      {!externalWholeTextControls && <>
        <button type="button" aria-label="Bold" title={boldFaces.some(face => !face) ? 'Upload the matching regular or bold font face to change this style.' : 'Bold for selected characters or text typed next'} onMouseDown={preserveButtonSelection} disabled={controlsDisabled || boldFaces.some(face => !face)} aria-pressed={state.weight == null ? 'mixed' : state.weight === '700'}
          onClick={() => applyFacePlan(boldPatch)}>B</button>
        <button type="button" aria-label="Italic" title={italicFaces.some(face => !face) ? 'Upload the matching upright or italic font face to change this style.' : 'Italic for selected characters or text typed next'} onMouseDown={preserveButtonSelection} disabled={controlsDisabled || italicFaces.some(face => !face)} aria-pressed={allSelectedSlanted ? 'true' : state.style == null ? 'mixed' : 'false'}
          onClick={() => applyFacePlan(italicPatch)}>I</button>
      </>}
      <button type="button" aria-label="Underline" title="Underline for selected characters or text typed next (Ctrl/⌘+U)" onMouseDown={preserveButtonSelection} disabled={controlsDisabled}
        aria-pressed={state.decoration.underline == null ? 'mixed' : state.decoration.underline}
        onClick={() => applyPatch(underlinePatch)}>U</button>
      <button type="button" aria-label="Strikethrough" title="Strikethrough for selected characters or text typed next" onMouseDown={preserveButtonSelection} disabled={controlsDisabled}
        aria-pressed={state.decoration.strike == null ? 'mixed' : state.decoration.strike}
        onClick={() => applyPatch(strikePatch)}>S</button>
    </div>
    {!externalWholeTextControls && <>
      <label>Size <input aria-label="Rich text size" type="number" min="0.000001" disabled={controlsDisabled}
        value={sizeDraft ?? displaySize(state.fontSize)} placeholder={state.fontSize == null ? 'Mixed' : ''}
        onFocus={() => { sizeDraftRef.current = state.fontSize == null ? '' : displaySize(state.fontSize); setSizeDraft(sizeDraftRef.current); }}
        onChange={event => {
          sizeDraftRef.current = event.target.value;
          setSizeDraft(event.target.value);
          if (!event.nativeEvent?.inputType) {
            window.clearTimeout(sizeStepTimerRef.current);
            sizeStepTimerRef.current = window.setTimeout(() => finishSizeRef.current?.(), STEP_COMMIT_DELAY_MS);
          }
        }} onBlur={finishSize}
        onKeyDown={event => {
          if (event.key === 'Enter') { event.preventDefault(); finishSize(); }
          if (event.key === 'Escape') {
            event.preventDefault(); event.stopPropagation();
            sizeDraftRef.current = null; setSizeDraft(null);
          }
        }} /></label>
      <label>Color <input aria-label="Rich text color" type="color" disabled={controlsDisabled}
        value={(state.color || typingStyle.color || '#000000ff').slice(0, 7)}
        onChange={event => applyRgb(event.target.value)} /></label>
    </>}
  </div>
  );
  if (compact) {
    return <div className="oo-rich-text-inspector is-compact" data-font-resource-count={fontResourcePool.length}
      aria-disabled={controlsDisabled || undefined} aria-busy={commitPending || fontLoading || undefined}
      title={externalSelectionStale ? 'Apply the typed text first (click outside the text), then format it.' : undefined}>
      {formattingRow}
      {compactExtras}
      {uploadError && <span className="oo-rich-text-error" role="alert">{uploadError}</span>}
    </div>;
  }
  return <div className="oo-rich-text-inspector" data-font-resource-count={fontResourcePool.length}
    aria-disabled={controlsDisabled || undefined} aria-busy={commitPending || fontLoading || undefined}
    onFocusCapture={event => {
      if (event.target?.closest?.('[data-rich-text-external-controls]')) return;
      focusedRef.current = true;
      cancelledRef.current = false;
    }} onBlur={leaveEditor}>
    <PropSection sectionKey={textSectionTitle === 'Content' ? 'content' : 'text'} title={textSectionTitle}
      summary={textSummary.length > 30 ? `${textSummary.slice(0, 30)}…` : textSummary}>
      <span className="oo-rich-text-label" aria-hidden="true">{textSectionTitle}</span>
    <textarea ref={textareaRef} aria-label="Rich text" disabled={controlsDisabled} value={displayText}
      onFocus={event => {
        focusedRef.current = true;
        cancelledRef.current = false;
        textSelectionActiveRef.current = true;
        setTextSelectionActive(true);
        rememberSelection(event.currentTarget);
      }}
      onBlur={event => rememberSelection(event.currentTarget)}
      onSelect={event => {
        // Chromium may emit a final collapsed selection event while focus is
        // already moving into a toolbar control. Keep the last user selection
        // as the formatting target in that case.
        if (globalThis.document?.activeElement === event.currentTarget) rememberSelection(event.currentTarget);
      }}
      onBeforeInput={event => {
        const inputType = event.nativeEvent.inputType;
        if (inputType === 'historyUndo' || inputType === 'historyRedo') {
          event.preventDefault();
          localHistory(inputType === 'historyUndo' ? 'undo' : 'redo');
          return;
        }
        beforeInputRef.current = { ...selectionFrom(event.currentTarget, draftRef.current.text), inputType };
      }}
      onCompositionStart={event => {
        composingRef.current = true;
        beforeInputRef.current = { ...selectionFrom(event.currentTarget, draftRef.current.text), inputType: 'insertCompositionText' };
        compositionTextRef.current = event.currentTarget.value;
        setCompositionText(compositionTextRef.current);
      }}
      onCompositionEnd={event => {
        composingRef.current = false;
        const value = compositionTextRef.current ?? event.currentTarget.value;
        compositionTextRef.current = null;
        acceptTextareaValue(value, beforeInputRef.current || selectionRef.current);
        beforeInputRef.current = null;
        if (pendingCompositionBlurRef.current) {
          pendingCompositionBlurRef.current = false;
          finish();
        }
      }}
      onInput={event => {
        if (!composingRef.current) return;
        compositionTextRef.current = event.currentTarget.value;
        setCompositionText(compositionTextRef.current);
      }}
      onChange={event => {
        if (composingRef.current) {
          compositionTextRef.current = event.currentTarget.value;
          setCompositionText(compositionTextRef.current);
          return;
        }
        acceptTextareaValue(event.currentTarget.value, beforeInputRef.current || selectionRef.current);
        beforeInputRef.current = null;
      }}
      onKeyDown={event => {
        const commandKey = event.ctrlKey || event.metaKey;
        const key = event.key.toLowerCase();
        if (commandKey && key === 'a' && !composingRef.current) {
          // Updating the whole-text/range toolbar on focus can rerender this
          // controlled textarea between the browser's select-all command and
          // the following beforeinput event. Own the command synchronously so
          // replacement typing always receives the complete range.
          event.preventDefault();
          event.currentTarget.setSelectionRange(0, draftRef.current.text.length);
          rememberSelection(event.currentTarget);
          return;
        }
        if (event.key === 'Backspace' || event.key === 'Delete') {
          beforeInputRef.current = {
            ...selectionFrom(event.currentTarget, draftRef.current.text),
            inputType: event.key === 'Backspace' ? 'deleteContentBackward' : 'deleteContentForward',
          };
        }
        if (commandKey && (key === 'z' || key === 'y') && composingRef.current) {
          event.stopPropagation();
        } else if (commandKey && (key === 'z' || key === 'y')) {
          const direction = key === 'y' || (key === 'z' && event.shiftKey) ? 'redo' : 'undo';
          event.preventDefault();
          if (localHistory(direction)) event.stopPropagation();
          else if (onRequestHistory?.(direction) === true) event.stopPropagation();
        } else if (commandKey && (key === 'b' || key === 'i' || key === 'u') && !composingRef.current) {
          event.preventDefault();
          event.stopPropagation();
          if (key === 'b' && !boldFaces.some(face => !face)) applyFacePlan(boldPatch);
          if (key === 'i' && !italicFaces.some(face => !face)) applyFacePlan(italicPatch);
          if (key === 'u') applyPatch(underlinePatch);
        } else if (event.key === 'Escape' && !composingRef.current) {
          event.preventDefault();
          event.stopPropagation();
          cancelledRef.current = true;
          draftRef.current = baselineRef.current;
          setDraft(baselineRef.current);
          compositionTextRef.current = null;
          setCompositionText(null);
          undoRef.current = [];
          redoRef.current = [];
          lastTextMutationRef.current = null;
          focusedRef.current = false;
          event.currentTarget.blur();
        } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !composingRef.current) {
          event.preventDefault();
          finish();
          event.currentTarget.blur();
        }
      }} />
    {state.mixed && <span className="oo-rich-text-mixed">Mixed character styles</span>}
    {historyNotice && <span className="oo-rich-text-error" role="status">{historyNotice}</span>}
    {textExtras && <div className="oo-rich-text-external-controls" data-rich-text-external-controls="true">{textExtras}</div>}
    </PropSection>
    <PropSection sectionKey={fontSectionTitle === 'Appearance' ? 'appearance' : 'font'} title={fontSectionTitle} summary={fontSummary}>
      {formattingRow}
      {!externalWholeTextControls && (boldFaces.some(face => !face) || italicFaces.some(face => !face)) && <p className="oo-pdf-panel-hint oo-rich-text-hint is-face-hint">Bold or italic needs the matching font file; upload that face. Existing characters keep their exact font.</p>}
      {uploadError && <span className="oo-rich-text-error" role="alert">{uploadError}</span>}
      {fontExtras}
    </PropSection>
  </div>;
}

export default RichTextInspectorEditor;
