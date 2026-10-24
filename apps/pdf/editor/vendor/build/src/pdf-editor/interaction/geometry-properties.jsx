import React, { useEffect, useRef, useState } from 'react';
import { displayGeometryNumber, existingDimensionMinimum } from './geometry-number.js';
import { SimpleInspectorSelect } from './inspector-controls.jsx';

const UNITS = { pt: 1, mm: 72 / 25.4, in: 72 };
const displayNumber = displayGeometryNumber;
const pendingGeometryDrafts = new Map();
export const STEP_COMMIT_DELAY_MS = 250;

function rememberGeometryDraft(key, value) {
  if (!key) return;
  pendingGeometryDrafts.delete(key);
  pendingGeometryDrafts.set(key, value);
  while (pendingGeometryDrafts.size > 32) {
    pendingGeometryDrafts.delete(pendingGeometryDrafts.keys().next().value);
  }
}
export function GeometryNumber({ label, value, min, max, step = 1, onCommit, disabled, draftKey = '' }) {
  const pendingDraft = pendingGeometryDrafts.get(draftKey);
  const initialDraft = pendingDraft ?? displayNumber(value);
  const [draft, setDraft] = useState(initialDraft);
  const draftRef = useRef(initialDraft);
  const [invalid, setInvalid] = useState(false);
  const changed = useRef(pendingDraft != null);
  const activeDraftKey = useRef(draftKey);
  // Spinner clicks and arrow keys apply on their own (after a short pause so
  // several quick steps become one change); typed values wait for Enter/blur.
  const stepTimer = useRef(0);
  const finishRef = useRef(null);
  const scheduleStepCommit = () => {
    window.clearTimeout(stepTimer.current);
    stepTimer.current = window.setTimeout(() => finishRef.current?.(), STEP_COMMIT_DELAY_MS);
  };
  useEffect(() => () => window.clearTimeout(stepTimer.current), []);
  useEffect(() => {
    if (activeDraftKey.current === draftKey) {
      // If React replaced the inspector node, keep the inherited draft alive
      // for further inspection refreshes until submit or cancel.
      if (changed.current) rememberGeometryDraft(draftKey, draftRef.current);
      return;
    }
    // A reused component must never carry a draft into another document,
    // object or property field.
    activeDraftKey.current = draftKey;
    const inherited = pendingGeometryDrafts.get(draftKey);
    const next = inherited ?? displayNumber(value);
    changed.current = inherited != null;
    draftRef.current = next;
    setInvalid(false);
    setDraft(next);
  }, [draftKey, value]);
  useEffect(() => {
    // A live commit or undo is authoritative once this field is submitted.
    if (!changed.current) {
      const next = displayNumber(value);
      draftRef.current = next;
      setDraft(next);
    }
  }, [value]);
  const finish = () => {
    window.clearTimeout(stepTimer.current);
    if (!changed.current) return;
    const nextDraft = draftRef.current;
    const next = Number(nextDraft);
    if (!nextDraft.trim() || !Number.isFinite(next) || (min != null && next < min) || (max != null && next > max)) {
      setInvalid(true);
      return;
    }
    changed.current = false;
    pendingGeometryDrafts.delete(draftKey);
    setInvalid(false);
    setDraft(displayNumber(next));
    if (Math.abs(next - value) > 0.0005) {
      onCommit(next);
    }
  };
  finishRef.current = finish;
  return (
    <label>{label}<input
      type="number" step="any" min={min} max={max} value={draft} disabled={disabled}
      required data-pdf-property-input="true"
      aria-invalid={invalid || undefined}
      title={invalid ? (min != null && max != null ? `Enter a number between ${min} and ${max}.` : min != null ? `Enter a number of at least ${min}.` : 'Enter a valid number.') : undefined}
      onChange={event => {
        changed.current = true;
        draftRef.current = event.target.value;
        rememberGeometryDraft(draftKey, event.target.value);
        setInvalid(false);
        setDraft(event.target.value);
        if (!event.nativeEvent?.inputType) scheduleStepCommit();
      }}
      onBlur={finish}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault();
          const currentDraft = draftRef.current;
          const current = currentDraft.trim() && Number.isFinite(Number(currentDraft)) ? Number(currentDraft) : value;
          const delta = step * (event.shiftKey ? 10 : 1) * (event.key === 'ArrowUp' ? 1 : -1);
          changed.current = true;
          setInvalid(false);
          const next = displayNumber(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, current + delta)));
          draftRef.current = next;
          rememberGeometryDraft(draftKey, next);
          setDraft(next);
          scheduleStepCommit();
        }
        if (event.key === 'Enter') { event.preventDefault(); finish(); }
        if (event.key === 'Escape') {
          event.preventDefault();
          window.clearTimeout(stepTimer.current);
          changed.current = false;
          pendingGeometryDrafts.delete(draftKey);
          setInvalid(false);
          draftRef.current = displayNumber(value);
          setDraft(draftRef.current);
        }
      }}
    /></label>
  );
}

export function GeometryProperties({ item, dimensions = item, text = false, keepRatio = false, canKeepRatio = false, canResize = true, onKeepRatioChange, canRotate = true, orientationDegrees, onChange, onRotate, draftScope = '' }) {
  const [unit, setUnit] = useState('pt');
  const [rotation, setRotation] = useState('0');
  const factor = UNITS[unit];
  const applyRotation = event => {
    event.preventDefault();
    const degrees = Number(rotation);
    if (!rotation.trim() || !Number.isFinite(degrees)) return;
    if (degrees % 360) onRotate(degrees % 360);
    setRotation('0');
  };
  return (
      <fieldset className="oo-pdf-geometry" aria-label="Position and size">
      <div className="oo-pdf-geometry-heading">
        <span>From page top left</span>
        <SimpleInspectorSelect label="Position units" value={unit} onChange={setUnit}
          options={[{ value: 'pt', label: 'pt' }, { value: 'mm', label: 'mm' }, { value: 'in', label: 'in' }]}
          className="oo-pdf-geometry-unit" />
      </div>
      <div className="oo-pdf-prop-row two" key={unit}>
        {['x', 'y', 'w', 'h'].map((key, index) => (
          <GeometryNumber key={key} label={['X', 'Y', 'Width', 'Height'][index]}
            draftKey={`${draftScope}:${unit}:${key}`}
            value={Number(dimensions[key] || 0) / factor}
            step={unit === 'in' ? 0.01 : unit === 'mm' ? 0.1 : 1}
            min={index > 1 ? existingDimensionMinimum(Number(dimensions[key] || 0) / factor, 1 / factor) : undefined}
            disabled={index > 1 && !canResize}
            onCommit={value => onChange(key, value * factor, keepRatio)} />
        ))}
      </div>
      {canKeepRatio && <label className="oo-pdf-check"><input type="checkbox" checked={keepRatio}
        onChange={event => onKeepRatioChange?.(event.target.checked)} /> Keep proportions</label>}
      {canRotate && Number.isFinite(orientationDegrees) && <span className="oo-pdf-muted" aria-label="Selection angle">
        Angle: {displayNumber((orientationDegrees % 360 + 360) % 360)}°
      </span>}
      {canRotate && Number.isFinite(orientationDegrees) && <GeometryNumber
        draftKey={`${draftScope}:angle`}
        label="Angle (°)" value={(orientationDegrees % 360 + 360) % 360}
        onCommit={value => {
          const next = (value % 360 + 360) % 360;
          const current = (orientationDegrees % 360 + 360) % 360;
          const delta = ((next - current + 540) % 360) - 180;
          if (Math.abs(delta) > 0.0005) onRotate(delta);
        }} />}
      {canRotate && <form className="oo-pdf-geometry-rotation" onSubmit={applyRotation}>
        <label>Rotate by (°)<input type="number" step="any" value={rotation} title="Positive angles rotate clockwise"
          onChange={event => setRotation(event.target.value)}
          onKeyDown={event => {
            event.stopPropagation();
            if (event.key === 'Escape') {
              event.preventDefault();
              setRotation('0');
            }
          }} /></label>
        <button type="submit" disabled={!rotation.trim() || !Number.isFinite(Number(rotation)) || Number(rotation) % 360 === 0}>Rotate</button>
      </form>}
      </fieldset>
  );
}
