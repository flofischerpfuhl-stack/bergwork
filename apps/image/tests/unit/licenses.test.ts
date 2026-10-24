import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

// These production scripts are plain ESM so npm and release tooling can execute them without a TypeScript loader.
// @ts-expect-error The JavaScript command has no declaration file.
import { missingVendoredCoverage, validateInventory } from '../../scripts/check-licenses.mjs';
// @ts-expect-error The JavaScript command has no declaration file.
import { selectedLicenses, tokenizeLicense } from '../../scripts/license-inventory.mjs';
// @ts-expect-error The JavaScript command has no declaration file.
import { publicInventory, renderLicenseIndex, renderNotices } from '../../scripts/notices.mjs';

const root = resolve(import.meta.dirname, '../..');

describe('licence inventory generator and checker', () => {
  test('accepts only allowed licence paths and confines exceptional licences to their categories', () => {
    expect(selectedLicenses('(MIT OR Apache-2.0) AND Unicode-3.0', 'tauri-runtime')).toEqual(['MIT', 'Unicode-3.0']);
    expect(selectedLicenses('MPL-2.0', 'tauri-runtime')).toEqual(['MPL-2.0']);
    expect(selectedLicenses('MPL-2.0', 'bundled')).toBeNull();
    expect(selectedLicenses('LGPL-3.0-or-later', 'opt-in-host')).toEqual(['LGPL-3.0-or-later']);
    expect(selectedLicenses('LGPL-3.0-or-later', 'bundled')).toBeNull();
    expect(selectedLicenses('GPL-3.0', 'bundled')).toBeNull();
    expect(tokenizeLicense('MIT/Apache-2.0')).toEqual(['MIT', 'OR', 'Apache-2.0']);
  });

  test('renders complete generated sections and strips build-only paths from public JSON', () => {
    const npm = [{ name: 'ui', version: '1', license: 'MIT', homepage: 'https://example.test/ui' }];
    const rust = [{ name: 'shell', version: '2', license: 'Apache-2.0', homepage: 'https://example.test/shell' }];
    const extra = [{ name: 'font', version: '3', license: 'OFL-1.1', homepage: 'https://example.test/font' }];
    const output = renderNotices(npm, rust, extra, '## Preserved detail\nText');
    expect(output).toContain('npm production dependency inventory (1 packages)');
    expect(output).toContain('Rust/Tauri locked dependency inventory (1 crates)');
    expect(output).toContain('## Preserved detail');
    const publicData = publicInventory([{ ...npm[0], id: 'npm:ui@1', category: 'bundled', textId: 'MIT', manifestPath: '/private/cache' }]);
    expect(publicData.entries[0]).not.toHaveProperty('manifestPath');
    expect(renderLicenseIndex(new Set(['MIT', 'Apache-2.0']))).toContain('[MIT](MIT.txt)');
  });

  test('reports missing, stale, changed, and unlicensed entries', () => {
    const expected = [{ id: 'npm:ok@1', name: 'ok', version: '1', license: 'MIT', category: 'bundled', homepage: 'https://example.test', textId: 'MIT' }];
    expect(validateInventory(expected, expected, () => true, () => 'a'.repeat(120))).toEqual([]);
    expect(validateInventory(expected, [], () => true, () => 'a'.repeat(120))).toContain('npm:ok@1: missing from public/licenses.json');
    const changed = [{ ...expected[0], license: 'GPL-3.0' }, { ...expected[0], id: 'npm:stale@1' }];
    const errors = validateInventory(expected, changed, () => true, () => 'a'.repeat(120));
    expect(errors).toContain('npm:ok@1: license does not match generated inventory');
    expect(errors).toContain('npm:stale@1: stale or undeclared public entry');
  });

  test('the committed public inventory covers all categories, model provenance, and vendored runtime files', () => {
    const document = JSON.parse(readFileSync(resolve(root, 'public/licenses.json'), 'utf8')) as {
      entries: Array<{ id: string; category: string; downloadUrl?: string; sha256?: string }>;
    };
    expect(new Set(document.entries.map((entry) => entry.category))).toEqual(new Set(['bundled', 'optional-download', 'opt-in-host', 'tauri-runtime']));
    const models = document.entries.filter((entry) => entry.id.startsWith('model:'));
    expect(models).toHaveLength(7);
    expect(models.every((entry) => /^https:\/\//.test(entry.downloadUrl ?? '') && /^[a-f0-9]{64}$/.test(entry.sha256 ?? ''))).toBe(true);
    const provenance = readFileSync(resolve(root, 'MODEL_LICENSES.md'), 'utf8');
    for (const entry of models) {
      expect(provenance).toContain(entry.sha256!);
      expect(provenance).toContain(entry.downloadUrl!.match(/[a-f0-9]{40}/)![0]);
    }
    expect(missingVendoredCoverage()).toEqual([]);
  });
});
