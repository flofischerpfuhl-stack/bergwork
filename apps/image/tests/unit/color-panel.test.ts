import { describe, expect, it } from 'vitest';
import { EditorSession } from '../../src/core/session';
import { Raster } from '../../src/core/raster';
import { readArchive, writeArchive } from '../../src/io/project';
import {
  addGroup, addSwatch, appendGroups, deleteGroup, deleteSwatch, documentSwatches, editDocumentSwatches, newSwatch, renameGroup,
  renameSwatch, validSwatchGroups, type SwatchGroup,
} from '../../src/core/color/swatches';
import { noteColorUsed, onColorUsed, pushRecentColor, RECENT_COLOR_LIMIT, validRecentColors } from '../../src/core/color/recent';
import { averageStraightRgba, sampleColor, sampleRect } from '../../src/core/color/sample';
import {
  cmykToRgbNaive, hsbKeepingHue, hsbToRgb, parseColorText, rgbToCmykNaive, rgbToHex, rgbToHsb,
} from '../../src/core/color/convert';
import { fillSelection } from '../../src/core/selectionCommands';

const decoder = async () => { throw new Error('no external decoding in this test'); };
const rgb = (r: number, g: number, b: number) => ({ red: r / 255, green: g / 255, blue: b / 255 });

describe('swatch groups', () => {
  it('adds, renames and deletes swatches and groups without changing the input', () => {
    const empty: SwatchGroup[] = [];
    const first = addSwatch(empty, null, newSwatch(rgb(255, 0, 0), 'Red'), 'Swatches');
    expect(first.groups).toHaveLength(1);
    expect(first.groups[0]!.name).toBe('Swatches');
    expect(empty).toHaveLength(0);
    const withGroup = addGroup(first.groups, 'Brand');
    const second = addSwatch(withGroup.groups, withGroup.id, newSwatch(rgb(0, 0, 255), 'Blue'), 'x');
    expect(second.groupId).toBe(withGroup.id);
    const blueId = second.groups[1]!.swatches[0]!.id;
    const renamed = renameGroup(renameSwatch(second.groups, blueId, 'Navy'), withGroup.id, 'Brand 2');
    expect(renamed[1]).toMatchObject({ name: 'Brand 2', swatches: [{ name: 'Navy' }] });
    expect(deleteSwatch(renamed, blueId)[1]!.swatches).toHaveLength(0);
    expect(deleteGroup(renamed, withGroup.id).map((g) => g.name)).toEqual(['Swatches']);
    expect(validSwatchGroups(renamed)).toBe(true);
  });

  it('validates untrusted groups', () => {
    const good = appendGroups([], [{ name: 'Imported', swatches: [{ name: 'A', color: rgb(1, 2, 3) }] }]);
    expect(validSwatchGroups(good)).toBe(true);
    expect(validSwatchGroups([{ id: 'g', name: 'x', swatches: [{ id: 's', name: 'y', color: { red: 2, green: 0, blue: 0 } }] }])).toBe(false);
    expect(validSwatchGroups([{ id: 'g', name: 'x', swatches: [{ id: 'g', name: 'dup', color: rgb(0, 0, 0) }] }])).toBe(false);
    expect(validSwatchGroups({})).toBe(false);
    // Importing the same file twice gives fresh ids.
    const twice = appendGroups(good, [{ name: 'Imported', swatches: [{ name: 'A', color: rgb(1, 2, 3) }] }]);
    expect(validSwatchGroups(twice)).toBe(true);
  });

  it('are document state: each change is one undo step, and undo/redo restore them', () => {
    const session = new EditorSession();
    session.createNewProject(20, 10, 'Swatches');
    const before = session.history.pastNames.length;
    expect(editDocumentSwatches(session, 'New Swatch', (g) => addSwatch(g, null, newSwatch(rgb(10, 20, 30), 'Ink'), 'Swatches').groups)).toBe(true);
    expect(documentSwatches(session)[0]!.swatches[0]!.name).toBe('Ink');
    expect(session.history.pastNames.slice(before)).toEqual(['New Swatch']);
    // No-op changes record nothing.
    expect(editDocumentSwatches(session, 'Nothing', (g) => g)).toBe(false);
    session.undo();
    expect(session.document!.swatches).toBeUndefined();
    session.redo();
    expect(documentSwatches(session)[0]!.swatches[0]!.color).toEqual(rgb(10, 20, 30));
    // Changing the foreground colour is app state: no undo step.
    const steps = session.history.pastNames.length;
    session.setPaletteColor(rgb(1, 2, 3), false);
    expect(session.history.pastNames.length).toBe(steps);
  });

  it('are saved in .fwimg and in every history snapshot', async () => {
    const session = new EditorSession();
    session.createNewProject(20, 10, 'Swatches');
    session.insertRaster(Raster.fromPixels(2, 2, 4, new Uint8Array(16).fill(200)), 'Pixels');
    editDocumentSwatches(session, 'New Swatch', (g) => addSwatch(g, null, newSwatch(rgb(255, 128, 0), 'Orange'), 'Brand').groups);
    editDocumentSwatches(session, 'Rename Swatch', (g) => renameSwatch(g, g[0]!.swatches[0]!.id, 'Signal'));
    const archive = writeArchive(session.document!, 'Swatches', session.activeLayerId, session.history.exportState());
    expect(archive.manifest.swatches?.[0]).toMatchObject({ name: 'Brand', swatches: [{ name: 'Signal' }] });
    const loaded = await readArchive(archive.blob, decoder);
    expect(loaded.document.swatches).toEqual(session.document!.swatches);
    const past = loaded.history!.past;
    const rename = past.find((step) => step.name === 'Rename Swatch')!;
    expect(rename.before.document!.swatches![0]!.swatches[0]!.name).toBe('Orange');
    expect(rename.after.document!.swatches![0]!.swatches[0]!.name).toBe('Signal');
    const added = past.find((step) => step.name === 'New Swatch')!;
    expect(added.before.document!.swatches).toBeUndefined();
    // Reopened, undo still restores the previous swatches.
    const reopened = new EditorSession();
    reopened.installProject(loaded.document, loaded.activeLayerId, 'Swatches', loaded.history);
    reopened.undo();
    expect(documentSwatches(reopened)[0]!.swatches[0]!.name).toBe('Orange');
  });

  it('reject invalid swatches in a project file', async () => {
    const session = new EditorSession();
    session.createNewProject(4, 4, 'Bad');
    const archive = writeArchive({ ...session.document!, swatches: [{ id: 'g', name: 'G', swatches: [{ id: 's', name: 'S', color: { red: 5, green: 0, blue: 0 } }] }] }, 'Bad', null);
    await expect(readArchive(archive.blob, decoder)).rejects.toThrow();
  });
});

describe('recent colours', () => {
  it('keeps the last 12 distinct colours, most recent first', () => {
    let list = pushRecentColor([], rgb(1, 1, 1));
    list = pushRecentColor(list, rgb(2, 2, 2));
    expect(list.map(rgbToHex)).toEqual(['020202', '010101']);
    const same = pushRecentColor(list, rgb(2, 2, 2));
    expect(same).toBe(list);
    list = pushRecentColor(list, rgb(1, 1, 1));
    expect(list.map(rgbToHex)).toEqual(['010101', '020202']);
    for (let i = 10; i < 30; i++) list = pushRecentColor(list, rgb(i, 0, 0));
    expect(list).toHaveLength(RECENT_COLOR_LIMIT);
    expect(rgbToHex(list[0]!)).toBe('1D0000');
    expect(validRecentColors(list)).toBe(true);
    expect(validRecentColors([{ red: 'x' }])).toBe(false);
  });

  it('are announced when a fill uses the foreground colour', () => {
    const session = new EditorSession();
    session.createNewProject(4, 4, 'Fill');
    session.insertRaster(Raster.fromPixels(4, 4, 4, new Uint8Array(64)), 'Layer');
    session.setPaletteColor(rgb(12, 34, 56), false);
    const heard: string[] = [];
    const off = onColorUsed((source, color) => { if (source === session) heard.push(rgbToHex(color)); });
    fillSelection(session, 'foreground');
    fillSelection(session, 'background');
    noteColorUsed({}, rgb(0, 0, 0));
    off();
    expect(heard).toEqual(['0C2238']);
  });
});

describe('eyedropper sampling', () => {
  it('clips the sample square to the canvas and averages by alpha', () => {
    expect(sampleRect({ x: 0.5, y: 0.5 }, 5, 10, 10)).toEqual({ x: 0, y: 0, width: 3, height: 3 });
    expect(sampleRect({ x: 4.2, y: 5.9 }, 3, 10, 10)).toEqual({ x: 3, y: 4, width: 3, height: 3 });
    expect(sampleRect({ x: -1, y: 2 }, 1, 10, 10)).toBeNull();
    expect(averageStraightRgba([255, 0, 0, 255, 0, 0, 255, 255])).toEqual(rgb(128, 0, 128));
    expect(averageStraightRgba([255, 255, 255, 0, 10, 20, 30, 255])).toEqual(rgb(10, 20, 30));
    expect(averageStraightRgba([1, 2, 3, 0])).toBeNull();
  });

  it('samples the composite through the reader, or the current layer on its own', () => {
    const session = new EditorSession();
    session.createNewProject(10, 10, 'Sample');
    // Left half black, right half white, on the current layer.
    const pixels = new Uint8Array(10 * 10 * 4);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) pixels.set(x >= 5 ? [255, 255, 255, 255] : [0, 0, 0, 255], (y * 10 + x) * 4);
    session.insertRaster(Raster.fromPixels(10, 10, 4, pixels), 'Split');
    const current = { allLayers: false } as const;
    expect(sampleColor(session, { x: 4.5, y: 5 }, { ...current, size: 1 }, null)).toEqual(rgb(0, 0, 0));
    expect(rgbToHex(sampleColor(session, { x: 4.5, y: 5 }, { ...current, size: 3 }, null)!)).toBe('555555');
    expect(rgbToHex(sampleColor(session, { x: 4.5, y: 5 }, { ...current, size: 5 }, null)!)).toBe('666666');
    // All layers: whatever the composite reader returns (here a flat red canvas).
    const reads: number[][] = [];
    const reader = (x: number, y: number, w: number, h: number) => { reads.push([x, y, w, h]); return new Uint8Array(w * h * 4).map((_, i) => (i % 4 === 0 || i % 4 === 3 ? 255 : 0)); };
    expect(sampleColor(session, { x: 4.5, y: 5 }, { allLayers: true, size: 3 }, reader)).toEqual(rgb(255, 0, 0));
    expect(reads).toEqual([[3, 4, 3, 3]]);
  });
});

describe('colour models', () => {
  it('HSB, naive CMYK and hex conversions', () => {
    expect(rgbToHex(hsbToRgb({ hue: 210, saturation: 0.5, brightness: 0.8 }))).toBe('6699CC');
    expect(rgbToHsb(rgb(102, 153, 204)).hue).toBeCloseTo(210, 5);
    expect(hsbKeepingHue(rgb(0, 0, 0), { hue: 40, saturation: 0.7, brightness: 0.5 })).toEqual({ hue: 40, saturation: 0.7, brightness: 0 });
    expect(hsbKeepingHue(rgb(128, 128, 128), { hue: 40, saturation: 0.7, brightness: 0.5 }).hue).toBe(40);
    expect(rgbToCmykNaive(rgb(255, 0, 0))).toEqual({ c: 0, m: 1, y: 1, k: 0 });
    expect(rgbToCmykNaive(rgb(0, 0, 0))).toEqual({ c: 0, m: 0, y: 0, k: 1 });
    expect(rgbToHex(cmykToRgbNaive(rgbToCmykNaive(rgb(40, 90, 200))))).toBe('285AC8');
    expect(parseColorText('#abc')).toEqual(rgb(0xaa, 0xbb, 0xcc));
    expect(parseColorText('rgb(1, 2, 3)')).toEqual(rgb(1, 2, 3));
    expect(parseColorText('12345')).toBeNull();
  });
});
