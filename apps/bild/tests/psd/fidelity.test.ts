import { access } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { corpusFiles, measureFile, writeFidelityReport } from './fidelity';

const COMMIT = '30bf79c2a88e0fc63104ee85713e23b04362153d';
const ROOT = path.resolve('tests/fixtures/psd/corpus');
const REPORT = path.resolve('artifacts/psd-fidelity.md');
let present = true;
try { await access(ROOT); } catch { present = false; }

describe.skipIf(!present)('psd-tools embedded-composite fidelity corpus', () => {
  it('measures every licensed fixture and writes the A7 report', async () => {
    const files = await corpusFiles(ROOT);
    expect(files.length).toBeGreaterThan(0);
    const results = [];
    for (const file of files) results.push(await measureFile(file, ROOT));
    expect(results).toHaveLength(files.length);
    await writeFidelityReport(results, REPORT, COMMIT);
  });
});
