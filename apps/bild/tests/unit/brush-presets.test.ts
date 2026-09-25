import { describe, expect, it } from 'vitest';
import { AbrError, parseAbr, unpackBits } from '../../src/io/abr';
import {
  DEFAULT_BRUSH_DYNAMICS, DEFAULT_BRUSH_SETTINGS, applyBrushPreset, beginStroke, defaultBrushPresets, parseBrushPresets,
  presetFromSettings, presetsFromAbr, serializeBrushPresets, settingsMatchPreset, stepBrushSize, stepBrushHardness,
  type BrushPreset,
} from '../../src/core/brush';
import { documentBrushPresets, editDocumentBrushPresets } from '../../src/core/brush/documentPresets';
import { newLayer } from '../../src/core/document';
import { makeTransform } from '../../src/core/geometry';
import { EditorSession } from '../../src/core/session';
import { readArchive, writeArchive } from '../../src/io/project';
import { decodePng } from '../../src/io/png';
import { loadBrushLibrary, memoryTipStore, saveBrushLibrary, type KeyValueStore } from '../../src/app/brush/storage';
import { abrV12, abrV6, checkerTip, gradientTip, packBits, ringTipData } from './abrFixtures';

describe('.abr parser (generated files)', () => {
  it('PackBits round trip, including runs, literals and the -128 no-op', () => {
    const row = Uint8Array.from([0, 0, 0, 0, 5, 6, 7, 255, 255, 255, 1, ...new Array(200).fill(9), 3]);
    const out = new Uint8Array(row.length);
    unpackBits(packBits(row), out);
    expect(out).toEqual(row);
    const noop = new Uint8Array(2);
    unpackBits(Uint8Array.from([0x80, 0xff, 7]), noop);
    expect(Array.from(noop)).toEqual([7, 7]);
  });

  it('reads v1 computed and raw sampled brushes', () => {
    const tip = checkerTip(12, 8, 3);
    const result = parseAbr(abrV12(1, [
      { computed: { spacing: 25, diameter: 45, roundness: 60, angle: -30, hardness: 80 } },
      { sampled: { width: 12, height: 8, data: tip, spacing: 40 } },
    ]));
    expect(result).toMatchObject({ version: 1, skipped: 0 });
    expect(result.brushes[0]).toMatchObject({ kind: 'computed', diameter: 45, spacing: 0.25, hardness: 0.8, angle: -30, roundness: 0.6 });
    expect(result.brushes[1]).toMatchObject({ kind: 'sampled', diameter: 12, spacing: 0.4 });
    expect(result.brushes[1]!.image).toEqual({ width: 12, height: 8, data: tip });
  });

  it('reads v2 names, PackBits and 16-bit samples, and skips unreadable brushes', () => {
    const ring = ringTipData(40), gradient = gradientTip(33, 17);
    const result = parseAbr(abrV12(2, [
      { name: 'Ring', sampled: { width: 40, height: 40, data: ring, spacing: 25, rle: true } },
      { name: 'Gradient 16', sampled: { width: 33, height: 17, data: gradient, spacing: 0, depth: 16, rle: true } },
      { name: 'Deep', sampled: { width: 4, height: 4, data: new Uint8Array(16), spacing: 25, depth: 32 } },
      { name: 'Raw 16', sampled: { width: 5, height: 3, data: gradientTip(5, 3), spacing: 100, depth: 16 } },
    ]));
    expect(result.skipped).toBe(1);
    expect(result.brushes.map((brush) => brush.name)).toEqual(['Ring', 'Gradient 16', 'Raw 16']);
    expect(result.brushes[0]!.image!.data).toEqual(ring);
    expect(result.brushes[1]!.image!.data).toEqual(gradient);
    expect(result.brushes[1]!.spacing).toBeNull();
    expect(result.brushes[2]!.image!.data).toEqual(gradientTip(5, 3));
    expect(result.brushes[2]!.spacing).toBe(1);
  });

  for (const subversion of [1, 2] as const) {
    it(`reads v6.${subversion}: samples linked by UUID to descriptor presets, computed presets, stray samples`, () => {
      const ring = ringTipData(64), checker = checkerTip(20, 30, 5);
      const bytes = abrV6(subversion, [
        { uuid: '$aaaaaaaa-1111-2222-3333-444444444444', width: 64, height: 64, data: ring, rle: true },
        { uuid: '$bbbbbbbb-1111-2222-3333-444444444444', width: 20, height: 30, data: checker, depth: 16 },
        { uuid: '$cccccccc-1111-2222-3333-444444444444', width: 3, height: 3, data: new Uint8Array(9).fill(200) },
      ], [
        { name: 'Ring Stamp', uuid: '$aaaaaaaa-1111-2222-3333-444444444444', diameter: 50, spacing: 30, angle: 15, roundness: 70 },
        { name: 'Round 19', diameter: 19, spacing: 25, hardness: 40, roundness: 100 },
        { name: 'Checker', uuid: '$bbbbbbbb-1111-2222-3333-444444444444', diameter: 30, spacing: 200 },
      ], { extraSection: true });
      const result = parseAbr(bytes);
      expect(result).toMatchObject({ version: 6, subversion, skipped: 0 });
      expect(result.brushes.map((brush) => [brush.name, brush.kind])).toEqual([
        ['Ring Stamp', 'sampled'], ['Round 19', 'computed'], ['Checker', 'sampled'], ['', 'sampled']]);
      expect(result.brushes[0]).toMatchObject({ diameter: 50, spacing: 0.3, angle: 15, roundness: 0.7 });
      expect(result.brushes[0]!.image!.data).toEqual(ring);
      expect(result.brushes[1]).toMatchObject({ diameter: 19, hardness: 0.4, spacing: 0.25 });
      expect(result.brushes[2]!.image).toEqual({ width: 20, height: 30, data: checker });
      expect(result.brushes[3]!.image!.data).toEqual(new Uint8Array(9).fill(200));
    });
  }

  it('reads v6 without a descriptor and newer version numbers, reduces oversized tips', () => {
    const big = new Uint8Array(3000 * 20).fill(255);
    const result = parseAbr(abrV6(2, [{ uuid: '$x', width: 3000, height: 20, data: big, rle: true }], null, { version: 10 }));
    expect(result.version).toBe(10);
    expect(result.brushes).toHaveLength(1);
    expect(result.brushes[0]!.image).toMatchObject({ width: 1500, height: 10 });
    expect(result.brushes[0]!.image!.data.every((value) => value === 255)).toBe(true);
    expect(result.brushes[0]!.spacing).toBe(0.25);
  });

  it('rejects unknown versions and truncated files with AbrError', () => {
    expect(() => parseAbr(Uint8Array.from([0, 3, 0, 1]))).toThrow(AbrError);
    const valid = abrV12(2, [{ name: 'X', sampled: { width: 10, height: 10, data: new Uint8Array(100), spacing: 25 } }]);
    expect(() => parseAbr(valid.subarray(0, valid.length - 20))).toThrow(AbrError);
    expect(() => parseAbr(new Uint8Array(2))).toThrow(AbrError);
  });

  it('turns imported brushes into presets that paint the sampled tip', () => {
    const result = parseAbr(abrV12(2, [{ name: 'Ring', sampled: { width: 64, height: 64, data: ringTipData(64), spacing: 25, rle: true } },
      { computed: { spacing: 0, diameter: 3000, roundness: 100, angle: 0, hardness: 100 } }]));
    const presets = presetsFromAbr(result, 'MyBrushes');
    expect(presets.map((preset) => preset.name)).toEqual(['Ring', 'MyBrushes 2']);
    expect(presets[1]!).toMatchObject({ diameter: 2000, tip: { kind: 'round' }, dynamics: { spacing: null } });
    const settings = applyBrushPreset({ ...DEFAULT_BRUSH_SETTINGS, red: 0, green: 1, blue: 0 }, presets[0]!);
    const layer = newLayer({ id: 'l', name: 'L', raster: null, transform: makeTransform({ x: 0, y: 0 }, { width: 100, height: 100 }) });
    const stroke = beginStroke({ layer, canvas: { width: 100, height: 100 }, settings });
    stroke.addPoints([{ x: 50, y: 50 }]);
    const raster = stroke.currentRaster();
    expect(raster.pixel(50, 50)[3]).toBe(0);
    expect(raster.pixel(50 + 22, 50)).toEqual([0, 255, 0, 255]);
  });
});

describe('brush presets', () => {
  it('ships generated defaults with textured tips and applies a preset without touching colour or mode', () => {
    const defaults = defaultBrushPresets();
    expect(defaults.map((preset) => preset.id)).toContain('builtin-chalk');
    expect(defaults.filter((preset) => preset.tip.kind === 'sampled').length).toBeGreaterThanOrEqual(4);
    expect(defaultBrushPresets()).toBe(defaults);
    const base = { ...DEFAULT_BRUSH_SETTINGS, red: 0.3, mode: 'erase' as const };
    const applied = applyBrushPreset(base, defaults.find((preset) => preset.id === 'builtin-spatter')!);
    expect(applied).toMatchObject({ red: 0.3, mode: 'erase', diameter: 70 });
    expect(settingsMatchPreset(applied, defaults.find((preset) => preset.id === 'builtin-spatter')!)).toBe(true);
    expect(settingsMatchPreset(stepBrushSize(applied, true), defaults.find((preset) => preset.id === 'builtin-spatter')!)).toBe(false);
    // The default brush is the Hard Round preset; [ ] and Shift-[ ] keep working on preset brushes.
    expect(settingsMatchPreset(DEFAULT_BRUSH_SETTINGS, defaults[0]!)).toBe(true);
    expect(stepBrushHardness({ ...applied, hardness: 0.5 }, false).hardness).toBe(0.25);
  });

  it('serializes presets with compressed tips and drops damaged ones on parse', () => {
    const presets: BrushPreset[] = [...defaultBrushPresets().slice(4, 6),
      presetFromSettings({ ...DEFAULT_BRUSH_SETTINGS, dynamics: { ...DEFAULT_BRUSH_DYNAMICS, scatter: 2 } }, 'Mine')];
    const json = JSON.parse(JSON.stringify(serializeBrushPresets(presets)));
    const parsed = parseBrushPresets(json);
    expect(parsed).toEqual(presets);
    json.presets[1].tip.image.zlib = 'AAAA';
    json.presets[2].dynamics.flow = 5;
    expect(parseBrushPresets(json).map((preset) => preset.name)).toEqual([presets[0]!.name]);
    expect(parseBrushPresets({ format: 'other' })).toEqual([]);
  });

  it('persists the library: order, renames, deleted built-ins, sampled tips in the tip store', async () => {
    const values = new Map<string, string>();
    const kv: KeyValueStore = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
    const tips = memoryTipStore();
    const first = loadBrushLibrary(kv, tips);
    expect(first.immediate.length).toBe(defaultBrushPresets().length);
    const imported = presetsFromAbr(parseAbr(abrV12(2, [{ name: 'Ring', sampled: { width: 64, height: 64, data: ringTipData(64), spacing: 25 } }])), 'X');
    const library = [...imported, ...(await first.complete).filter((preset) => preset.id !== 'builtin-grass')
      .map((preset) => (preset.id === 'builtin-chalk' ? { ...preset, name: 'My Chalk' } : preset))];
    await saveBrushLibrary(library, kv, tips);
    expect(values.get('fernwork.brushPresets')!.length).toBeLessThan(20_000);
    // Built-in tips are regenerated, never stored; only the imported tip goes to the tip store.
    expect(await tips.ids()).toEqual([imported[0]!.tip.kind === 'sampled' ? imported[0]!.tip.image.id : '']);
    const second = loadBrushLibrary(kv, tips);
    expect(second.immediate.some((preset) => preset.id === imported[0]!.id)).toBe(false);
    const restored = await second.complete;
    expect(restored).toEqual(library);
    // Deleting the imported preset removes its tip from the store.
    await saveBrushLibrary(restored.slice(1), kv, tips);
    expect(await tips.ids()).not.toContain(imported[0]!.tip.kind === 'sampled' ? imported[0]!.tip.image.id : '');
  });

  it('keeps presets in the document as one undo step per change', () => {
    const session = new EditorSession();
    session.createDocument(64, 64);
    const preset = defaultBrushPresets().find((value) => value.id === 'builtin-bristle')!;
    expect(documentBrushPresets(session.document)).toEqual([]);
    const undoCount = session.history.undoCount;
    expect(editDocumentBrushPresets(session, 'New Brush Preset', (list) => [...list, { ...preset, id: 'doc-1' }])).toBe(true);
    expect(session.history.undoCount).toBe(undoCount + 1);
    const stored = documentBrushPresets(session.document);
    expect(stored.map((value) => value.id)).toEqual(['doc-1']);
    expect(stored[0]!.tip).toEqual(preset.tip);
    expect(session.document!.resources!.filter((resource) => resource.role === 'brushes')).toHaveLength(1);
    session.undo();
    expect(documentBrushPresets(session.document)).toEqual([]);
    session.redo();
    expect(documentBrushPresets(session.document)[0]!.name).toBe(preset.name);
  });

  it('saves document presets (sampled tips included) in .fwimg and reads them back', async () => {
    const session = new EditorSession();
    session.createDocument(32, 32);
    const imported = presetsFromAbr(parseAbr(abrV12(2, [{ name: 'Ring', sampled: { width: 64, height: 64, data: ringTipData(64), spacing: 25 } }])), 'X');
    editDocumentBrushPresets(session, 'Import Brushes', () => [...imported, defaultBrushPresets()[4]!]);
    const archive = writeArchive(session.document!, 'Presets', 'text');
    const decoder = async (bytes: Uint8Array) => { const png = decodePng(bytes); return { width: png.width, height: png.height, channels: png.channels, data: png.data }; };
    const loaded = await readArchive(archive.blob, decoder);
    const presets = documentBrushPresets(loaded.document);
    expect(presets).toEqual([...imported, defaultBrushPresets()[4]!]);
    expect(loaded.document.resources?.find((resource) => resource.role === 'brushes')?.mime).toBe('application/vnd.fernwork.brush-presets+json');
  });
});
