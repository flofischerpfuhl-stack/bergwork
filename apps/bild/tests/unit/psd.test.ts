import { describe, expect, it } from 'vitest';
import { writePsdUint8Array, type Layer as AgLayer, type Psd } from 'ag-psd';
import type { HostAdapter } from '../../contracts';
import { readRawPsdComposite } from '../../src/io/psd/composite';
import { readPsdDocument, readPsdDocumentManaged } from '../../src/io/psd';
import { cpuCompositeRegion } from '../../src/render/cpuRender';
import { EditorController } from '../../src/ui/controller';
import { loadLittleCms } from '../../src/wasm/lcms';

function u16(value: number): Uint8Array { return new Uint8Array([value >>> 8, value]); }
function u32(value: number): Uint8Array { return new Uint8Array([value >>> 24, value >>> 16, value >>> 8, value]); }
function join(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0; for (const part of parts) { output.set(part, offset); offset += part.length; } return output;
}
function rawPsd(mode: number, channels: readonly Uint8Array[], colorData = new Uint8Array()): Uint8Array {
  return join([new TextEncoder().encode('8BPS'), u16(1), new Uint8Array(6), u16(channels.length), u32(1), u32(1),
    u16(8), u16(mode), u32(colorData.length), colorData, u32(0), u32(0), u16(0), ...channels]);
}
function image(values: readonly number[]): { width: number; height: number; data: Uint8ClampedArray } {
  return { width: 2, height: 1, data: new Uint8ClampedArray(values) };
}

describe('PSD colour modes and product wiring', () => {
  it('decodes raw CMYK and indexed merged channels when ag-psd cannot parse the colour mode', () => {
    const cmyk = rawPsd(4, [new Uint8Array([255]), new Uint8Array([128]), new Uint8Array([64]), new Uint8Array([200])]);
    expect(readRawPsdComposite(cmyk).rgba).toEqual(new Uint8Array([200, 100, 50, 255]));
    const imported = readPsdDocument(cmyk);
    expect(imported.document.layers.map((layer) => layer.name)).toEqual(['PSD compatibility preview']);
    expect(cpuCompositeRegion(imported.document, { x: 0, y: 0, width: 1, height: 1 })).toEqual(imported.oracle!.toPixels());

    const palette = new Uint8Array(768); palette[7] = 12; palette[256 + 7] = 34; palette[512 + 7] = 56;
    expect(readRawPsdComposite(rawPsd(2, [new Uint8Array([7])], palette)).rgba)
      .toEqual(new Uint8Array([12, 34, 56, 255]));
  });

  it('uses the Little CMS default CMYK profile on the product-open path', async () => {
    const bytes = rawPsd(4, [new Uint8Array([255]), new Uint8Array([128]), new Uint8Array([64]), new Uint8Array([200])]);
    const lcms = await loadLittleCms();
    const expected = lcms.transform(lcms.createCmykProfile(), new Uint8Array([0, 127, 191, 55]), 'cmyk', 8);
    const imported = await readPsdDocumentManaged(bytes);
    expect(imported.document.layers[0]?.raster?.toPixels()).toEqual(expected);
  });

  it('places an adjustment mask from its PSD bounds instead of the empty adjustment-layer bounds', () => {
    const base: AgLayer = { name: 'Base', top: 0, left: 0, bottom: 1, right: 2,
      imageData: image([10, 20, 30, 255, 40, 50, 60, 255]) };
    const invert: AgLayer = { name: 'Invert', adjustment: { type: 'invert' },
      mask: { top: 0, left: 1, bottom: 1, right: 2, defaultColor: 0,
        imageData: image([255, 255, 255, 255, 255, 255, 255, 255]) } };
    const psd: Psd = { width: 2, height: 1, children: [base, invert],
      imageData: image([10, 20, 30, 255, 215, 205, 195, 255]) };
    const imported = readPsdDocument(writePsdUint8Array(psd, { generateThumbnail: false }));
    const adjustment = imported.document.layers.find((layer) => layer.adjustment);
    expect(adjustment?.transform.origin).toEqual({ x: 1, y: 0 });
    expect(cpuCompositeRegion(imported.document, { x: 0, y: 0, width: 2, height: 1 }))
      .toEqual(new Uint8Array(psd.imageData!.data));
  });

  it('opens PSD as a document and imports PSD through Import as layers', async () => {
    const notices: string[] = [];
    const host: HostAdapter = {
      chooseImages: async () => [], chooseProject: async () => null,
      saveFile: async () => undefined, reportError: (error) => notices.push(error.code),
    };
    const bytes = rawPsd(4, [new Uint8Array([255]), new Uint8Array([128]), new Uint8Array([64]), new Uint8Array([200])]);
    const file = new File([bytes as Uint8Array<ArrayBuffer>], 'fixture.psd', { type: 'image/vnd.adobe.photoshop' });
    const controller = new EditorController(host, 'en', 'dark');
    await controller.importFiles([file]);
    expect(controller.session.projectName).toBe('fixture');
    expect(controller.session.document?.layers).toHaveLength(1);

    const imported = new EditorController(host, 'en', 'dark');
    imported.newCanvasTab(2, 1);
    const before = imported.session.document!.layers.length;
    const ids = await imported.importFiles([file], imported.workspace.current, null, true);
    expect(ids).toHaveLength(1);
    expect(imported.session.document!.layers).toHaveLength(before + 1);
    expect(notices).toContain('psd-import-notice');
  });
});
