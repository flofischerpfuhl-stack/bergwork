import { describe, expect, it } from 'vitest';
import { newLayer, type Artboard, type CanvasDocument, type Layer } from '../../src/core/document';
import { makeTransform } from '../../src/core/geometry';
import { Raster } from '../../src/core/raster';
import {
  cpuExportRenderer, estimateExportSize, ExportError, planExport, runExport, runPngExportToSink, sanitizeFileStem,
  type ExportRenderer, type ExportRequest,
} from '../../src/io/exportPipeline';
import { adler32, adler32Combine, encodePngBands, encodePngBandsAsync, hasNativeDeflate, type EncodeSpec } from '../../src/io/exportEncode';
import { lastDeflateBlock, openDeflateEnd } from '../../src/io/deflateJoin';
import { constants, deflateRawSync, inflateRawSync } from 'node:zlib';
import { readExifInfo, webpChunk } from '../../src/io/exportMetadata';
import { srgbIccProfile } from '../../src/io/iccProfile';
import { decodePng, decodePngColorSamples, decodePngNativeRGBA } from '../../src/io/png';
import { decodeTiffNative, tiffDimensions } from '../../src/io/tiff';
import { decodeWebpWasm } from '../../src/wasm/webp';
import { decodeAvifWasm } from '../../src/wasm/avif';
import { loadLittleCms } from '../../src/wasm/lcms';
import { parallelPngBandRows } from '../../src/workers/exportClient';

const renderer = cpuExportRenderer();

function solid(width: number, height: number, rgba: [number, number, number, number]): Raster {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return Raster.fromPixels(width, height, 4, data);
}
const layer = (id: string, x: number, y: number, raster: Raster, extra: Partial<Parameters<typeof newLayer>[0]> = {}): Layer =>
  newLayer({ id, name: id, raster, transform: makeTransform({ x, y }, { width: raster.width, height: raster.height }), ...extra });
const board = (id: string, name: string, x: number, width: number, alpha: number): Artboard => ({
  id, name, rect: { x, y: 0, width, height: 30 }, background: { red: 1, green: 1, blue: 1, alpha }, colorLabel: 'none',
});

/**
 * Canvas 100×30. Artboard "Post" (0…40, white) holds a red 10×10 square at (5,5);
 * artboard "Story" (60…100, transparent) holds a blue bar 30…100 whose centre (65) is inside Story
 * and which reaches into Post's area at x 30…40.
 */
function fixture(): CanvasDocument {
  return {
    id: 'doc', width: 100, height: 30, resolution: 72, selection: null,
    artboards: [board('post', 'Post', 0, 40, 1), board('story', 'Story', 60, 40, 0)],
    layers: [
      layer('red', 5, 5, solid(10, 10, [255, 0, 0, 255])),
      layer('blue', 30, 20, solid(70, 5, [0, 0, 255, 128])),
    ],
  };
}

function rgbaAt(data: ArrayLike<number>, width: number, x: number, y: number): number[] {
  const at = (y * width + x) * 4;
  return [data[at]!, data[at + 1]!, data[at + 2]!, data[at + 3]!];
}

function pngChunkTypes(bytes: Uint8Array): string[] {
  const types: string[] = [];
  for (let at = 8; at < bytes.length;) {
    const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(at);
    types.push(String.fromCharCode(...bytes.subarray(at + 4, at + 8)));
    at += 12 + length;
  }
  return types;
}

const artboardRequest = (format: ExportRequest['format'], extra: Partial<ExportRequest> = {}): ExportRequest =>
  ({ targets: [{ kind: 'artboard', id: 'post' }], format, sizes: [{ scale: 1 }, { scale: 2 }], ...extra });

describe('export planning and naming', () => {
  it('uses fast PNG compression only for very large default exports and honours explicit levels', async () => {
    const { resolveExportRequest } = await import('../../src/io/exportPlan');
    const { pngLevel } = await import('../../src/io/pngLevel');
    const png = resolveExportRequest({ targets: [{ kind: 'document' }], format: 'png' }).spec;
    expect(png.level).toBe(6);
    expect(pngLevel(png, 1920, 1080)).toBe(6);
    expect(pngLevel(png, 8000, 6000)).toBe(1);
    const explicit = resolveExportRequest({ targets: [{ kind: 'document' }], format: 'png', compressionLevel: 7 }).spec;
    expect(pngLevel(explicit, 8000, 6000)).toBe(7);
    expect(resolveExportRequest({ targets: [{ kind: 'document' }], format: 'tiff' }).spec.level).toBe(6);
  });

  it('names files <name>@2x.<ext>, keeps @1x bare, and sizes explicit exports', () => {
    const plan = planExport(fixture(), { targets: [{ kind: 'artboard', id: 'post' }, { kind: 'artboard', id: 'story' }, { kind: 'document' }],
      format: 'png', sizes: [{ scale: 1 }, { scale: 2 }, { scale: 3 }, { scale: 0.5 }, { width: 100 }], baseName: 'Campaign' });
    expect(plan.map((item) => item.name)).toEqual([
      'Post.png', 'Post@2x.png', 'Post@3x.png', 'Post@0.5x.png', 'Post-100x75.png',
      'Story.png', 'Story@2x.png', 'Story@3x.png', 'Story@0.5x.png', 'Story-100x75.png',
      'Campaign.png', 'Campaign@2x.png', 'Campaign@3x.png', 'Campaign@0.5x.png', 'Campaign-100x30.png',
    ]);
    expect(plan.slice(0, 5).map((item) => [item.width, item.height, item.dpi])).toEqual([[40, 30, 72], [80, 60, 144], [120, 90, 216], [20, 15, 36], [100, 75, 180]]);
    expect(planExport(fixture(), { targets: [{ kind: 'document' }], format: 'jpeg', sizes: [{ height: 60 }] })[0]).toMatchObject({ name: 'Untitled-200x60.jpg', width: 200, height: 60 });
  });

  it('sanitises and de-duplicates names', () => {
    expect(sanitizeFileStem(' a/b:c*?  ')).toBe('a-b-c-');
    expect(sanitizeFileStem('...')).toBe('Untitled');
    const document = { ...fixture(), artboards: [board('one', 'Same', 0, 40, 1), board('two', 'Same', 60, 40, 1)] };
    expect(planExport(document, { targets: [{ kind: 'artboard', id: 'one' }, { kind: 'artboard', id: 'two' }], format: 'webp', sizes: [{ scale: 2 }] })
      .map((item) => item.name)).toEqual(['Same@2x.webp', 'Same 2@2x.webp']);
  });

  it('rejects impossible requests before rendering', () => {
    const code = (request: ExportRequest) => { try { planExport(fixture(), request); return 'ok'; } catch (e) { return (e as ExportError).code; } };
    expect(code({ targets: [{ kind: 'document' }], format: 'webp', bitDepth: 16 })).toBe('option');
    expect(code({ targets: [{ kind: 'document' }], format: 'png', lossless: true })).toBe('option');
    expect(code({ targets: [{ kind: 'artboard', id: 'gone' }], format: 'png' })).toBe('not-found');
    expect(code({ targets: [], format: 'png' })).toBe('no-targets');
    expect(code({ targets: [{ kind: 'document' }], format: 'png', sizes: [{ scale: 400 }] })).toBe('option');
    expect(code({ targets: [{ kind: 'document' }], format: 'png', sizes: [{ width: 30_000, height: 30_000 }] })).toBe('too-large');
    expect(code({ targets: [{ kind: 'document' }], format: 'jpeg', quality: 2 })).toBe('option');
  });

  it('plans 200 MP only for the Pro CMYK output path', () => {
    const size = [{ width: 20_000, height: 10_000 }] as const;
    expect(() => planExport(fixture(), { targets: [{ kind: 'document' }], format: 'tiff', sizes: size })).toThrowError(ExportError);
    const cmyk = { profile: { id: 'user' as const, name: 'Test press', icc: new Uint8Array(128) },
      intent: 'relative-colorimetric' as const, blackPointCompensation: true };
    expect(planExport(fixture(), { targets: [{ kind: 'document' }], format: 'tiff', sizes: size, cmyk })[0])
      .toMatchObject({ width: 20_000, height: 10_000 });
  });
});

describe('export pipeline: artboard pixels', () => {
  it('PNG @1x/@2x: clipped to the artboard, its background underneath, other artboards hidden', async () => {
    const files = await runExport(fixture(), artboardRequest('png'), renderer);
    expect(files.map((f) => [f.name, f.mime, f.width, f.height])).toEqual([['Post.png', 'image/png', 40, 30], ['Post@2x.png', 'image/png', 80, 60]]);
    const one = decodePngNativeRGBA(files[0]!.bytes), two = decodePngNativeRGBA(files[1]!.bytes);
    expect(rgbaAt(one.data, 40, 7, 7)).toEqual([255, 0, 0, 255]);
    expect(rgbaAt(one.data, 40, 20, 5)).toEqual([255, 255, 255, 255]); // white artboard background
    expect(rgbaAt(one.data, 40, 35, 22)).toEqual([255, 255, 255, 255]); // Story's bar is not part of Post
    expect(rgbaAt(two.data, 80, 15, 15)).toEqual([255, 0, 0, 255]);
    expect(rgbaAt(two.data, 80, 31, 31)).toEqual([255, 255, 255, 255]);
    expect(one.dpi!.x).toBeCloseTo(72, 1); // pHYs stores whole pixels per metre
    expect(two.dpi!.x).toBeCloseTo(144, 0);
  });

  it('transparent artboards keep alpha; flattening uses the matte', async () => {
    const [story] = await runExport(fixture(), { targets: [{ kind: 'artboard', id: 'story' }], format: 'png' }, renderer);
    const decoded = decodePngNativeRGBA(story!.bytes);
    expect(rgbaAt(decoded.data, 40, 10, 22)).toEqual([0, 0, 255, 128]);
    expect(rgbaAt(decoded.data, 40, 10, 5)[3]).toBe(0);
    const [matted] = await runExport(fixture(), { targets: [{ kind: 'artboard', id: 'story' }], format: 'png', transparent: false,
      matte: { red: 0, green: 1, blue: 0 } }, renderer);
    expect(pngChunkTypes(matted!.bytes)).toContain('IHDR');
    const flat = decodePngNativeRGBA(matted!.bytes);
    expect(decodePngColorSamples(matted!.bytes).alpha).toBeNull(); // RGB colour type
    expect(rgbaAt(flat.data, 40, 10, 5)).toEqual([0, 255, 0, 255]);
    expect(rgbaAt(flat.data, 40, 10, 22)).toEqual([0, 127, 128, 255]);
  });

  it('document target paints artboard backgrounds under the whole canvas composite', async () => {
    const [file] = await runExport(fixture(), { targets: [{ kind: 'document' }], format: 'png', baseName: 'Doc' }, renderer);
    const decoded = decodePngNativeRGBA(file!.bytes);
    expect(file!.name).toBe('Doc.png');
    expect(rgbaAt(decoded.data, 100, 20, 5)).toEqual([255, 255, 255, 255]); // inside Post
    expect(rgbaAt(decoded.data, 50, 5, 5)[3]).toBe(0); // between the artboards
    expect(rgbaAt(decoded.data, 100, 50, 22)).toEqual([0, 0, 255, 128]);
  });

  it('layer target exports the layer alone, trimmed to its pixels', async () => {
    const [file] = await runExport(fixture(), { targets: [{ kind: 'layer', id: 'red' }], format: 'png', sizes: [{ scale: 2 }] }, renderer);
    expect([file!.name, file!.width, file!.height]).toEqual(['red@2x.png', 20, 20]);
    const decoded = decodePngNativeRGBA(file!.bytes);
    expect(rgbaAt(decoded.data, 20, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(rgbaAt(decoded.data, 20, 19, 19)).toEqual([255, 0, 0, 255]);
    const hidden = { ...fixture(), layers: fixture().layers.map((l) => ({ ...l, visible: false })) };
    const [again] = await runExport(hidden, { targets: [{ kind: 'layer', id: 'blue' }], format: 'png' }, renderer);
    expect(rgbaAt(decodePngNativeRGBA(again!.bytes).data, 70, 0, 0)).toEqual([0, 0, 255, 128]); // hidden layers export as shown
  });
});

describe('export pipeline: bit depth, ICC and metadata', () => {
  const deep = (): CanvasDocument => {
    const data = new Uint16Array(8 * 2 * 4);
    for (let i = 0; i < 16; i++) data.set([1000 + i, 30_001, 65_535 - i * 3, 65_535], i * 4);
    return { id: 'deep', width: 8, height: 2, resolution: 300, selection: null, artboards: [],
      layers: [layer('g', 0, 0, Raster.fromPixels(8, 2, 4, data, { format: 'rgba16' }))] };
  };

  it('PNG16 and TIFF16 keep 16-bit samples from a 16-bit layer', async () => {
    const [png] = await runExport(deep(), { targets: [{ kind: 'document' }], format: 'png', bitDepth: 16 }, renderer);
    const decoded = decodePngNativeRGBA(png!.bytes);
    expect(decoded.bitDepth).toBe(16);
    expect(rgbaAt(decoded.data, 8, 1, 0)).toEqual([1001, 30_001, 65_532, 65_535]);
    const [tiff] = await runExport(deep(), { targets: [{ kind: 'document' }], format: 'tiff', bitDepth: 16, metadata: { colorProfile: 'strip' } }, renderer);
    const native = await decodeTiffNative(tiff!.bytes);
    expect(native.bitDepth).toBe(16);
    expect(rgbaAt(native.data, 8, 7, 1)).toEqual([1015, 30_001, 65_490, 65_535]);
    expect(native.dpi).toEqual({ x: 300, y: 300 });
    const [eight] = await runExport(deep(), { targets: [{ kind: 'document' }], format: 'tiff' }, renderer);
    expect((await decodeTiffNative(eight!.bytes)).bitDepth).toBe(8);
  });

  it('embeds a working sRGB ICC profile in PNG, TIFF, WebP and AVIF', async () => {
    const profile = srgbIccProfile();
    expect(profile.length).toBeLessThan(3000);
    // Little CMS reads it and maps sRGB samples onto themselves.
    const lcms = await loadLittleCms();
    const samples = new Uint8Array([0, 0, 0, 255, 255, 255, 128, 64, 32, 12, 200, 99]);
    const mapped = lcms.transform(profile, samples, 'rgb', 8);
    for (let p = 0; p < 4; p++) for (let c = 0; c < 3; c++) expect(Math.abs(mapped[p * 4 + c]! - samples[p * 3 + c]!)).toBeLessThanOrEqual(1);

    const [png] = await runExport(fixture(), artboardRequest('png', { sizes: [{ scale: 1 }] }), renderer);
    expect(decodePngColorSamples(png!.bytes).iccProfile).toEqual(profile);
    expect(pngChunkTypes(png!.bytes).slice(0, 3)).toEqual(['IHDR', 'iCCP', 'pHYs']);
    const [tiff] = await runExport(fixture(), artboardRequest('tiff', { sizes: [{ scale: 1 }] }), renderer);
    expect(tiffDimensions(tiff!.bytes).hasIcc).toBe(true);
    const [webp] = await runExport(fixture(), artboardRequest('webp', { sizes: [{ scale: 1 }], lossless: true }), renderer);
    expect(webpChunk(webp!.bytes, 'ICCP')).toEqual(profile);
    const [avif] = await runExport(fixture(), artboardRequest('avif', { sizes: [{ scale: 1 }], speed: 10 }), renderer);
    expect((await decodeAvifWasm(avif!.bytes)).iccProfile).toEqual(profile);
  }, 60_000);

  it('writes creator info as EXIF when asked and strips everything otherwise', async () => {
    const info = { copyright: '© 2026 Fernwork', artist: 'Flo', description: 'Banner' };
    const [png] = await runExport(fixture(), artboardRequest('png', { sizes: [{ scale: 1 }], metadata: { info } }), renderer);
    const exif = (() => {
      const bytes = png!.bytes;
      for (let at = 8; at < bytes.length;) {
        const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(at);
        if (String.fromCharCode(...bytes.subarray(at + 4, at + 8)) === 'eXIf') return bytes.slice(at + 8, at + 8 + length);
        at += 12 + length;
      }
      return null;
    })();
    expect(readExifInfo(exif!)).toEqual({ 270: 'Banner', 305: 'Fernwork Bildeditor', 315: 'Flo', 33432: '© 2026 Fernwork' });
    const [tiff] = await runExport(fixture(), artboardRequest('tiff', { sizes: [{ scale: 1 }], metadata: { info } }), renderer);
    expect(readExifInfo(tiff!.bytes)[33432]).toBe('© 2026 Fernwork');
    const [webp] = await runExport(fixture(), artboardRequest('webp', { sizes: [{ scale: 1 }], metadata: { info } }), renderer);
    expect(readExifInfo(webpChunk(webp!.bytes, 'EXIF')!)[315]).toBe('Flo');
    const [avif] = await runExport(fixture(), artboardRequest('avif', { sizes: [{ scale: 1 }], speed: 10, metadata: { info } }), renderer);
    expect(avif!.warnings).toEqual(['AVIF export does not write EXIF creator fields.']);

    const [stripped] = await runExport(fixture(), artboardRequest('png', { sizes: [{ scale: 1 }],
      metadata: { colorProfile: 'strip', resolution: false, info: null } }), renderer);
    expect(pngChunkTypes(stripped!.bytes).filter((t) => t !== 'IDAT')).toEqual(['IHDR', 'IEND']);
    const [strippedWebp] = await runExport(fixture(), artboardRequest('webp', { sizes: [{ scale: 1 }], metadata: { colorProfile: 'strip' } }), renderer);
    expect(webpChunk(strippedWebp!.bytes, 'ICCP')).toBeNull();
    expect(webpChunk(strippedWebp!.bytes, 'EXIF')).toBeNull();
  }, 60_000);
});

describe('export pipeline: WebP/AVIF/TIFF pixels', () => {
  it('decodes every format at @1x and @2x with the artboard pixels', async () => {
    for (const format of ['webp', 'avif', 'tiff'] as const) {
      const files = await runExport(fixture(), artboardRequest(format, { ...(format === 'webp' ? { lossless: true } : {}), ...(format === 'avif' ? { speed: 10, quality: 0.95 } : {}) }), renderer);
      expect(files.map((f) => f.name)).toEqual([`Post.${format === 'tiff' ? 'tif' : format}`, `Post@2x.${format === 'tiff' ? 'tif' : format}`]);
      for (const [index, file] of files.entries()) {
        const scale = index + 1, w = 40 * scale, h = 30 * scale;
        const data = format === 'webp' ? await decodeWebpWasm(file.bytes, w, h)
          : format === 'avif' ? (await decodeAvifWasm(file.bytes)).data : (await decodeTiffNative(file.bytes)).data;
        const red = rgbaAt(data, w, 8 * scale, 8 * scale), white = rgbaAt(data, w, 25 * scale, 12 * scale);
        const tolerance = format === 'avif' ? 12 : 0;
        for (const [actual, expected] of [[red, [255, 0, 0, 255]], [white, [255, 255, 255, 255]]] as const) {
          actual.forEach((value, c) => expect(Math.abs(value - expected[c]!)).toBeLessThanOrEqual(tolerance));
        }
      }
    }
  }, 120_000);
});

describe('band-parallel PNG', () => {
  it('combines Adler-32 checksums like zlib', () => {
    const a = Uint8Array.from({ length: 70_001 }, (_, i) => (i * 7) & 255), b = Uint8Array.from({ length: 12_345 }, (_, i) => (i * 13) & 255);
    const joined = new Uint8Array(a.length + b.length); joined.set(a); joined.set(b, a.length);
    expect(adler32Combine(adler32(a), adler32(b), b.length)).toBe(adler32(joined));
    expect(adler32Combine(1, adler32(b), b.length)).toBe(adler32(b));
  });

  it('stitches independently deflated bands into one valid stream (8 and 16 bit)', () => {
    const spec: EncodeSpec = { format: 'png', alpha: true, quality: 1, lossless: false, speed: 6, level: 6, tiffCompression: 'deflate', dpi: 72, icc: null, info: null };
    const width = 37, height = 53;
    const pixels = Uint8Array.from({ length: width * height * 4 }, (_, i) => (i * 31 + (i >> 7)) & 255);
    const decoded = decodePng(encodePngBands(pixels, width, height, spec, 7));
    expect(decoded.data).toEqual(pixels);
    const deep = Uint16Array.from({ length: width * height * 4 }, (_, i) => (i * 1031) & 0xffff);
    expect(decodePngNativeRGBA(encodePngBands(deep, width, height, spec, 5)).data).toEqual(deep);
    const rgb = decodePngNativeRGBA(encodePngBands(pixels, width, height, { ...spec, alpha: false }, 11));
    expect(rgbaAt(rgb.data, width, 3, 4).slice(0, 3)).toEqual(rgbaAt(pixels, width, 3, 4).slice(0, 3));
  });

  it('streams renderer bands to a sink with the exact parallel-worker bytes and no full-frame read', async () => {
    const width = 37, height = 197;
    const pixels = Uint8Array.from({ length: width * height * 4 }, (_, index) => (index * 29 + (index >> 6)) & 255);
    const document: CanvasDocument = { id: 'stream', width, height, resolution: 72, selection: null, artboards: [], layers: [] };
    let largestRead = 0;
    const bandRenderer: ExportRenderer = { readView: (_document, w, h, view) => {
      largestRead = Math.max(largestRead, h);
      const output = new Uint8Array(w * h * 4);
      for (let row = 0; row < h; row++) {
        const source = (view.ty + row) * width * 4;
        output.set(pixels.subarray(source, source + width * 4), row * width * 4);
      }
      return output;
    } };
    const request: ExportRequest = { targets: [{ kind: 'document' }], format: 'png',
      metadata: { colorProfile: 'strip', resolution: false, info: null } };
    const chunks: Uint8Array[] = [];
    const result = await runPngExportToSink(document, request, bandRenderer, async (chunk) => { chunks.push(chunk.slice()); });
    const streamed = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let at = 0; for (const chunk of chunks) { streamed.set(chunk, at); at += chunk.length; }
    // A default PNG request below FAST_PNG_PIXELS uses deflate level 6.
    const spec: EncodeSpec = { format: 'png', colorModel: 'rgb', alpha: true, quality: 1, lossless: false, speed: 6,
      level: 6, tiffCompression: 'deflate', dpi: null, icc: null, info: null };
    const expected = await encodePngBandsAsync(pixels, width, height, spec, parallelPngBandRows(height));
    expect(streamed).toEqual(expected);
    expect(decodePng(streamed).data).toEqual(pixels);
    expect(largestRead).toBeLessThan(height);
    expect(result.metrics).toMatchObject({ bands: Math.ceil(height / parallelPngBandRows(height)),
      avoidedOutputBytes: pixels.byteLength, writtenBytes: streamed.byteLength });
  });
});

describe('joining native deflate streams', () => {
  const sample = (n: number, seed: number) => Uint8Array.from({ length: n }, (_, i) => ((i * seed) ^ (i >> 5)) & 255);
  it('re-opens stored, fixed-Huffman and dynamic streams so another stream can follow', () => {
    const variants = [
      { level: 0 }, { level: 6, strategy: constants.Z_FIXED }, { level: 6 }, { level: 9 }, { level: 1, strategy: constants.Z_HUFFMAN_ONLY },
    ];
    for (const options of variants) for (const length of [0, 1, 77, 5000, 70_000]) {
      const a = sample(length, 31), b = sample(3000, 7);
      const first = new Uint8Array(deflateRawSync(a, options)), second = new Uint8Array(deflateRawSync(b));
      expect(lastDeflateBlock(first).end).toBeLessThanOrEqual(first.length * 8);
      const joined = new Uint8Array([...openDeflateEnd(first), ...second]);
      expect(new Uint8Array(inflateRawSync(joined))).toEqual(new Uint8Array([...a, ...b]));
    }
  });

  it('builds the same PNG pixels through the browser-zlib band path', async () => {
    expect(hasNativeDeflate()).toBe(true); // Node 22 has CompressionStream('deflate')
    const spec: EncodeSpec = { format: 'png', alpha: true, quality: 1, lossless: false, speed: 6, level: 6, tiffCompression: 'deflate', dpi: null, icc: null, info: null };
    const width = 61, height = 97;
    const pixels = Uint8Array.from({ length: width * height * 4 }, (_, i) => (i * 13 + (i >> 9)) & 255);
    expect(decodePng(await encodePngBandsAsync(pixels, width, height, spec, 9, true)).data).toEqual(pixels);
  });
});

describe('file-size preview', () => {
  it('is exact for small outputs and close for large ones', async () => {
    const small = await estimateExportSize(fixture(), artboardRequest('png'), renderer);
    const real = await runExport(fixture(), artboardRequest('png'), renderer);
    expect(small.map((e) => [e.exact, e.bytes])).toEqual(real.map((f) => [true, f.bytes.length]));

    // A 1600 × 1200 "photo": smooth gradients with deterministic grain.
    const width = 1600, height = 1200, data = new Uint8Array(width * height * 4);
    let seed = 7;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      const grain = (seed >> 16) % 9 - 4, at = (y * width + x) * 4;
      data[at] = Math.max(0, Math.min(255, (x * 255) / width + grain));
      data[at + 1] = Math.max(0, Math.min(255, (y * 255) / height + grain));
      data[at + 2] = Math.max(0, Math.min(255, 128 + 100 * Math.sin(x / 90) * Math.cos(y / 70) + grain));
      data[at + 3] = 255;
    }
    const photo: CanvasDocument = { id: 'p', width, height, resolution: 72, selection: null, artboards: [],
      layers: [layer('photo', 0, 0, Raster.fromPixels(width, height, 4, data))] };
    // The preview's accuracy is about the encoders, so a renderer that copies the photo 1:1 stands in
    // for the (slow, in Node) CPU compositor.
    const copy: ExportRenderer = {
      readView: (_document, w, h, view) => {
        const out = new Uint8Array(w * h * 4);
        for (let row = 0; row < h; row++) {
          const start = ((view.ty + row) * width + view.tx) * 4;
          out.set(data.subarray(start, start + w * 4), row * w * 4);
        }
        return out;
      },
    };
    const ratios: Record<string, number> = {};
    for (const request of [{ format: 'png' }, { format: 'webp', quality: 0.8 }, { format: 'tiff' }, { format: 'avif', speed: 10 }] as const) {
      const full: ExportRequest = { targets: [{ kind: 'document' }], ...request };
      const [estimate] = await estimateExportSize(photo, full, copy);
      const [file] = await runExport(photo, full, copy);
      expect(estimate!.exact).toBe(false);
      ratios[request.format] = estimate!.bytes / file!.bytes.length;
    }
    console.info('file-size preview estimate / real (1600×1200 photo-like, 16 × 256² tiles):', ratios);
    for (const ratio of Object.values(ratios)) expect(Math.abs(ratio - 1)).toBeLessThan(0.2);
  }, 120_000);

  it('can be cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(estimateExportSize(fixture(), artboardRequest('png'), renderer, { signal: controller.signal })).rejects.toThrow(/abort|cancel/i);
  });
});
