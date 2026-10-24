import React, { useEffect, useState } from 'react';
import { GeometryProperties } from './geometry-properties.jsx';

const typeOf = field => field.kind === 'choice' ? 'dropdown' : field.multiLine ? 'multiline' : field.kind;
const optionsOf = field => (field.options || []).map(option => option.label).join('\n');
const draftFor = field => ({ name: field.name, tooltip: field.alternativeText, kind: typeOf(field), required: field.required,
  multiline: field.multiLine, options: optionsOf(field), x: field.x, y: field.y, w: field.w, h: field.h });
const emptyDraft = page => {
  const rotated = Number(page?.rotation || 0) % 180 !== 0;
  const width = Number((rotated ? page?.height : page?.width) || 595);
  const height = Number((rotated ? page?.width : page?.height) || 842);
  const w = Math.max(2, Math.min(180, width - 24));
  const h = Math.max(2, Math.min(28, height - 24));
  return { name: '', tooltip: '', kind: 'text', required: false, multiline: false,
    options: 'Yes\nNo', x: Math.max(0, Math.min(72, width - w - 12)),
    y: Math.max(0, Math.min(96, height - h - 12)), w, h };
};

export function FormDesigner({ fields, doc, activePage, disabled, unavailable, needsCopy, prepareBusy, onPrepare, onApply, onShow }) {
  const newDraft = () => emptyDraft(doc?.pages?.[activePage]);
  const [selected, setSelected] = useState('');
  const [draft, setDraft] = useState(newDraft);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const field = fields.find(item => item.key === selected);
  useEffect(() => { setSelected(''); setDraft(newDraft()); setMessage(''); }, [doc?.id]);
  useEffect(() => {
    if (!selected) return;
    const current = fields.find(item => item.key === selected) || fields.find(item => item.name === draft.name);
    if (current) { setSelected(current.key); setDraft(draftFor(current)); }
    else { setSelected(''); setDraft(newDraft()); }
  }, [fields]);
  const patch = (key, value) => { setDraft(current => ({ ...current, [key]: value })); setMessage(''); };
  const choose = key => {
    setSelected(key); setMessage('');
    const next = fields.find(item => item.key === key);
    setDraft(next ? draftFor(next) : newDraft());
    if (next) onShow?.(next);
  };
  const submit = async action => {
    setBusy(true); setMessage('');
    try {
      const result = await onApply?.({ ...draft, action, pageId: field?.pageId || doc?.pages?.[activePage]?.id,
        originalName: field?.name, annotationId: field?.annotationId,
        optionsChanged: field ? draft.options !== optionsOf(field) : true });
      if (result) {
        setMessage(action === 'delete' ? 'Field deleted. Undo restores it.' : action === 'create' ? 'Field added. Switch to Fill to enter a value.' : 'Field updated.');
        if (action === 'delete') { setSelected(''); setDraft(newDraft()); }
        if (action === 'create') setDraft(current => ({ ...current, name: '', y: current.y + current.h + 12 }));
      }
    } finally { setBusy(false); }
  };
  const locked = disabled || busy || !doc;
  const kindNames = { text: 'Text', multiline: 'Multiline text', checkbox: 'Checkbox', dropdown: 'Choice list', radio: 'Radio group' };
  return <div className="oo-pdf-control-group oo-pdf-form-designer" aria-label="Form designer">
    {unavailable && <div className="oo-pdf-mini-stat" role="status">{needsCopy
      ? 'The page structure has changed. Open an editable copy to continue designing fields; your original and its history stay in their tab.'
      : 'Preparing the editing session…'}</div>}
    {needsCopy && <button type="button" disabled={prepareBusy} onClick={() => void onPrepare?.()}>Open editable copy</button>}
    <label>Field
      <select aria-label="Design field" value={selected} onChange={event => choose(event.target.value)} disabled={locked}>
        <option value="">New field</option>
        {fields.map(item => <option key={item.key} value={item.key}>{item.name}{item.kind === 'radio' ? ` · ${item.onValue}` : ''} · Page {item.pageIndex + 1}</option>)}
      </select>
    </label>
    <div className="oo-pdf-mini-stat">{field ? `Editing on page ${field.pageIndex + 1}. Name, label and required apply to the whole field.` : `Add a fillable field to page ${(activePage || 0) + 1}. Position is measured from the page’s top left.`}</div>
    <label>Field type
      <select value={draft.kind} disabled={locked || Boolean(field)} onChange={event => {
        const kind = event.target.value;
        setDraft(current => ({ ...current, kind, multiline: kind === 'multiline', w: ['checkbox', 'radio'].includes(kind) ? 20 : 180, h: kind === 'multiline' ? 72 : ['checkbox', 'radio'].includes(kind) ? 20 : 28 }));
      }}>{Object.entries(kindNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
    </label>
    <label>Field name<input value={draft.name} maxLength={200} disabled={locked} onChange={event => patch('name', event.target.value)} placeholder="e.g. customer_name" /></label>
    <label>Accessible label<input value={draft.tooltip || ''} disabled={locked} onChange={event => patch('tooltip', event.target.value)} placeholder="e.g. Customer name" /></label>
    {(draft.kind === 'dropdown' || (draft.kind === 'radio' && !field)) && <label>Choices · one per line<textarea rows={3} value={draft.options} disabled={locked} onChange={event => patch('options', event.target.value)} /></label>}
    {draft.kind === 'radio' && !field && <div className="oo-pdf-mini-stat">Choices are placed below each other with a 12 pt gap. Edit their positions individually afterwards.</div>}
    <label className="oo-pdf-check"><input type="checkbox" checked={Boolean(draft.required)} disabled={locked} onChange={event => patch('required', event.target.checked)} /> Required field</label>
    <fieldset className="oo-pdf-form-designer-geometry" disabled={locked}>
      <GeometryProperties item={draft} canRotate={false} onChange={patch} draftScope={`form:${doc?.id}:${selected || 'new'}`} />
    </fieldset>
    <button type="button" className="oo-pdf-primary" disabled={locked || !draft.name.trim()} onClick={() => void submit(field ? 'update' : 'create')}>{busy ? 'Saving field…' : field ? 'Apply field changes' : 'Add form field'}</button>
    {field && <div className="oo-pdf-action-grid">
      <button type="button" disabled={locked} onClick={() => onShow?.(field)}>Show on page</button>
      <button type="button" disabled={locked} onClick={() => void submit('delete')}>Delete field</button>
    </div>}
    {field?.kind === 'radio' && <div className="oo-pdf-mini-stat">Delete removes the whole radio group.</div>}
    {message && <div className="oo-pdf-mini-stat" role="status">{message}</div>}
  </div>;
}
