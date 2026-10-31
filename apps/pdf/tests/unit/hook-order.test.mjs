// A hook behind an early return crashes the whole editor when that return starts to apply: deleting an image took the
// app down with React error #300. This scans the top level of every component of the fork for that pattern.
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../editor/vendor/build/src');

export function hooksAfterEarlyReturn(source) {
  const found = [];
  const lines = source.split('\n');
  let component = null;
  let returnedAt = 0;
  for (const [index, line] of lines.entries()) {
    const start = /^(?:export )?(?:async )?function ((?:[A-Z]|use[A-Z])\w*)\(/u.exec(line);
    if (start) { component = start[1]; returnedAt = 0; continue; }
    if (/^\}/u.test(line)) { component = null; continue; }
    if (!component) continue;
    if (/^ {2}if \(.*\) return\b/u.test(line) || (/^ {4}return\b/u.test(line) && /^ {2}if \(/u.test(lines[index - 1] || ''))) {
      returnedAt ||= index + 1;
      continue;
    }
    if (returnedAt && /^ {2}(?:const [^=]+ = )?use[A-Z]\w*\(/u.test(line)) {
      found.push(`${component}: hook on line ${index + 1} after the return on line ${returnedAt}`);
    }
  }
  return found;
}

test('no component calls a hook behind an early return', async () => {
  const files = (await readdir(src, { recursive: true })).filter(file => /\.jsx$/u.test(file));
  assert.ok(files.length > 3);
  const found = [];
  for (const file of files) {
    for (const entry of hooksAfterEarlyReturn(await readFile(path.join(src, file), 'utf8'))) found.push(`${file} ${entry}`);
  }
  assert.deepEqual(found, []);
});

test('the scan finds the pattern', () => {
  assert.equal(hooksAfterEarlyReturn('function Box({ a }) {\n  if (a) {\n    return null;\n  }\n  const ref = useRef(null);\n}\n').length, 1);
  assert.equal(hooksAfterEarlyReturn('function Box({ a }) {\n  const ref = useRef(null);\n  if (a) return null;\n  return a;\n}\n').length, 0);
});
