// berg:work: turn and scale the selected object with two fingers (Canva's model). When the first finger of a
// two-finger touch lies on the selected object or within REACH px of its frame, the gesture transforms the object:
// spreading the fingers scales it proportionally about its centre, turning them rotates it (snapping to 0/45/90/…
// within SNAP_TOLERANCE degrees). Anywhere else two fingers still zoom and pan the page.
//
// Selected objects that can take the gesture register here (useTwoFingerTarget) with their commit; PdfViewport
// starts, updates and ends the gesture. The live preview is a draft in interactionDraftRuntime, as for the handles;
// the commit issues the resize and the rotation back to back, so the editor coalesces them into one transaction
// and one Undo step.
import { useEffect, useRef } from 'react';
import { interactionDraftRuntime } from './draft-runtime.js';

export const TWO_FINGER_READOUT_EVENT = 'bergwork:two-finger-readout';
export const TWO_FINGER_REACH = 16;
const SNAP_STEP = 45;
const SNAP_TOLERANCE = 4;
// A pinch is never meant to tilt by a degree or two, nor a twist to resize by a few percent.
const ROTATE_DEAD_ZONE = 3;
const SCALE_DEAD_ZONE = 0.03;
const MIN_SIDE_PX = 8;

const targets = new Map();

// `commit(scale, degrees)` applies the gesture (scale 1 or degrees 0 when that part did not change) and may return
// a promise that resolves false when the edit was refused. `scales: false` (text frames, whose resize reflows
// instead of scaling) takes only the rotation.
export function useTwoFingerTarget(enabled, key, commit, { scales = true } = {}) {
  const latest = useRef(null);
  latest.current = { commit, scales };
  useEffect(() => {
    if (!enabled || !key) return undefined;
    const entry = {
      commit: (scale, degrees) => latest.current.commit(scale, degrees),
      get scales() { return latest.current.scales !== false; },
    };
    targets.set(key, entry);
    return () => { if (targets.get(key) === entry) targets.delete(key); };
  }, [enabled, key]);
}

function handleCentre(element, corner) {
  const node = element.querySelector(`:scope > .oo-pdf-resize.${corner}`);
  const box = node?.getBoundingClientRect();
  return box?.width ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : null;
}

// The object's frame on screen: its turn and side lengths from the corner handles, else its box.
function screenFrame(element) {
  const nw = handleCentre(element, 'nw');
  const ne = handleCentre(element, 'ne');
  const sw = handleCentre(element, 'sw');
  const rect = element.getBoundingClientRect();
  if (nw && ne && sw) {
    return { angle: Math.atan2(ne.y - nw.y, ne.x - nw.x) * 180 / Math.PI,
      w: Math.hypot(ne.x - nw.x, ne.y - nw.y), h: Math.hypot(sw.x - nw.x, sw.y - nw.y), rect };
  }
  return { angle: 0, w: rect.width, h: rect.height, rect };
}

const normalized = degrees => ((degrees % 360) + 540) % 360 - 180;

// The rotation to apply for a finger turn of `delta` degrees on an object turned by `startAngle`: no tilt below the
// dead zone, and the result snaps to a multiple of SNAP_STEP within SNAP_TOLERANCE.
export function twistDegrees(startAngle, delta) {
  if (Math.abs(delta) < ROTATE_DEAD_ZONE) return 0;
  const absolute = startAngle + delta;
  const snapped = Math.round(absolute / SNAP_STEP) * SNAP_STEP;
  return Math.abs(absolute - snapped) <= SNAP_TOLERANCE ? snapped - startAngle : delta;
}

export function pinchScale(ratio, frame) {
  if (!Number.isFinite(ratio) || ratio <= 0) return 1;
  if (Math.abs(ratio - 1) < SCALE_DEAD_ZONE) return 1;
  const minimum = Math.max(MIN_SIDE_PX / Math.max(1, frame.w), MIN_SIDE_PX / Math.max(1, frame.h), 0.02);
  return Math.max(minimum, ratio);
}

function fingerLine(a, b) {
  return {
    distance: Math.max(1, Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY)),
    angle: Math.atan2(b.clientY - a.clientY, b.clientX - a.clientX) * 180 / Math.PI,
    x: (a.clientX + b.clientX) / 2,
    y: (a.clientY + b.clientY) / 2,
  };
}

// The registered target under the first finger (`first`: its press point), or null.
export function twoFingerTargetAt(root, first) {
  for (const [key, target] of targets) {
    const element = root?.querySelector?.(`[data-selection-key="${CSS.escape(key)}"]`);
    const rect = element?.getBoundingClientRect();
    if (!rect?.width) continue;
    if (first.x >= rect.left - TWO_FINGER_REACH && first.x <= rect.right + TWO_FINGER_REACH &&
        first.y >= rect.top - TWO_FINGER_REACH && first.y <= rect.bottom + TWO_FINGER_REACH) {
      return { key, target, element };
    }
  }
  return null;
}

export function beginTwoFingerTransform(root, first, a, b) {
  const hit = twoFingerTargetAt(root, first);
  if (!hit) return null;
  const frame = screenFrame(hit.element);
  const id = `two-finger-${Math.round(performance.now())}`;
  const { left, top, width, height, transform, transformOrigin } = hit.element.style;
  interactionDraftRuntime.begin(id, hit.element);
  // The handles would scale and turn with the preview; they return with the committed frame.
  hit.element.classList.add('is-two-finger-gesture');
  return {
    id, ...hit, frame,
    original: { left, top, width, height, transform, transformOrigin },
    center: { x: frame.rect.left + frame.rect.width / 2, y: frame.rect.top + frame.rect.height / 2 },
    start: fingerLine(a, b),
    scale: 1,
    degrees: 0,
  };
}

export function updateTwoFingerTransform(gesture, a, b, zoom = 1) {
  const line = fingerLine(a, b);
  gesture.scale = gesture.target.scales ? pinchScale(line.distance / gesture.start.distance, gesture.frame) : 1;
  gesture.degrees = twistDegrees(gesture.frame.angle, normalized(line.angle - gesture.start.angle));
  interactionDraftRuntime.updateGroupTransform(gesture.id,
    `rotate(${gesture.degrees}deg) scale(${gesture.scale})`, gesture.center);
  const scale = Math.max(0.0001, Number(zoom) || 1);
  const angle = Math.round(((gesture.frame.angle + gesture.degrees) % 360 + 360) % 360);
  const size = `${Math.round(gesture.frame.w * gesture.scale / scale)} × ${Math.round(gesture.frame.h * gesture.scale / scale)} pt`;
  window.dispatchEvent(new CustomEvent(TWO_FINGER_READOUT_EVENT, {
    detail: { text: gesture.target.scales ? `${size} · ${angle}°` : `${angle}°`, x: line.x + 24, y: line.y - 56 },
  }));
}

// `commit` false (a cancelled touch) restores the object.
export function finishTwoFingerTransform(gesture, { commit = true } = {}) {
  window.dispatchEvent(new CustomEvent(TWO_FINGER_READOUT_EVENT, { detail: null }));
  gesture.element.classList.remove('is-two-finger-gesture');
  if (!commit || (gesture.scale === 1 && gesture.degrees === 0)) {
    interactionDraftRuntime.end(gesture.id, { commit: false });
    return null;
  }
  const draft = interactionDraftRuntime.end(gesture.id, { commit: true });
  // Hand the preview over to the committed geometry: the scaled box now (React writes the same values), the turn
  // until the commit is accepted (as the rotate handle does). A scale left in the transform would apply twice.
  const element = gesture.element;
  const px = value => Number.parseFloat(value);
  const { left, top, width, height, transform } = gesture.original;
  if (gesture.scale !== 1 && [left, top, width, height].every(value => Number.isFinite(px(value)))) {
    element.style.left = `${px(left) + px(width) * (1 - gesture.scale) / 2}px`;
    element.style.top = `${px(top) + px(height) * (1 - gesture.scale) / 2}px`;
    element.style.width = `${px(width) * gesture.scale}px`;
    element.style.height = `${px(height) * gesture.scale}px`;
  }
  element.style.transformOrigin = 'center center';
  element.style.transform = `${transform && transform !== 'none' ? `${transform} ` : ''}rotate(${gesture.degrees}deg)`;
  const restore = () => {
    Object.assign(element.style, gesture.original);
    draft?.restore?.();
  };
  let pending;
  try {
    pending = gesture.target.commit(gesture.scale, gesture.degrees);
  } catch (error) {
    restore();
    throw error;
  }
  Promise.resolve(pending).then(result => {
    if (result === false) restore(); else draft?.accept?.();
  }, restore);
  return pending;
}
