// berg:work: the shared fields of a multi-selection in Properties (Figma's "Mixed"). One compact group above the
// list of objects: X, Y, Width, Height and Angle. A field whose objects differ shows "Mixed"; a value typed there
// applies to every object, and in a Mixed field an entry that starts with an operator (+10, -5, *2, /2) changes
// each object by that amount. The shell turns the result into one transaction.
import React, { useEffect, useRef, useState } from 'react';
import { displayGeometryNumber } from './geometry-number.js';
import { evaluateNumberInput, STEP_COMMIT_DELAY_MS } from './geometry-properties.jsx';
import { PropSection } from './inspector-controls.jsx';

const SAME_EPSILON = 0.005;

// { mixed, value }: value is the shared value, or the first one when they differ.
export function sharedValue(values) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return { mixed: false, value: Number.NaN };
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  return { mixed: max - min > SAME_EPSILON, value: finite[0] };
}

// The function from an object's current value to its new one, or null when the text is not a number. `mixed`:
// the field shows Mixed, where a leading operator is relative to each object (a leading "Mixed" is ignored).
export function sharedInputResolver(text, mixed) {
  const source = String(text ?? '').trim().replace(/^mixed/iu, '').trim();
  if (!source) return null;
  if (mixed && /^[+\-*/]/u.test(source)) {
    if (!Number.isFinite(evaluateNumberInput(`0${source.replace(/^[*/]/u, '+')}`))) return null;
    return Object.assign(current => evaluateNumberInput(`(${Number(current)})${source}`), { relative: true });
  }
  const absolute = evaluateNumberInput(source);
  return Number.isFinite(absolute) ? () => absolute : null;
}

function SharedNumber({ label, values, min, onCommit, step = 1 }) {
  const { mixed, value } = sharedValue(values);
  const shown = mixed ? '' : displayGeometryNumber(value);
  const [draft, setDraft] = useState(shown);
  const [invalid, setInvalid] = useState(false);
  const changed = useRef(false);
  const stepDelta = useRef(0);
  const stepTimer = useRef(0);
  useEffect(() => {
    if (!changed.current) setDraft(shown);
  }, [shown]);
  useEffect(() => () => window.clearTimeout(stepTimer.current), []);
  const valid = resolve => values.every(current => {
    const next = resolve(current);
    return Number.isFinite(next) && (min == null || next >= min);
  });
  const finish = () => {
    if (!changed.current) return;
    const resolve = sharedInputResolver(draft, mixed);
    if (!resolve || !valid(resolve)) {
      setInvalid(true);
      return;
    }
    changed.current = false;
    setInvalid(false);
    if (values.some(current => Math.abs(resolve(current) - current) > 0.0005)) onCommit(resolve);
    setDraft(shown);
  };
  const commitStep = () => {
    const delta = stepDelta.current;
    stepDelta.current = 0;
    changed.current = false;
    const resolve = Object.assign(current => current + delta, { relative: true });
    if (delta && valid(resolve)) onCommit(resolve);
    setDraft(shown);
  };
  return (
    <label>{label}<input type="text" inputMode="decimal" spellCheck={false} autoComplete="off"
      value={draft} placeholder={mixed ? 'Mixed' : undefined} data-pdf-property-input="true"
      aria-invalid={invalid || undefined}
      title={mixed ? 'Mixed: a value sets every object; +10, -10, *2 or /2 change each object' : undefined}
      onChange={event => {
        changed.current = true;
        setInvalid(false);
        setDraft(event.target.value);
      }}
      onBlur={finish}
      onKeyDown={event => {
        event.stopPropagation();
        if (event.key === 'Enter') { event.preventDefault(); finish(); }
        if (event.key === 'Escape') {
          event.preventDefault();
          changed.current = false;
          stepDelta.current = 0;
          window.clearTimeout(stepTimer.current);
          setInvalid(false);
          setDraft(shown);
        }
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          // Steps change each object by the same amount, after a short pause so quick steps become one change.
          event.preventDefault();
          stepDelta.current += step * (event.shiftKey ? 10 : 1) * (event.key === 'ArrowUp' ? 1 : -1);
          changed.current = true;
          setDraft(mixed
            ? `${stepDelta.current >= 0 ? '+' : ''}${displayGeometryNumber(stepDelta.current)}`
            : displayGeometryNumber(value + stepDelta.current));
          window.clearTimeout(stepTimer.current);
          stepTimer.current = window.setTimeout(commitStep, STEP_COMMIT_DELAY_MS);
        }
      }} /></label>
  );
}

// `entries`: [{ key, x, y, w, h, angle }] in points and degrees (angle undefined where an object has none).
// `onCommit(field, resolve)`: resolve maps an object's current value to its new one; `resolve.relative` marks a
// change by an amount (+10, arrow keys) rather than a value for all.
export function SharedSelectionFields({ entries, onCommit }) {
  if (!entries?.length) return null;
  const column = key => entries.map(entry => Number(entry[key]));
  const angles = entries.map(entry => entry.angle);
  const canRotate = angles.every(Number.isFinite);
  const angleValues = canRotate ? angles.map(angle => ((angle % 360) + 360) % 360) : [];
  const summary = ['x', 'y', 'w', 'h'].map((key, index) => {
    const { mixed, value } = sharedValue(column(key));
    return `${['X', 'Y', 'W', 'H'][index]} ${mixed ? 'Mixed' : Math.round(value)}`;
  }).join(' · ');
  return (
    <PropSection sectionKey="shared-geometry" title="All selected" summary={summary}
      className="oo-pdf-prop-group-geometry oo-pdf-shared-fields">
      <fieldset className="oo-pdf-geometry" aria-label="Position and size of all selected objects">
        <div className="oo-pdf-prop-row two">
          <SharedNumber label="X" values={column('x')} onCommit={resolve => onCommit('x', resolve)} />
          <SharedNumber label="Y" values={column('y')} onCommit={resolve => onCommit('y', resolve)} />
          <SharedNumber label="Width" values={column('w')} min={0.01} onCommit={resolve => onCommit('w', resolve)} />
          <SharedNumber label="Height" values={column('h')} min={0.01} onCommit={resolve => onCommit('h', resolve)} />
        </div>
        {canRotate && <div className="oo-pdf-prop-row two">
          <SharedNumber label="Angle (°)" values={angleValues} onCommit={resolve => onCommit('angle', resolve)} />
        </div>}
      </fieldset>
    </PropSection>
  );
}
