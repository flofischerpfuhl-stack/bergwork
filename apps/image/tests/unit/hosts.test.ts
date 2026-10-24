import { describe, expect, it, vi } from 'vitest';
import type { HostAdapter } from '../../contracts';
import { createBrowserHost } from '../../src/platform/browserHost';
import { capabilitiesOf, getCapability, hasCapability, type CapabilityHost } from '../../src/platform/hosts';

function base(): HostAdapter {
  return { async chooseImages() { return []; }, async chooseProject() { return null; }, async saveFile() {}, reportError() {} };
}

describe('versioned host capabilities (PRODUCT-PLAN A0/A6/E6)', () => {
  it('detects only capabilities meeting the requested version', () => {
    const host: CapabilityHost = { ...base(), capabilities: { color: {
      version: 1, async displayProfile() { return { name: 'sRGB', bytes: null, assumed: true }; },
    } } };
    expect(hasCapability(host, 'color', 1)).toBe(true);
    expect(hasCapability(host, 'color', 2)).toBe(false);
    expect(getCapability(host, 'fonts', 1)).toBeNull();
  });

  it('bridges legacy file/decoder hooks once at the registry boundary', () => {
    const host = Object.assign(base(), {
      async chooseSaveTarget(name: string) { return { name }; }, async saveFileTo() {},
      async decodeImage() { return null; },
    });
    const registry = capabilitiesOf(host);
    expect(registry.files?.version).toBe(1);
    expect(registry.codecs?.version).toBe(1);
  });

  it('browser fallback reports sRGB, no system fonts, and performs a real checksum job', async () => {
    const host = createBrowserHost();
    await expect(host.capabilities!.color!.displayProfile()).resolves.toEqual({ name: 'sRGB', bytes: null, assumed: true });
    await expect(host.capabilities!.fonts!.listSystemFonts()).resolves.toEqual([]);
    const result = await host.capabilities!.compute!.run('checksum-sha256', new TextEncoder().encode('abc'));
    expect(new TextDecoder().decode(result!.bytes)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('never starts a model network request without a user action', async () => {
    vi.stubGlobal('fetch', vi.fn());
    try {
      const result = await createBrowserHost().capabilities!.models!.resolveModel({ id: 'test', sha256: '0'.repeat(64),
        url: 'https://models.invalid/test.onnx', userInitiated: false });
      expect(result).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });
});
