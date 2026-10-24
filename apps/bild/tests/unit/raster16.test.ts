import { describe, expect, it } from 'vitest';
import { makeTransform } from '../../src/core/geometry';
import { newLayer, type CanvasDocument } from '../../src/core/document';
import { Raster, TILE, cropRaster } from '../../src/core/raster';
import { rasterFromTransfer, rasterToTransfer } from '../../src/core/transfer';
import { decodeImageFile } from '../../src/io/imageImport';
import { decodePngNativeRGBA, encodePng } from '../../src/io/png';
import { readArchive, writeArchive } from '../../src/io/project';
import { decodeTiffNative } from '../../src/io/tiff';

function gradient(width: number, height = 1): Uint16Array {
  const pixels = new Uint16Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4, value = Math.round(x / Math.max(1, width - 1) * 65535);
    pixels[offset] = value; pixels[offset + 1] = 65535 - value; pixels[offset + 2] = (value * 73) & 65535;
    pixels[offset + 3] = 65535 - ((x * 97 + y * 31) & 4095);
  }
  return pixels;
}

describe('RGBA16 tiled raster', () => {
  it('A3: preserves native samples, compatibility pixels, crop, and copy-on-write sharing', () => {
    const width = TILE * 2 + 3, source = gradient(width, 2);
    const raster = Raster.fromPixels(width, 2, 4, source, { format: 'rgba16' });
    expect(raster.format).toBe('rgba16');
    expect(raster.maximum).toBe(65535);
    expect(raster.toPixelsNative()).toEqual(source);
    expect(raster.pixel(TILE + 7, 1)).toEqual(Array.from(source.slice(((width + TILE + 7) * 4), ((width + TILE + 7) * 4) + 4)));

    const patch = new Uint16Array([1, 2, 3, 4, 65531, 65532, 65533, 65534]);
    const edited = raster.withRegion(0, 0, 2, 1, patch);
    expect(edited.format).toBe('rgba16');
    expect(edited.tiles[0]).not.toBe(raster.tiles[0]);
    expect(edited.tiles[1]).toBe(raster.tiles[1]);
    expect(edited.readRegionNative(0, 0, 2, 1)).toEqual(patch);
    expect(edited.readRegion(0, 0, 2, 1)).toEqual(new Uint8Array([0, 0, 0, 0, 255, 255, 255, 255]));
    expect(cropRaster(edited, TILE, 0, 3, 2).format).toBe('rgba16');
  });

  it('A3: transfers typed tiles and format through worker payloads', () => {
    const raster = Raster.fromPixels(3, 2, 4, gradient(3, 2), { format: 'rgba16' });
    const transfer = structuredClone(rasterToTransfer(raster));
    const restored = rasterFromTransfer(transfer);
    expect(restored.format).toBe('rgba16');
    expect(restored.tiles[0]).toBeInstanceOf(Uint16Array);
    expect(restored.toPixels16()).toEqual(raster.toPixels16());
  });

  it('A3: PNG16 encode/decode and image import are sample-exact', async () => {
    const source = gradient(513, 2);
    const encoded = encodePng(source, 513, 2, 4, { bitDepth: 16, dpi: 144 });
    const decoded = decodePngNativeRGBA(encoded);
    expect(decoded.bitDepth).toBe(16);
    expect(decoded.data).toEqual(source);
    expect(decoded.dpi?.x).toBeCloseTo(144, 1);

    const imported = await decodeImageFile(encoded, 513 * 2);
    expect(imported.format).toBe('rgba16');
    expect(imported.toPixels16()).toEqual(source);
  });

  it('A3: TIFF16 decode and image import retain all integer samples', async () => {
    const samples = new Uint16Array([0, 32768, 65535, 257, 65534, 32767]);
    const encoded = rgb16Tiff(samples);
    const decoded = await decodeTiffNative(encoded);
    expect(decoded.bitDepth).toBe(16);
    expect(decoded.data).toEqual(new Uint16Array([0, 32768, 65535, 65535, 257, 65534, 32767, 65535]));
    const imported = await decodeImageFile(encoded, 2);
    expect(imported.format).toBe('rgba16');
    expect(imported.toPixels16()).toEqual(decoded.data);
  });

  it('A3: archive writes modified RGBA16 rasters as PNG16 and restores their depth', async () => {
    const pixels = gradient(17, 3);
    const raster = Raster.fromPixels(17, 3, 4, pixels, { format: 'rgba16' });
    const layer = newLayer({ id: 'layer', name: '16-bit', raster,
      transform: makeTransform({ x: 0, y: 0 }, { width: 17, height: 3 }) });
    const document: CanvasDocument = { id: 'doc', width: 17, height: 3, resolution: 300,
      layers: [layer], selection: null };
    const archive = writeArchive(document, 'depth', layer.id);
    const restored = await readArchive(archive.blob, async () => { throw new Error('PNG assets use the internal decoder'); });
    const restoredRaster = restored.document.layers[0]!.raster!;
    expect(restoredRaster.format).toBe('rgba16');
    expect(restoredRaster.toPixels16()).toEqual(pixels);
  });
});

function rgb16Tiff(samples: Uint16Array): Uint8Array {
  const entries = 10, ifdSize = 2 + entries * 12 + 4, bitsOffset = 8 + ifdSize;
  const pixelOffset = bitsOffset + 6, bytes = new Uint8Array(pixelOffset + samples.length * 2);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x49; bytes[1] = 0x49; view.setUint16(2, 42, true); view.setUint32(4, 8, true);
  view.setUint16(8, entries, true);
  let index = 0;
  const entry = (tag: number, type: 3 | 4, count: number, value: number): void => {
    const at = 10 + index++ * 12;
    view.setUint16(at, tag, true); view.setUint16(at + 2, type, true); view.setUint32(at + 4, count, true);
    if (type === 3 && count === 1) view.setUint16(at + 8, value, true); else view.setUint32(at + 8, value, true);
  };
  entry(256, 4, 1, 2); entry(257, 4, 1, 1); entry(258, 3, 3, bitsOffset);
  entry(259, 3, 1, 1); entry(262, 3, 1, 2); entry(273, 4, 1, pixelOffset);
  entry(277, 3, 1, 3); entry(278, 4, 1, 1); entry(279, 4, 1, samples.length * 2); entry(284, 3, 1, 1);
  view.setUint32(10 + entries * 12, 0, true);
  for (let i = 0; i < 3; i++) view.setUint16(bitsOffset + i * 2, 16, true);
  for (let i = 0; i < samples.length; i++) view.setUint16(pixelOffset + i * 2, samples[i]!, true);
  return bytes;
}
