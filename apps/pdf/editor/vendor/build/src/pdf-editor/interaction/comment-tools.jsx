// berg:work: comment tools under Markup › Comment: text box / typewriter / callout, line, shapes (polyline, polygon,
// cloud) and stamps, with their settings and the options bar row.
//
// Text box and typewriter are native FreeText annotations: they go through the shell's ordinary annotation path
// (the worker writes FreeText with a standard appearance), marked like imported FreeText so every FreeText edit
// path applies. Line is the Arrow annotation without tips. Callout, shapes and stamps need keys the pinned worker
// cannot write (/CL, /Vertices, /BE, /Stamp appearances) and are written with pdf-lib in a snapshot transaction,
// like measurements (see measure-layer.jsx and engine/markup-annotations.js).

import React, { useRef, useSyncExternalStore } from 'react';
import { icon } from '../../../../../assets/icons.js';

export const COMMENT_TOOL_IDS = Object.freeze(['textbox', 'line', 'markup-shape', 'stamp']);
export const COMMENT_TOOL_SET = new Set(COMMENT_TOOL_IDS);
export const COMMENT_TOOLBAR_TOOLS = Object.freeze([
  { id: 'textbox', label: 'Text box', icon: 'text-box' },
  { id: 'line', label: 'Line', icon: 'minus' },
  { id: 'markup-shape', label: 'Shape', icon: 'cloud' },
  { id: 'stamp', label: 'Stamp', icon: 'stamp' },
]);

export const TEXTBOX_STYLES = Object.freeze([
  { id: 'box', label: 'Box' },
  { id: 'typewriter', label: 'Typewriter' },
  { id: 'callout', label: 'Callout' },
]);
export const SHAPE_KINDS = Object.freeze([
  { id: 'polyline', label: 'Polyline' },
  { id: 'polygon', label: 'Polygon' },
  { id: 'cloud', label: 'Cloud' },
]);
export const STAMP_PRESETS = Object.freeze([
  { id: 'approved', label: 'Approved', text: 'APPROVED', color: '#2b8a3e' },
  { id: 'draft', label: 'Draft', text: 'DRAFT', color: '#1c7ed6' },
  { id: 'confidential', label: 'Confidential', text: 'CONFIDENTIAL', color: '#c92a2a' },
  { id: 'reviewed', label: 'Reviewed', text: 'REVIEWED', color: '#5f3dc4' },
  { id: 'rejected', label: 'Rejected', text: 'REJECTED', color: '#c92a2a' },
]);

const SETTINGS_KEY = 'bergwork.pdf.comment-tools';
const DEFAULTS = Object.freeze({
  textboxStyle: 'box',
  fontSize: 12,
  textColor: '#111111',
  borderColor: '#e03131',
  shapeKind: 'polygon',
  shapeColor: '#e03131',
  shapeWidth: 1.5,
  stamp: 'approved',
  stampWithDate: true,
  stampWithName: true,
  stampImage: null, // { dataUrl, width, height, name }
  author: '',
});

function load() {
  try {
    const stored = JSON.parse(globalThis.localStorage?.getItem(SETTINGS_KEY) || 'null');
    // A custom stamp image is kept for the session only (it can be large).
    return { ...DEFAULTS, ...(stored && typeof stored === 'object' ? stored : {}), stampImage: null };
  } catch {
    return { ...DEFAULTS };
  }
}

let state = load();
const listeners = new Set();
export const commentToolStore = {
  get: () => state,
  set(patch) {
    state = { ...state, ...patch };
    try {
      const { stampImage, ...persisted } = state;
      globalThis.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(persisted));
    } catch { /* private mode */ }
    for (const listener of [...listeners]) listener();
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
export const useCommentToolSettings = () => useSyncExternalStore(commentToolStore.subscribe, commentToolStore.get, commentToolStore.get);

/** The FreeText annotation a click with Text box places (shell `onAppendAnnotation` shape). */
export function textboxAnnotationAt(pos, settings = commentToolStore.get()) {
  const typewriter = settings.textboxStyle === 'typewriter';
  const fontSize = Math.max(4, Number(settings.fontSize) || 12);
  return {
    type: 'text',
    // Annotation-backed text: the shell's FreeText paths own it (see the module comment).
    imported: true,
    sourceSubtype: 'freetext',
    createdFreeText: typewriter ? 'typewriter' : 'box',
    x: pos.x,
    y: pos.y,
    // Both grow with what is typed until their frame is resized (as Insert › Text does).
    w: 24,
    autoWidth: true,
    h: fontSize * 1.4 + (typewriter ? 0 : 8),
    text: '',
    fontSize,
    fontKey: 'helvetica',
    fontWeight: '400',
    fontStyle: 'normal',
    color: settings.textColor,
    backgroundColor: typewriter ? 'transparent' : '#ffffff',
    borderColor: typewriter ? 'transparent' : settings.borderColor,
    borderWidth: typewriter ? 0 : 1,
    title: settings.author || '',
    opacity: 1,
  };
}

const Icon = ({ name }) => <span className="oo-pdf-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon(name) }} />;

function Segmented({ label, value, options, onChange }) {
  return (
    <span className="oo-pdf-comment-segmented" role="radiogroup" aria-label={label}>
      {options.map(option => (
        <button key={option.id} type="button" role="radio" aria-checked={value === option.id}
          className={value === option.id ? 'is-active' : ''} onClick={() => onChange(option.id)}>{option.label}</button>
      ))}
    </span>
  );
}

/** Read an image file for an own stamp: PNG or JPEG as a data URL with its pixel size. */
export function readStampImage(file) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\/(png|jpe?g)$/u.test(file.type)) {
      reject(new Error('Choose a PNG or JPEG image for the stamp.'));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const image = new Image();
      image.onload = () => resolve({ dataUrl: reader.result, width: image.naturalWidth, height: image.naturalHeight, name: file.name });
      image.onerror = () => reject(new Error('The image could not be read.'));
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/** Options row of the comment tools. */
export function CommentOptionsBar({ tool }) {
  const settings = useCommentToolSettings();
  const fileRef = useRef(null);
  const onChooseStampImage = () => fileRef.current?.click();
  const set = patch => commentToolStore.set(patch);
  const active = COMMENT_TOOLBAR_TOOLS.find(item => item.id === tool);
  return (
    <div className={`oo-pdf-contextbar tool-${tool} oo-pdf-comment-options`} role="toolbar" aria-label={`${active?.label || 'Comment'} options`}>
      <span className="oo-pdf-context-title"><Icon name={active?.icon || 'message-square'} /><strong>{active?.label}</strong></span>
      {tool === 'textbox' && <>
        <Segmented label="Text box style" value={settings.textboxStyle} options={TEXTBOX_STYLES} onChange={textboxStyle => set({ textboxStyle })} />
        <label>Size <input type="number" min="4" max="144" step="1" value={settings.fontSize}
          onChange={event => set({ fontSize: Math.max(4, Number(event.target.value) || 12) })} /></label>
        <label>Text <input type="color" value={settings.textColor} onChange={event => set({ textColor: event.target.value })} /></label>
        {settings.textboxStyle !== 'typewriter' && (
          <label>Border <input type="color" value={settings.borderColor} onChange={event => set({ borderColor: event.target.value })} /></label>
        )}
      </>}
      {tool === 'markup-shape' && <>
        <Segmented label="Shape" value={settings.shapeKind} options={SHAPE_KINDS} onChange={shapeKind => set({ shapeKind })} />
        <label>Color <input type="color" value={settings.shapeColor} onChange={event => set({ shapeColor: event.target.value })} /></label>
        <label>Width <input type="number" min="0.25" max="12" step="0.25" value={settings.shapeWidth}
          onChange={event => set({ shapeWidth: Math.max(0.25, Number(event.target.value) || 1) })} /></label>
        <span className="oo-pdf-context-value">Click the corners; Enter or a double click finishes</span>
      </>}
      {tool === 'stamp' && <>
        <label>Stamp <select value={settings.stampImage && settings.stamp === 'image' ? 'image' : settings.stamp}
          onChange={event => (event.target.value === 'image' && !settings.stampImage ? onChooseStampImage?.() : set({ stamp: event.target.value }))}>
          {STAMP_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
          <option value="image">{settings.stampImage ? `Image: ${settings.stampImage.name || 'own image'}` : 'Own image…'}</option>
        </select></label>
        {settings.stamp === 'image' && (
          <button type="button" onClick={() => onChooseStampImage?.()}><Icon name="image" /><span>Choose image</span></button>
        )}
        <label className="oo-pdf-check"><input type="checkbox" checked={settings.stampWithDate} onChange={event => set({ stampWithDate: event.target.checked })} /> Date</label>
        <label className="oo-pdf-check"><input type="checkbox" checked={settings.stampWithName} onChange={event => set({ stampWithName: event.target.checked })} /> Name</label>
      </>}
      <input ref={fileRef} className="sr-only" tabIndex={-1} type="file" accept="image/png,image/jpeg"
        onChange={event => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void readStampImage(file).then(stampImage => set({ stampImage, stamp: 'image' })).catch(() => {});
        }} />
      {(tool === 'stamp' || tool === 'textbox' || tool === 'markup-shape') && (
        <label>Author <input type="text" value={settings.author} placeholder="Your name"
          onChange={event => set({ author: event.target.value })} /></label>
      )}
    </div>
  );
}
