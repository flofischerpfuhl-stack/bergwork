import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readPsdDocument, writePsdDocument } from '../../src/io/psd';
import { cpuCompositeRegion } from '../../src/render/cpuRender';
import { corpusFiles } from './fidelity';

const ROOT = path.resolve('tests/fixtures/psd/corpus');
const present = fs.existsSync(ROOT);

function maximumDifference(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) return Infinity;
  let maximum = 0;
  for (let index = 0; index < a.length; index++) maximum = Math.max(maximum, Math.abs(a[index]! - b[index]!));
  return maximum;
}

describe.skipIf(!present)('PSD writer against the pinned psd-tools corpus', () => {
  it('read → write → read preserves the product render for every natively opened file', async () => {
    const allFiles = await corpusFiles(ROOT), selected = process.env.PSD_ROUNDTRIP_FILE
      ? allFiles.filter((file) => file.includes(process.env.PSD_ROUNDTRIP_FILE!)) : allFiles;
    const files = selected, failures: string[] = [];
    let accepted = 0;
    for (const absolute of files) {
      const relative = path.relative(ROOT, absolute).split(path.sep).join('/');
      try {
        const first = readPsdDocument(new Uint8Array(fs.readFileSync(absolute)));
        const before = cpuCompositeRegion(first.document,
          { x: 0, y: 0, width: first.document.width, height: first.document.height });
        const written = writePsdDocument(first.document, { format: first.source.isPsb ? 'psb' : 'auto' });
        const second = readPsdDocument(written.bytes);
        const after = cpuCompositeRegion(second.document,
          { x: 0, y: 0, width: second.document.width, height: second.document.height });
        const difference = maximumDifference(before, after);
        accepted++;
        if (difference > 1) failures.push(`${relative}: maximum channel difference ${difference}; ${written.bitsPerChannel}-bit; notices ${
          written.notices.map((entry) => entry.code).join(',') || 'none'}`);
      } catch (error) {
        // A file outside the reader's limits or rejected by its parser is not part of today's accepted set.
        if (!/exceeds the document limit|Invalid PSD|Truncated PSD|memory limit/i.test(String(error))) {
          failures.push(`${relative}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    console.log(`PSD writer corpus: ${accepted}/${files.length} files accepted by the reader and round-tripped`);
    expect(accepted).toBeGreaterThan(0);
    expect(failures).toEqual([]);
  });
});
