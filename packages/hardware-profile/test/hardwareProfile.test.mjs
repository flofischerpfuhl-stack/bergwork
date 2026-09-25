import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  RendererFallbackController,
  WebStorageRendererFallbackStore,
  deriveRenderingStatus,
  deriveWebViewLaunchSettings,
  matchQuirkRules,
  resolveHardwareQuirks,
  validateQuirkRegistry,
} from '../src/index.ts';

class MemoryStorage {
  value = new Map();
  getItem(key) {
    return this.value.get(key) ?? null;
  }
  setItem(key, value) {
    this.value.set(key, value);
  }
  removeItem(key) {
    this.value.delete(key);
  }
}

test('GPU loss advances through retry, WebGL2, and persisted software once', () => {
  const storage = new MemoryStorage();
  const store = new WebStorageRendererFallbackStore(storage);
  const controller = new RendererFallbackController(store);
  assert.equal(controller.gpuDeviceLost('device lost', 'GPU', '1.2.3').kind, 'retryCurrent');
  assert.equal(controller.gpuDeviceLost('device lost', 'GPU', '1.2.3').kind, 'fallbackWebgl2');
  assert.equal(controller.gpuDeviceLost('device lost', 'GPU', '1.2.3').kind, 'relaunchSoftware');
  assert.equal(store.status().mode, 'software');
  assert.equal(controller.gpuDeviceLost('device lost', 'GPU', '1.2.3').kind, 'none');

  const nextLaunch = new RendererFallbackController(store);
  assert.equal(nextLaunch.gpuDeviceLost('again', 'GPU', '1.2.3').kind, 'none');
  assert.equal(nextLaunch.tryHardwareAgain(), true);
  assert.equal(store.status().mode, 'hardware');
});

test('WebView launch settings are platform-specific and Android has no overrides', () => {
  const hardware = { mode: 'hardware' };
  const software = {
    mode: 'software',
    from: 'webgl2',
    reason: 'repeated loss',
    gpu: 'GPU',
    driver: '1.2.3',
    decidedAt: '2026-09-25T00:00:00.000Z',
  };
  assert.deepEqual(deriveWebViewLaunchSettings({ runtime: 'webview2', persistedFallback: hardware }), {
    runtime: 'webview2',
    additionalBrowserArguments: [],
  });
  assert.deepEqual(deriveWebViewLaunchSettings({ runtime: 'webview2', persistedFallback: software }), {
    runtime: 'webview2',
    additionalBrowserArguments: ['--disable-gpu'],
  });
  assert.deepEqual(deriveWebViewLaunchSettings({ runtime: 'webkitgtk', persistedFallback: software }), {
    runtime: 'webkitgtk',
    environment: { WEBKIT_DISABLE_COMPOSITING_MODE: '1' },
  });
  const android = deriveWebViewLaunchSettings({
    runtime: 'android-webview',
    persistedFallback: software,
  });
  assert.equal(android.launchOverrides, null);
  assert.match(android.note, /no supported per-app launch switches/i);
});

test('rendering status calls only a non-fallback adapter hardware', () => {
  const persistedFallback = { mode: 'hardware' };
  assert.equal(
    deriveRenderingStatus({ persistedFallback, renderer: null }).state,
    'initializing',
  );
  assert.equal(
    deriveRenderingStatus({
      persistedFallback,
      renderer: { backend: 'webgpu', adapter: { isFallbackAdapter: false } },
    }).label,
    'WebGPU (hardware)',
  );
  assert.equal(
    deriveRenderingStatus({
      persistedFallback,
      renderer: { backend: 'webgl2', adapter: { isFallbackAdapter: false } },
    }).label,
    'WebGL2 (hardware)',
  );
  assert.equal(
    deriveRenderingStatus({
      persistedFallback,
      renderer: { backend: 'webgpu', adapter: { isFallbackAdapter: true } },
    }).label,
    'Software',
  );
  assert.equal(
    deriveRenderingStatus({
      persistedFallback,
      renderer: { backend: 'webgl2', adapter: { isFallbackAdapter: false } },
      runtimeAcceleration: 'software',
    }).label,
    'Software',
  );
});

test('quirk registry validates, matches all structured fields, and resolves deterministically', () => {
  const canonical = JSON.parse(readFileSync(new URL('../quirks-v1.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateQuirkRegistry(canonical).rules, []);
  const base = {
    match: {
      os: 'android',
      backend: 'webgpu',
      webview: 'android-webview',
      webviewVersionMin: '150.0',
      webviewVersionMax: '151.0',
    },
    reason: 'test',
    expires: '2099-01-01',
  };
  const registry = {
    schemaVersion: 1,
    rules: [
      {
        ...base,
        id: 'lower',
        priority: 1,
        actions: { disableBackends: ['webgpu'], renderBudgetScale: 0.8 },
      },
      {
        ...base,
        id: 'higher',
        priority: 2,
        actions: { forceSoftware: true, computeBudgetScale: 0.5 },
      },
    ],
  };
  const facts = {
    os: 'android',
    backend: 'webgpu',
    webview: 'android-webview',
    webviewVersion: '150.0.1',
  };
  assert.deepEqual(
    matchQuirkRules(registry, facts).map(({ id }) => id),
    ['lower', 'higher'],
  );
  assert.deepEqual(resolveHardwareQuirks(registry, facts), {
    matchedIds: ['higher', 'lower'],
    disableBackends: ['webgpu'],
    forceSoftware: true,
    renderBudgetScale: 0.8,
    computeBudgetScale: 0.5,
  });
  assert.equal(
    matchQuirkRules(registry, { ...facts, webviewVersion: '149.9' }).length,
    0,
  );
  assert.throws(() =>
    validateQuirkRegistry({
      schemaVersion: 1,
      rules: [{ ...registry.rules[0], match: { gpuName: 'vendor-name checks are forbidden' } }],
    }),
  );
  assert.throws(() =>
    validateQuirkRegistry({
      schemaVersion: 1,
      rules: [{ ...registry.rules[0], actions: { renderBudgetScale: 1.1 } }],
    }),
  );
});

