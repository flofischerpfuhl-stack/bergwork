import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

// The production selector is deliberately plain ESM so npm can run it without a TypeScript loader.
// @ts-expect-error The JavaScript command has no separate declaration file.
import { areasForPaths, capGateSpecs, matchesGlob, specsForAreas } from '../../scripts/e2e-select.mjs';

interface Area {
  sourceGlobs: string[];
  specs: string[];
}

interface AreaManifest {
  version: number;
  smoke: string[];
  areas: Record<string, Area>;
}

const root = resolve(import.meta.dirname, '../..');
const manifest = JSON.parse(readFileSync(resolve(root, 'tests/e2e/areas.json'), 'utf8')) as AreaManifest;

function e2eSpecs(directory = resolve(root, 'tests/e2e')): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return e2eSpecs(path);
    return entry.name.endsWith('.spec.ts') ? [`tests/e2e/${path.slice(resolve(root, 'tests/e2e').length + 1).replaceAll('\\', '/')}`] : [];
  });
}

describe('change-relevant E2E sets', () => {
  test('every E2E spec belongs to at least one named area and every entry exists', () => {
    const actual = e2eSpecs().sort();
    const assigned = [...new Set(Object.values(manifest.areas).flatMap((area) => area.specs))].sort();

    expect(actual.filter((spec) => !assigned.includes(spec))).toEqual([]);
    expect(assigned.filter((spec) => !actual.includes(spec))).toEqual([]);
    expect(manifest.smoke.every((spec) => assigned.includes(spec))).toBe(true);
  });

  test('every top-level source directory maps to at least one area', () => {
    const directories = readdirSync(resolve(root, 'src'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const mapped = directories.filter((directory) => Object.values(manifest.areas).some((area) =>
      area.sourceGlobs.some((glob) => glob.startsWith(`src/${directory}/`))));

    expect(mapped).toEqual(directories);
  });

  test('source globs and direct spec changes select the expected areas', () => {
    expect(matchesGlob('src/app/brush/state.ts', 'src/app/brush/**')).toBe(true);
    expect(matchesGlob('src/app/brush/state.ts', 'src/app/*.ts')).toBe(false);
    expect(areasForPaths(['src/app/brush/state.ts'], manifest.areas)).toEqual(['painting']);
    expect(areasForPaths(['src/io/psd/writer.ts'], manifest.areas)).toContain('psd');
    expect(areasForPaths(['tests/e2e/psd-save.spec.ts'], manifest.areas)).toContain('psd');
    expect(specsForAreas(['retouch'], manifest.areas)).toEqual(['tests/e2e/retouch.spec.ts']);
  });

  test('gate selection keeps smoke and reports deterministic overflow', () => {
    const smoke = ['smoke-a', 'smoke-b'];
    const changed = ['smoke-a', ...Array.from({ length: 8 }, (_, index) => `changed-${index}`)];
    const selection = capGateSpecs(smoke, changed, 5);

    expect(selection.specs).toEqual(['smoke-a', 'smoke-b', 'changed-0', 'changed-1', 'changed-2']);
    expect(selection.skipped).toEqual(['changed-3', 'changed-4', 'changed-5', 'changed-6', 'changed-7']);
  });
});
