import { unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { newLayer, type CanvasDocument, type LiveFilter } from '../../src/core/document';
import { makeTransform } from '../../src/core/geometry';
import { Raster } from '../../src/core/raster';
import { EditorSession } from '../../src/core/session';
import { applyFilter } from '../../src/core/filters/apply';
import { bloom, progressiveBlur, progressiveShare, rgbSplit, tonalContrast, vignette, vignetteMask } from '../../src/core/filters/creative';
import { applyLiveFilters, bakeLiveFilters, defaultLiveFilter, type LiveFilterKind } from '../../src/core/filters/live';
import { blurMargin, CREATIVE_FILTER_KINDS, defaultFilterSettings, normalizeFilterSettings, repeatsAsLastFilter } from '../../src/core/filters/settings';
import { filterSettingsOf, LIVE_FILTER_KINDS, liveFilterFrom } from '../../src/app/adjust/liveFilters';
import { needsCpuLiveFilters } from '../../src/render/gpuFilterPasses';
import { isValidLiveFilter } from '../../src/core/recipes';
import { readArchive, writeArchive } from '../../src/io/project';
import { decodePng } from '../../src/io/png';

const CREATIVE: readonly LiveFilterKind[] = ['vignette', 'bloom', 'tonalContrast', 'progressiveBlur', 'rgbSplit'];
const black = { red: 0, green: 0, blue: 0 };

function solid(width: number, height: number, rgba: readonly number[]): Raster {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return Raster.fromPixels(width, height, 4, data);
}
function paint(width: number, height: number, colour: (x: number, y: number) => readonly number[]): Raster {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set(colour(x, y), (y * width + x) * 4);
  return Raster.fromPixels(width, height, 4, data);
}
const vignetteOptions = { color: black, amount: 100, midpoint: 50, roundness: 100, feather: 60, highlights: 0 };
const transform = (width: number, height: number) => makeTransform({ x: 0, y: 0 }, { width, height });

describe('creative filter settings', () => {
  it('starts from Compositor’s defaults and clamps every new field', () => {
    const d = defaultFilterSettings();
    expect(d).toMatchObject({ vignetteColor: black, vignetteAmount: 35, vignetteMidpoint: 50, vignetteRoundness: 100,
      vignetteFeather: 60, bloomRadius: 24, bloomAmount: 40, tonalRadius: 16, tonalShadows: 40, tonalMidtones: 60,
      tonalHighlights: 30, progressiveAngle: -90, progressiveStart: 35, progressiveEnd: 100, progressiveRadius: 20,
      rgbSplitDistance: 10, rgbSplitBlur: 0, rgbSplitRadial: false });
    const n = normalizeFilterSettings({ ...d, vignetteColor: { red: 2, green: -1, blue: Number.NaN }, vignetteAmount: 500,
      vignetteRoundness: -400, bloomThreshold: -5, bloomRadius: 0, tonalShadows: 300, progressiveAngle: 720, progressiveRadius: 999,
      rgbSplitDistance: -3, rgbSplitBlur: 1e9, rgbSplitAngle: Number.POSITIVE_INFINITY });
    expect(n).toMatchObject({ vignetteColor: { red: 1, green: 0, blue: 0 }, vignetteAmount: 100, vignetteRoundness: -100,
      bloomThreshold: 0, bloomRadius: 1, tonalShadows: 100, progressiveAngle: 180, progressiveRadius: 250,
      rgbSplitDistance: 0, rgbSplitBlur: 400, rgbSplitAngle: 0 });
  });

  it('fills in settings stored before the creative filters existed', () => {
    const { vignetteColor: _c, bloomRadius: _b, rgbSplitRadial: _r, ...old } = defaultFilterSettings();
    const n = normalizeFilterSettings(old as ReturnType<typeof defaultFilterSettings>);
    expect(n.vignetteColor).toEqual(black);
    expect(n.bloomRadius).toBe(24);
    expect(n.rgbSplitRadial).toBe(false);
  });

  it('gives the spreading filters room and lets Last Filter repeat only Filter menu filters', () => {
    const d = defaultFilterSettings();
    expect(blurMargin('Bloom / Glow', d)).toBe(24 * 3 + 2);
    expect(blurMargin('Progressive Blur', d)).toBe(20 * 3 + 2);
    expect(blurMargin('RGB Split', d)).toBe(12);
    expect(blurMargin('RGB Split', { ...d, rgbSplitRadial: true, rgbSplitBlur: 5 })).toBe(32);
    expect(blurMargin('Vignette', d)).toBe(0);
    expect(blurMargin('Tonal Contrast', d)).toBe(0);
    for (const kind of CREATIVE_FILTER_KINDS) expect(repeatsAsLastFilter(kind)).toBe(true);
    expect(repeatsAsLastFilter('Curves')).toBe(false);
  });
});

describe('Vignette', () => {
  it('recolours toward the edges and keeps the middle', () => {
    const source = solid(41, 41, [200, 200, 200, 255]), result = vignette(source, vignetteOptions);
    expect(result.pixel(20, 20)).toEqual([200, 200, 200, 255]);
    expect(result.pixel(0, 0)[0]).toBeLessThan(20);
    expect(result.pixel(0, 0)[3]).toBe(255);
    // Roundness 100 is an ellipse: the middle of an edge is darkened less than a corner.
    expect(result.pixel(0, 20)[0]).toBeGreaterThan(result.pixel(0, 0)[0]!);
    const red = vignette(source, { ...vignetteOptions, color: { red: 1, green: 0, blue: 0 } }).pixel(0, 0);
    expect(red[0]).toBeGreaterThan(240); expect(red[1]).toBeLessThan(20);
    // Highlights protection eases bright pixels off; Amount 0 changes nothing.
    const white = solid(41, 41, [255, 255, 255, 255]);
    expect(vignette(white, { ...vignetteOptions, amount: 50, highlights: 100 }).pixel(0, 0)[0])
      .toBeGreaterThan(vignette(white, { ...vignetteOptions, amount: 50 }).pixel(0, 0)[0]!);
    expect(vignette(source, { ...vignetteOptions, amount: 0 })).toBe(source);
  });

  it('a rectangular vignette reaches the edge middles as strongly as the corners', () => {
    expect(vignetteMask(0.5, 20.5, 41, 41, 50, -100, 60)).toBeCloseTo(vignetteMask(0.5, 0.5, 41, 41, 50, -100, 60), 1);
    expect(vignetteMask(0.5, 20.5, 41, 41, 50, 100, 60)).toBeLessThan(vignetteMask(0.5, 0.5, 41, 41, 50, 100, 60) - 0.3);
    expect(vignetteMask(20.5, 20.5, 41, 41, 50, 100, 60)).toBe(0);
  });

  it('leaves the clear pixels of a layer with pixels clear, but paints a wholly empty layer', () => {
    const partial = paint(41, 41, (x) => (x < 20 ? [200, 200, 200, 255] : [0, 0, 0, 0]));
    const recoloured = vignette(partial, vignetteOptions);
    expect(recoloured.pixel(40, 0)).toEqual([0, 0, 0, 0]);
    expect(recoloured.pixel(0, 0)[0]).toBeLessThan(20);
    const empty = vignette(solid(41, 41, [0, 0, 0, 0]), { ...vignetteOptions, color: { red: 0, green: 0, blue: 1 } });
    expect(empty.pixel(20, 20)[3]).toBe(0);
    expect(empty.pixel(0, 0).slice(0, 3)).toEqual([0, 0, 255]);
    expect(empty.pixel(0, 0)[3]).toBeGreaterThan(240);
    expect(empty.pixel(0, 20)[3]).toBeGreaterThan(0);
  });

  it('frames the layer’s own pixels inside a padded raster', () => {
    const framed = vignette(solid(60, 60, [200, 200, 200, 255]), vignetteOptions, { x: 10, y: 10, width: 40, height: 40 });
    expect(framed.pixel(30, 30)[0]).toBe(200);
    expect(framed.pixel(10, 10)[0]).toBeLessThan(20);
  });
});

describe('Bloom / Glow', () => {
  const dot = () => paint(41, 41, (x, y) => (Math.hypot(x - 20, y - 20) < 3 ? [255, 255, 255, 255] : [20, 20, 20, 255]));
  it('glows around bright pixels and leaves dark ones far away alone', () => {
    const source = dot(), result = bloom(source, 50, 4, 60);
    expect(result.pixel(26, 20)[0]).toBeGreaterThan(source.pixel(26, 20)[0]! + 20);
    expect(result.pixel(0, 0)).toEqual(source.pixel(0, 0));
    expect(result.pixel(20, 20)).toEqual([255, 255, 255, 255]);
    // Screen never darkens; a threshold above every pixel and amount 0 change nothing.
    for (let x = 0; x < 41; x++) expect(result.pixel(x, 20)[0]).toBeGreaterThanOrEqual(source.pixel(x, 20)[0]!);
    expect(bloom(source, 100, 4, 60).toPixels()).toEqual(source.toPixels());
    expect(bloom(source, 50, 4, 0)).toBe(source);
  });

  it('spreads a halo past the edge of a transparent layer through the filter margin', () => {
    const source = paint(9, 9, () => [255, 255, 255, 255]);
    const made = applyFilter('Bloom / Glow', source, transform(9, 9), { ...defaultFilterSettings(), bloomRadius: 3, bloomThreshold: 0 });
    expect(made.raster.width).toBeGreaterThan(9);
    expect(made.transform.size.width).toBeGreaterThan(9);
    const margin = (made.raster.width - 9) / 2;
    expect(made.raster.pixel(Math.floor(margin) - 1, Math.floor(made.raster.height / 2))[3]).toBeGreaterThan(0);
  });
});

describe('Tonal Contrast', () => {
  const step = () => paint(40, 8, (x) => (x < 20 ? [100, 100, 100, 255] : [150, 150, 150, 255]));
  it('raises local contrast at an edge and keeps flat areas', () => {
    const source = step(), result = tonalContrast(source, 4, 100, 50, 80, 50);
    expect(result.pixel(18, 4)[0]).toBeLessThan(100);
    expect(result.pixel(21, 4)[0]).toBeGreaterThan(150);
    expect(result.pixel(0, 4)[0]).toBe(100);
    expect(result.pixel(39, 4)[0]).toBe(150);
    expect(result.pixel(18, 4)[3]).toBe(255);
  });

  it('weights the tones separately and negative strengths soften', () => {
    const source = step();
    const midtonesOnly = tonalContrast(source, 4, 100, 0, 100, 0), none = tonalContrast(source, 4, 100, 0, 0, 0);
    expect(none).toBe(source);
    expect(midtonesOnly.pixel(21, 4)[0]).toBeGreaterThan(150);
    expect(tonalContrast(source, 4, 100, -100, -100, -100).pixel(21, 4)[0]).toBeLessThan(150);
    expect(tonalContrast(source, 4, 0, 50, 50, 50)).toBe(source);
  });
});

describe('Progressive Blur', () => {
  it('ramps the radius linearly from start to end along the angle', () => {
    const share = progressiveShare(1, 100, -90, 20, 80);
    expect(share[0]).toBe(0); expect(share[19]).toBe(0);
    expect(share[50]).toBeCloseTo((50.5 / 100 - 0.2) / 0.6, 4);
    expect(share[99]).toBe(1);
    // Angle 0 runs left to right; 90 runs bottom to top.
    expect(progressiveShare(100, 1, 0, 0, 100)[99]).toBeGreaterThan(0.98);
    expect(progressiveShare(1, 100, 90, 0, 100)[0]).toBeGreaterThan(0.98);
  });

  it('is sharp at the start and blurred at the end', () => {
    const bands = paint(64, 64, (x) => (x % 16 < 8 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const result = progressiveBlur(bands, -90, 25, 100, 8);
    const contrast = (y: number) => result.pixel(20, y)[0]! - result.pixel(28, y)[0]!;
    expect(result.pixel(20, 2)).toEqual(bands.pixel(20, 2));
    expect(contrast(10)).toBe(255);
    expect(contrast(63)).toBeLessThan(150);
    for (let y = 16; y < 64; y += 8) expect(contrast(y)).toBeLessThanOrEqual(contrast(y - 8));
    expect(contrast(40)).toBeLessThan(contrast(16));
    expect(contrast(40)).toBeGreaterThan(contrast(63));
    // Inside an opaque layer alpha stays opaque; like Gaussian Blur it softens toward the layer's own edge.
    expect(result.pixel(20, 40)[3]).toBe(255);
    expect(result.pixel(20, 63)[3]).toBeLessThan(255);
    expect(progressiveBlur(bands, -90, 25, 100, 0)).toBe(bands);
  });
});

describe('RGB Split', () => {
  const line = () => paint(31, 9, (x) => (x === 15 ? [255, 255, 255, 255] : [0, 0, 0, 255]));
  it('fans an edge into red ahead and blue behind along the angle', () => {
    const result = rgbSplit(line(), 4, 0, 0, false);
    const ahead = result.pixel(18, 4), behind = result.pixel(12, 4);
    expect(ahead[0]).toBeGreaterThan(ahead[2]!);
    expect(behind[2]).toBeGreaterThan(behind[0]!);
    expect(result.pixel(15, 4)[1]).toBeGreaterThan(0);
    const untouched = line();
    expect(rgbSplit(untouched, 0, 0, 0, false)).toBe(untouched);
  });

  it('smears symmetrically both ways, so the image does not shift (Compositor 1.5.7)', () => {
    const smeared = rgbSplit(line(), 0, 8, 0, false);
    for (let d = 1; d <= 5; d++) expect(Math.abs(smeared.pixel(15 - d, 4)[0]! - smeared.pixel(15 + d, 4)[0]!)).toBeLessThanOrEqual(2);
    expect(smeared.pixel(19, 4)[0]).toBeGreaterThan(0);
  });

  it('radial leaves the centre and splits outwards', () => {
    const grid = paint(41, 41, (x, y) => ((x % 8 < 4) !== (y % 8 < 4) ? [255, 255, 255, 255] : [0, 0, 0, 255]));
    const result = rgbSplit(grid, 6, 0, 0, true);
    expect(result.pixel(20, 20)).toEqual(grid.pixel(20, 20));
    const corner = result.pixel(4, 2), source = grid.pixel(4, 2);
    expect(corner.slice(0, 3)).not.toEqual(source.slice(0, 3));
  });

  it('keeps RGBA16 at 16 bits', () => {
    const data = new Uint16Array(16 * 4 * 4);
    for (let i = 0; i < 64; i++) data.set([i * 1000, 30000, 65535 - i * 1000, 65535], i * 4);
    const deep = Raster.fromPixels(16, 4, 4, data, { format: 'rgba16' });
    for (const kind of CREATIVE_FILTER_KINDS) expect(applyFilter(kind, deep, transform(16, 4), defaultFilterSettings()).raster.format).toBe('rgba16');
  });
});

describe('creative live filters', () => {
  it('round-trip through the panel settings and are rendered by the CPU stack', () => {
    const source = paint(24, 24, (x, y) => [x * 10, y * 10, 128, 255]);
    for (const kind of CREATIVE) {
      expect(LIVE_FILTER_KINDS).toContain(kind);
      const filter = defaultLiveFilter(kind);
      expect(liveFilterFrom(kind, filterSettingsOf(filter), true)).toEqual(filter);
      expect(isValidLiveFilter(filter)).toBe(true);
      expect(needsCpuLiveFilters([filter])).toBe(true);
      expect(needsCpuLiveFilters([{ ...filter, enabled: false }])).toBe(false);
      const stack = kind === 'bloom' ? [{ ...filter, threshold: 0 } as LiveFilter] : [filter];
      expect(applyLiveFilters(source, stack).toPixels(), kind).not.toEqual(source.toPixels());
    }
    expect(needsCpuLiveFilters([defaultLiveFilter('gaussianBlur')])).toBe(false);
  });

  it('rejects malformed creative records in recipes', () => {
    expect(isValidLiveFilter({ ...defaultLiveFilter('rgbSplit'), radial: 'yes' })).toBe(false);
    expect(isValidLiveFilter({ ...defaultLiveFilter('vignette'), color: { red: 2, green: 0, blue: 0 } })).toBe(false);
    expect(isValidLiveFilter({ ...defaultLiveFilter('bloom'), radius: Number.NaN })).toBe(false);
    expect(isValidLiveFilter({ ...defaultLiveFilter('progressiveBlur'), end: undefined })).toBe(false);
  });

  it('bake into the pixels in one undo step, growing for the glow', () => {
    const session = new EditorSession();
    session.createNewProject(20, 20, 'Bake');
    const id = session.insertRaster(solid(10, 10, [255, 255, 255, 255]), 'White');
    session.replaceDocument({ ...session.document!, layers: session.document!.layers.map((layer) => layer.id === id
      ? { ...layer, filters: [{ ...defaultLiveFilter('bloom'), radius: 2, threshold: 0 } as LiveFilter] } : layer) });
    const undo = session.history.undoCount;
    expect(bakeLiveFilters(session, id)).toBe(true);
    expect(session.history.undoCount).toBe(undo + 1);
    expect(session.layer(id)!.filters).toEqual([]);
    expect(session.layer(id)!.raster!.width).toBeGreaterThan(10);
  });

  it('persist in the .fwimg project and are validated on load', async () => {
    const decoder = async (bytes: Uint8Array) => { const png = decodePng(bytes); return { width: png.width, height: png.height, channels: png.channels, data: png.data }; };
    const filters: LiveFilter[] = [
      { ...defaultLiveFilter('vignette'), color: { red: 0.25, green: 0.5, blue: 1 }, roundness: -40 } as LiveFilter,
      { ...defaultLiveFilter('bloom'), threshold: 70, opacity: 0.5, blendMode: 'screen' } as LiveFilter,
      defaultLiveFilter('tonalContrast'),
      { ...defaultLiveFilter('progressiveBlur'), angle: 45, start: 10, end: 60 } as LiveFilter,
      { ...defaultLiveFilter('rgbSplit'), radial: true, blur: 12, enabled: false } as LiveFilter,
    ];
    const document: CanvasDocument = { id: 'creative', width: 4, height: 3, resolution: 72, selection: null, layers: [
      newLayer({ id: 'pixel', name: 'Pixel', raster: solid(4, 3, [10, 20, 30, 255]), transform: transform(4, 3), filters })] };
    const archived = writeArchive(document, 'Creative', 'pixel');
    const loaded = await readArchive(archived.blob, decoder);
    expect(loaded.document.layers[0]!.filters).toEqual(filters);

    // A broken record makes the project invalid rather than silently dropping the filter.
    const files = unzipSync(new Uint8Array(await archived.blob.arrayBuffer()));
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
    manifest.layers[0].filters[4].radial = 1;
    files['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest));
    await expect(readArchive(new Blob([zipSync(files) as BlobPart]), decoder)).rejects.toThrow();
  });
});
