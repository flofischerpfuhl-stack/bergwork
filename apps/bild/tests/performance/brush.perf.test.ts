import { expect, it } from 'vitest';
import {
  beginBrushStroke, currentBrushPreview, extendBrushStroke, finishBrushStroke, setBrushSettings,
} from '../../src/core/brush';
import { alphaBounds } from '../../src/core/raster';
import { EditorSession } from '../../src/core/session';

it('keeps 300 px soft brush feedback interactive on a 4096² layer', () => {
  const session = new EditorSession();
  session.createNewProject(4096, 4096);
  session.tool = 'brush';
  setBrushSettings(session, {
    diameter: 300, hardness: 0, opacity: 1, red: 1, green: 1, blue: 1, mode: 'paint',
  });
  expect(beginBrushStroke(session, { x: 500, y: 3500 })).not.toBeNull();

  const times: number[] = [];
  const snapshotTimes: number[] = [];
  for (let index = 1; index <= 120; index++) {
    const point = index <= 60
      ? { x: 500, y: 3500 - index * 50 }
      : { x: 500 + (index - 60) * 50, y: 500 };
    const before = performance.now();
    expect(extendBrushStroke(session, point)).not.toBeNull();
    times.push(performance.now() - before);
    const snapshotStart = performance.now();
    expect(currentBrushPreview(session)).not.toBeNull();
    snapshotTimes.push(performance.now() - snapshotStart);
  }
  const finishStart = performance.now();
  const result = finishBrushStroke(session);
  const finish = performance.now() - finishStart;

  times.sort((a, b) => a - b);
  snapshotTimes.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)]!;
  const p95 = times[Math.floor(times.length * 0.95)]!;
  const snapshotP95 = snapshotTimes[Math.floor(snapshotTimes.length * 0.95)]!;
  console.log(`BRUSH_300_4096_MOVE_MEDIAN_MS=${median.toFixed(2)} P95_MS=${p95.toFixed(2)} SNAPSHOT_P95_MS=${snapshotP95.toFixed(2)} FINISH_MS=${finish.toFixed(2)}`);
  expect(result && alphaBounds(result.raster)).not.toBeNull();
  // Generous CI guard; the interactive target measured on the reference browser is 16 ms p95.
  expect(p95).toBeLessThan(40);
}, 30_000);
