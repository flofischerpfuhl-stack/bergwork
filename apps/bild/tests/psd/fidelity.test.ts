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
    const allFiles = await corpusFiles(ROOT);
    const filter = process.env.PSD_FIDELITY_FILE?.replaceAll('\\', '/');
    const files = filter ? allFiles.filter((file) => path.relative(ROOT, file).split(path.sep).join('/').includes(filter)) : allFiles;
    expect(files.length).toBeGreaterThan(0);
    const results = [];
    for (const file of files) {
      const result = await measureFile(file, ROOT);
      results.push(result);
      if (filter) console.log(JSON.stringify(result));
    }
    expect(results).toHaveLength(files.length);
    if (!filter) await writeFidelityReport(results, REPORT, COMMIT);
  });
});
