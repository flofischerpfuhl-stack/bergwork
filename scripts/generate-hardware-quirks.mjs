#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const inputPath = resolve(root, 'packages/hardware-profile/quirks-v1.json');
const outputPath = resolve(root, 'crates/bergwork-hardware-profile/src/generated_quirks.rs');
const registry = JSON.parse(readFileSync(inputPath, 'utf8'));

const MATCH_KEYS = new Set([
  'os', 'vendorId', 'deviceId', 'driverMin', 'driverMax', 'backend', 'sessionType', 'webview',
  'webviewVersionMin', 'webviewVersionMax',
]);
const ACTION_KEYS = new Set([
  'disableBackends', 'forceSoftware', 'renderBudgetScale', 'computeBudgetScale',
]);
const RULE_KEYS = new Set(['id', 'priority', 'match', 'actions', 'reason', 'expires']);
const OPERATING_SYSTEMS = new Set(['windows', 'linux', 'android', 'macos', 'other']);
const RENDERER_BACKENDS = new Set(['webgpu', 'webgl2', 'software']);
const WEBVIEWS = new Set(['webview2', 'webkitgtk', 'android-webview', 'electron', 'other']);
const dotted = /^\d+(?:\.\d+)*$/;
const compareVersions = (left, right) => {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

if (registry?.schemaVersion !== 1 || !Array.isArray(registry.rules)) {
  throw new Error('hardware quirk registry must use schemaVersion 1');
}
const ids = new Set();
for (const rule of registry.rules) {
  if (
    rule === null || typeof rule !== 'object' ||
    typeof rule.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(rule.id) ||
    !Number.isInteger(rule.priority) || rule.priority < -2147483648 || rule.priority > 2147483647 ||
    rule.match === null || typeof rule.match !== 'object' ||
    Array.isArray(rule.match) || rule.actions === null || typeof rule.actions !== 'object' ||
    Array.isArray(rule.actions) || typeof rule.reason !== 'string' || !rule.reason.trim() ||
    typeof rule.expires !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(rule.expires) ||
    Number.isNaN(Date.parse(`${rule.expires}T00:00:00.000Z`)) ||
    new Date(`${rule.expires}T00:00:00.000Z`).toISOString().slice(0, 10) !== rule.expires
  ) throw new Error(`malformed hardware quirk: ${String(rule?.id)}`);
  if (ids.has(rule.id)) throw new Error(`duplicate hardware quirk id: ${rule.id}`);
  ids.add(rule.id);
  if (Object.keys(rule).some((key) => !RULE_KEYS.has(key)) ||
      Object.keys(rule.match).some((key) => !MATCH_KEYS.has(key)) ||
      Object.keys(rule.actions).some((key) => !ACTION_KEYS.has(key))) {
    throw new Error(`hardware quirk ${rule.id} has an unknown field`);
  }
  if (rule.match.os !== undefined && !OPERATING_SYSTEMS.has(rule.match.os))
    throw new Error(`hardware quirk ${rule.id} has an invalid os`);
  if (rule.match.backend !== undefined && !RENDERER_BACKENDS.has(rule.match.backend))
    throw new Error(`hardware quirk ${rule.id} has an invalid backend`);
  if (rule.match.webview !== undefined && !WEBVIEWS.has(rule.match.webview))
    throw new Error(`hardware quirk ${rule.id} has an invalid webview`);
  for (const field of ['vendorId', 'deviceId']) {
    if (rule.match[field] !== undefined &&
        (!Number.isInteger(rule.match[field]) || rule.match[field] < 0 || rule.match[field] > 4294967295)) {
      throw new Error(`hardware quirk ${rule.id} has an invalid ${field}`);
    }
  }
  if (rule.match.sessionType !== undefined &&
      (typeof rule.match.sessionType !== 'string' || !rule.match.sessionType.trim())) {
    throw new Error(`hardware quirk ${rule.id} has an invalid sessionType`);
  }
  for (const field of ['driverMin', 'driverMax', 'webviewVersionMin', 'webviewVersionMax']) {
    if (rule.match[field] !== undefined &&
        (typeof rule.match[field] !== 'string' || !dotted.test(rule.match[field]))) {
      throw new Error(`hardware quirk ${rule.id} has an invalid ${field}`);
    }
  }
  for (const [minimum, maximum, field] of [
    ['driverMin', 'driverMax', 'driver'],
    ['webviewVersionMin', 'webviewVersionMax', 'webview'],
  ]) {
    if (rule.match[minimum] !== undefined && rule.match[maximum] !== undefined &&
        compareVersions(rule.match[minimum], rule.match[maximum]) > 0) {
      throw new Error(`hardware quirk ${rule.id} has a reversed ${field} range`);
    }
  }
  if (rule.actions.disableBackends !== undefined &&
      (!Array.isArray(rule.actions.disableBackends) ||
       rule.actions.disableBackends.some((backend) => !RENDERER_BACKENDS.has(backend)))) {
    throw new Error(`hardware quirk ${rule.id} has invalid disableBackends`);
  }
  if (rule.actions.forceSoftware !== undefined && typeof rule.actions.forceSoftware !== 'boolean') {
    throw new Error(`hardware quirk ${rule.id} has an invalid forceSoftware`);
  }
  for (const field of ['renderBudgetScale', 'computeBudgetScale']) {
    const value = rule.actions[field];
    if (value !== undefined &&
        (typeof value !== 'number' || !Number.isFinite(value) || value < 0.1 || value > 1)) {
      throw new Error(`hardware quirk ${rule.id} has an invalid ${field}`);
    }
  }
}

const rustString = (value) => JSON.stringify(value);
const optionalString = (value) =>
  value === undefined ? 'None' : `Some(${rustString(value)}.to_owned())`;
const optionalVersion = (value) =>
  value === undefined
    ? 'None'
    : `Some(HardwareQuirkVersion(${rustString(value)}.to_owned()))`;
const optionalNumber = (value, suffix = '') =>
  value === undefined ? 'None' : `Some(${String(value)}${suffix})`;
const optionalBoolean = (value) => value === undefined ? 'None' : `Some(${String(value)})`;
const stringVector = (value = []) =>
  `vec![${value.map((entry) => `${rustString(entry)}.to_owned()`).join(', ')}]`;

const generatedRules = registry.rules.map((rule) => `        HardwareQuirk {
            id: ${rustString(rule.id)}.to_owned(),
            priority: ${rule.priority},
            matcher: HardwareQuirkMatch {
                os: ${optionalString(rule.match.os)},
                vendor_id: ${optionalNumber(rule.match.vendorId)},
                device_id: ${optionalNumber(rule.match.deviceId)},
                driver_min: ${optionalVersion(rule.match.driverMin)},
                driver_max: ${optionalVersion(rule.match.driverMax)},
                backend: ${optionalString(rule.match.backend)},
                session_type: ${optionalString(rule.match.sessionType)},
                webview: ${optionalString(rule.match.webview)},
                webview_version_min: ${optionalVersion(rule.match.webviewVersionMin)},
                webview_version_max: ${optionalVersion(rule.match.webviewVersionMax)},
            },
            actions: HardwareQuirkActions {
                disable_backends: ${stringVector(rule.actions.disableBackends)},
                force_software: ${optionalBoolean(rule.actions.forceSoftware)},
                render_budget_scale: ${optionalNumber(rule.actions.renderBudgetScale, '_f32')},
                compute_budget_scale: ${optionalNumber(rule.actions.computeBudgetScale, '_f32')},
            },
            reason: ${rustString(rule.reason)}.to_owned(),
            expires: ${rustString(rule.expires)}.to_owned(),
        }`);

const generated = `//! Generated by \`scripts/generate-hardware-quirks.mjs\`; do not edit manually.

#[allow(unused_imports)]
use crate::quirks::{
    HardwareQuirk, HardwareQuirkActions, HardwareQuirkMatch, HardwareQuirkVersion,
};

/// Reviewed hardware quirks generated from the canonical JSON registry.
#[must_use]
pub fn generated_quirks() -> Vec<HardwareQuirk> {
${generatedRules.length === 0 ? '    Vec::new()' : `    vec![\n${generatedRules.join(',\n')}\n    ]`}
}
`;

if (process.argv.includes('--check')) {
  if (readFileSync(outputPath, 'utf8') !== generated) {
    throw new Error('generated Rust hardware quirk table is stale');
  }
} else {
  writeFileSync(outputPath, generated, 'utf8');
}
