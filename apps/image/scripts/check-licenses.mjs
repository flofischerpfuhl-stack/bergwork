#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expectedVendoredFiles, inventory, root, selectedLicenses, VENDORED_COVERAGE } from './license-inventory.mjs';

export function validateInventory(expected, actual, fileExists = existsSync, read = readFileSync) {
  const violations = [];
  const expectedById = new Map(expected.map((entry) => [entry.id, entry]));
  const actualById = new Map(actual.map((entry) => [entry.id, entry]));
  for (const entry of expected) {
    if (!selectedLicenses(entry.license, entry.category)) violations.push(`${entry.id}: disallowed or unknown licence ${entry.license}`);
    const found = actualById.get(entry.id);
    if (!found) { violations.push(`${entry.id}: missing from public/licenses.json`); continue; }
    for (const field of ['name', 'version', 'license', 'category', 'homepage', 'textId']) {
      if (found[field] !== entry[field]) violations.push(`${entry.id}: ${field} does not match generated inventory`);
    }
    const textPath = resolve(root, 'LICENSES', `${entry.textId}.txt`);
    if (!fileExists(textPath)) violations.push(`${entry.id}: missing ${entry.textId}.txt`);
    else if (String(read(textPath, 'utf8')).trim().length < 100) violations.push(`${entry.id}: licence text is incomplete`);
  }
  for (const entry of actual) if (!expectedById.has(entry.id)) violations.push(`${entry.id}: stale or undeclared public entry`);
  return violations;
}

export function missingVendoredCoverage(files = expectedVendoredFiles()) {
  return files.filter((file) => !VENDORED_COVERAGE.has(file));
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const { entries } = inventory();
  const jsonPath = resolve(root, 'public/licenses.json');
  const violations = [];
  if (!existsSync(jsonPath)) violations.push('public/licenses.json is missing; run npm run notices');
  else {
    let document;
    try { document = JSON.parse(readFileSync(jsonPath, 'utf8')); } catch (error) { violations.push(`public/licenses.json is invalid: ${error}`); }
    if (document?.version !== 1 || !Array.isArray(document?.entries)) violations.push('public/licenses.json has an unsupported schema');
    else violations.push(...validateInventory(entries, document.entries));
  }
  violations.push(...missingVendoredCoverage().map((file) => `${file}: vendored runtime file has no curated licence entry`));
  const expectedTexts = new Set(entries.map((entry) => `${entry.textId}.txt`));
  if (!existsSync(resolve(root, 'LICENSES/THIRD_PARTY.md'))) violations.push('LICENSES/THIRD_PARTY.md: generated index is missing');
  const actualTexts = existsSync(resolve(root, 'LICENSES'))
    ? readdirSync(resolve(root, 'LICENSES')).filter((name) => name.endsWith('.txt')) : [];
  for (const file of actualTexts) if (!expectedTexts.has(file)) violations.push(`LICENSES/${file}: stale generated licence text`);
  if (violations.length) {
    console.error(`Licence check failed (${violations.length}):\n  ${violations.join('\n  ')}`);
    process.exitCode = 1;
  } else console.log(`Licence check passed for ${entries.length} entries and ${expectedTexts.size} full licence texts.`);
}
