/**
 * Interoperability with Compositor's macOS `.comp` directory packages.
 *
 * The schema and validation below follow `IO/ProjectStore.swift` (`validate`,
 * `readPackage`) and `docs/project-format.md`. A browser receives the package
 * either as relative files or as a ZIP, so filesystem/symlink checks become
 * strict member-name checks.
 */

import { unzipSync, zipSync, type Zippable } from 'fflate';
import { isValidAdjustment } from '../core/adjustments';
import {
  BLEND_MODES, hierarchyRecord, InvalidProjectError, MAX_LAYERS, MAX_PIXELS, MAX_SIDE, newLayer,
  validateHierarchy, validateLiveMasks, type BlendMode, type CanvasDocument, type Layer,
  type LayerAdjustment, type LayerShape,
} from '../core/document';
import { isValidTransform, LAYER_SAMPLINGS, type LayerTransform } from '../core/geometry';
import { Raster } from '../core/raster';
import { decodePng, encodePng, PngError, type PngResult } from './png';
import { ProjectError } from './project';
import { sha256Hex } from './sha256';

export const COMP_FORMAT = 'com.compositor.project';
export const COMP_CURRENT_VERSION = 7;

const MANIFEST_LIMIT = 4 * 1024 * 1024;
const ASSET_LIMIT = 512 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

const blendFromLabel = new Map(BLEND_MODES.map(({ mode, label }) => [label, mode]));
const blendToLabel = new Map(BLEND_MODES.map(({ mode, label }) => [mode, label]));

export interface CompLayerRecord {
  id: string;
  name: string;
  isVisible: boolean;
  transform: LayerTransform;
  imageFile?: string;
  parentID?: string;
  isGroup?: boolean;
  opacity?: number;
  blendMode?: string;
  maskFile?: string;
  maskEnabled?: boolean;
  maskSourceID?: string;
  adjustment?: LayerAdjustment;
  maskPlacement?: LayerTransform;
  maskLinked?: boolean;
  shape?: LayerShape;
}

export interface CompManifest {
  format: typeof COMP_FORMAT;
  version: number;
  colorSpace: 'sRGB';
  resolution?: number;
  documentID: string;
  width: number;
  height: number;
  activeLayerID?: string;
  layers: CompLayerRecord[];
}

export interface LoadedCompPackage {
  document: CanvasDocument;
  /** Package-directory name without the `.comp` suffix, or `Untitled` for bare maps. */
  name: string;
  activeLayerId: string | null;
  version: number;
}

export interface CompWriteOptions {
  name?: string;
  activeLayerId?: string | null;
}

interface ParsedLayer extends CompLayerRecord {
  blend: BlendMode;
  parentID?: string;
  maskSourceID?: string;
}

function invalid(_detail: string): never {
  // Legacy compatibility: upstream tests and callers compare this v1–v7 import error verbatim.
  throw new ProjectError('invalid', 'This is not a valid Compositor project, or its metadata is damaged.');
}

function tooLarge(): never {
  throw new ProjectError('too-large', 'This project exceeds the supported canvas, layer, file-size, or 100-megapixel image limit.');
}

function missingImage(): never {
  throw new ProjectError('missing-image', 'An image inside the project is missing or damaged. The current document has not been replaced.');
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function optionalString(value: unknown): value is string | null | undefined { return value == null || typeof value === 'string'; }
function optionalBoolean(value: unknown): value is boolean | null | undefined { return value == null || typeof value === 'boolean'; }

/** Foundation decodes UUID strings case-insensitively and exposes canonical uppercase UUID strings. */
function uuid(value: unknown, detail: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) invalid(detail);
  return value.toUpperCase();
}

function optionalUuid(value: unknown, detail: string): string | undefined {
  return value == null ? undefined : uuid(value, detail);
}

function parseTransform(value: unknown, detail: string): LayerTransform {
  if (!object(value) || !object(value.origin) || !object(value.size)
    || !finite(value.origin.x) || !finite(value.origin.y)
    || !finite(value.size.width) || !finite(value.size.height) || !finite(value.rotation)
    || typeof value.flipX !== 'boolean' || typeof value.flipY !== 'boolean'
    || typeof value.sampling !== 'string' || !LAYER_SAMPLINGS.includes(value.sampling as LayerTransform['sampling'])) {
    invalid(detail);
  }
  const transform: LayerTransform = {
    origin: { x: value.origin.x, y: value.origin.y },
    size: { width: value.size.width, height: value.size.height },
    rotation: value.rotation,
    flipX: value.flipX,
    flipY: value.flipY,
    sampling: value.sampling as LayerTransform['sampling'],
  };
  if (!isValidTransform(transform)) invalid(detail);
  return transform;
}

function parseShape(value: unknown): LayerShape {
  // LayerShapeStyle's synthesized Codable representation (ShapeTool.swift).
  if (!object(value) || (value.kind !== 'Rectangle' && value.kind !== 'Ellipse')
    || !finite(value.red) || !finite(value.green) || !finite(value.blue) || !finite(value.cornerRadius)) {
    invalid('shape');
  }
  return value as LayerShape;
}

function parseAdjustment(value: unknown): LayerAdjustment {
  const adjustment = value as LayerAdjustment;
  let valid = false;
  try { valid = object(value) && isValidAdjustment(adjustment); } catch { /* malformed nested Codable record */ }
  if (!valid) invalid('adjustment');
  return adjustment;
}

function safeMember(path: string): boolean {
  if (!path || path.length > 1024 || path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path)
    || path.includes('\\') || /[\u0000-\u001f]/.test(path)) return false;
  const pieces = path.split('/');
  if (pieces.at(-1) === '') pieces.pop();
  return pieces.length > 0 && pieces.every((piece) => piece !== '' && piece !== '.' && piece !== '..');
}

function packageFiles(input: Map<string, Uint8Array>): { files: Map<string, Uint8Array>; name: string } {
  const entries: [string, Uint8Array][] = [];
  for (const [path, bytes] of input) {
    if (!safeMember(path)) invalid('unsafe package path');
    if (!path.endsWith('/')) entries.push([path, bytes]);
  }
  if (entries.some(([path]) => path === 'manifest.json')) return { files: new Map(entries), name: 'Untitled' };

  const roots = new Set(entries.map(([path]) => path.slice(0, path.indexOf('/') < 0 ? path.length : path.indexOf('/'))));
  if (roots.size !== 1) invalid('manifest.json is missing');
  const root = [...roots][0]!;
  if (!root.toLowerCase().endsWith('.comp')) invalid('manifest.json is missing');
  const prefix = `${root}/`;
  if (!entries.every(([path]) => path.startsWith(prefix))) invalid('mixed package roots');
  return {
    files: new Map(entries.map(([path, bytes]) => [path.slice(prefix.length), bytes])),
    name: root.slice(0, -5) || 'Untitled',
  };
}

function parseManifest(bytes: Uint8Array): { manifest: CompManifest; layers: ParsedLayer[] } {
  if (bytes.byteLength > MANIFEST_LIMIT) tooLarge();
  let raw: unknown;
  try { raw = JSON.parse(decoder.decode(bytes)) as unknown; } catch { invalid('manifest is not JSON'); }
  if (!object(raw) || typeof raw.format !== 'string' || !Number.isInteger(raw.version)) invalid('manifest header');
  if (raw.format !== COMP_FORMAT) invalid('unknown format');
  const version = raw.version as number;
  if (version < 1 || version > COMP_CURRENT_VERSION) {
    throw new ProjectError('version', `This project uses format version ${version}. This app supports versions 1–${COMP_CURRENT_VERSION}.`);
  }
  if (raw.colorSpace !== 'sRGB') invalid('colour space');
  if (!Number.isInteger(raw.width) || !Number.isInteger(raw.height)
    || (raw.width as number) < 1 || (raw.height as number) < 1
    || (raw.width as number) > MAX_SIDE || (raw.height as number) > MAX_SIDE) tooLarge();
  if (!Array.isArray(raw.layers)) invalid('layers');
  if (raw.layers.length > MAX_LAYERS) tooLarge();
  if (raw.resolution != null && (!finite(raw.resolution) || raw.resolution < 1 || raw.resolution > 9600)) invalid('resolution');

  const documentID = uuid(raw.documentID, 'document id');
  const activeLayerID = optionalUuid(raw.activeLayerID, 'active layer id');
  const ids = new Set<string>();
  const layers: ParsedLayer[] = raw.layers.map((entry, index) => {
    if (!object(entry)) invalid(`layer ${index}`);
    const id = uuid(entry.id, `layer ${index} id`);
    if (ids.has(id)) invalid('duplicate layer id');
    ids.add(id);
    if (typeof entry.name !== 'string' || !entry.name.trim() || encoder.encode(entry.name).byteLength > 16_384) invalid('layer name');
    if (typeof entry.isVisible !== 'boolean') invalid('layer visibility');
    if (!optionalString(entry.imageFile) || !optionalString(entry.maskFile)
      || !optionalBoolean(entry.isGroup) || !optionalBoolean(entry.maskEnabled) || !optionalBoolean(entry.maskLinked)) {
      invalid('layer field type');
    }
    const parentID = optionalUuid(entry.parentID, 'parent id');
    const maskSourceID = optionalUuid(entry.maskSourceID, 'mask source id');
    const isGroup = entry.isGroup === true;
    const opacity = entry.opacity == null ? 1 : entry.opacity;
    if (!finite(opacity) || opacity < 0 || opacity > 1) invalid('opacity');
    const blendLabel = entry.blendMode == null ? 'Normal' : entry.blendMode;
    if (typeof blendLabel !== 'string') invalid('blend mode');
    const blend = blendFromLabel.get(blendLabel);
    if (!blend) invalid('blend mode');
    const transform = parseTransform(entry.transform, 'layer transform');
    const imageFile = typeof entry.imageFile === 'string' ? entry.imageFile : undefined;
    const maskFile = typeof entry.maskFile === 'string' ? entry.maskFile : undefined;
    const maskPlacement = entry.maskPlacement == null ? undefined : parseTransform(entry.maskPlacement, 'mask placement');

    // ProjectStore.validate: schema additions are version-gated, and groups are pass-through.
    if (imageFile !== undefined && imageFile !== `${id}.png`) invalid('image filename');
    if (isGroup && imageFile !== undefined) invalid('group with image');
    if (version === 1 && (parentID !== undefined || isGroup)) invalid('version 1 hierarchy');
    if (version < 3 && (opacity !== 1 || blend !== 'normal')) invalid('appearance before version 3');
    if (isGroup && (opacity !== 1 || blend !== 'normal')) invalid('group appearance');
    if (maskFile !== undefined && (version < (isGroup ? 6 : 4) || maskFile !== `${id}.mask.png`)) invalid('mask filename or version');
    if (entry.maskEnabled != null && maskFile === undefined) invalid('mask enabled without mask');
    if (maskPlacement && maskFile === undefined) invalid('mask placement without mask');
    if (version < 5 && maskSourceID !== undefined) invalid('live mask before version 5');

    const adjustment = entry.adjustment == null ? undefined : parseAdjustment(entry.adjustment);
    if (adjustment && (version < 7 || isGroup || imageFile !== undefined)) invalid('adjustment layer');
    const shape = entry.shape == null ? undefined : parseShape(entry.shape);

    return {
      id, name: entry.name, isVisible: entry.isVisible, transform, imageFile, parentID,
      isGroup: entry.isGroup == null ? undefined : isGroup, opacity, blendMode: blendLabel, blend,
      maskFile, maskEnabled: entry.maskEnabled == null ? undefined : entry.maskEnabled,
      maskSourceID, adjustment, maskPlacement,
      maskLinked: entry.maskLinked == null ? undefined : entry.maskLinked,
      shape,
    };
  });

  if (activeLayerID && !ids.has(activeLayerID)) invalid('active layer');
  const structure = layers.map((layer) => ({
    id: layer.id, parentId: layer.parentID ?? null, isGroup: layer.isGroup === true,
    hasImage: layer.imageFile !== undefined, maskSourceId: layer.maskSourceID ?? null,
    isAdjustment: layer.adjustment !== undefined,
  }));
  try { validateHierarchy(structure); validateLiveMasks(structure); } catch (error) {
    if (error instanceof InvalidProjectError) invalid('layer hierarchy or clipping graph');
    throw error;
  }

  return {
    manifest: {
      format: COMP_FORMAT, version, colorSpace: 'sRGB', documentID,
      width: raw.width as number, height: raw.height as number,
      ...(raw.resolution == null ? {} : { resolution: raw.resolution as number }),
      ...(activeLayerID ? { activeLayerID } : {}), layers,
    },
    layers,
  };
}

function decodeAsset(files: Map<string, Uint8Array>, filename: string, mask: boolean): { raster: Raster; pixels: number } {
  const path = `images/${filename}`;
  if (!safeMember(path)) invalid('unsafe asset path');
  const bytes = files.get(path);
  if (!bytes) missingImage();
  if (bytes.byteLength > ASSET_LIMIT) tooLarge();
  // CGImageSourceGetCount(source) must be one in ProjectStore.readPackage.
  if (hasPngChunk(bytes, 'acTL')) missingImage();
  let png: PngResult;
  try { png = decodePng(bytes); } catch (error) {
    if (error instanceof PngError && error.code === 'dimensions') tooLarge();
    missingImage();
  }
  // ImageIO rejects sources deeper than eight bits before decoding in ProjectStore.readPackage.
  if (png.bitDepth > 8) missingImage();
  if (mask && (png.bitDepth !== 8 || png.channels !== 1 || png.colorType !== 0 || png.hasAlpha)) {
    invalid('mask is not 8-bit grayscale');
  }

  let data = png.data;
  let channels: 1 | 4 = png.channels;
  if (!mask && channels === 1) {
    const rgba = new Uint8Array(png.width * png.height * 4);
    for (let source = 0, target = 0; source < data.length; source++, target += 4) {
      const gray = data[source]!;
      rgba[target] = gray; rgba[target + 1] = gray; rgba[target + 2] = gray; rgba[target + 3] = 255;
    }
    data = rgba;
    channels = 4;
  }
  return {
    raster: Raster.fromPixels(png.width, png.height, channels, data, {
      id: filename, source: { bytes, mime: 'image/png', sha256: sha256Hex(bytes) },
    }),
    pixels: png.width * png.height,
  };
}

function hasPngChunk(bytes: Uint8Array, wanted: string): boolean {
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16)
      | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
    if (length > bytes.length - offset - 12) return false;
    const type = String.fromCharCode(bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!);
    if (type === wanted) return true;
    offset += length + 12;
  }
  return false;
}

/** Reads a directory/FileList-shaped package map, with or without one top-level `*.comp/` prefix. */
export async function readCompPackage(input: Map<string, Uint8Array>): Promise<LoadedCompPackage> {
  const { files, name } = packageFiles(input);
  const manifestBytes = files.get('manifest.json');
  if (!manifestBytes) invalid('manifest.json is missing');
  const { manifest, layers: records } = parseManifest(manifestBytes);

  let imagePixels = 0;
  let maskPixels = 0;
  const layers: Layer[] = [];
  for (const record of records) {
    let raster: Raster | null = null;
    if (record.imageFile) {
      const decoded = decodeAsset(files, record.imageFile, false);
      imagePixels += decoded.pixels;
      if (imagePixels > MAX_PIXELS) tooLarge();
      raster = decoded.raster;
    }
    let mask: Layer['mask'] = null;
    if (record.maskFile) {
      const decoded = decodeAsset(files, record.maskFile, true);
      maskPixels += decoded.pixels;
      if (maskPixels > MAX_PIXELS) tooLarge();
      mask = {
        raster: decoded.raster,
        enabled: record.maskEnabled ?? true,
        placement: record.maskPlacement ?? null,
        linked: record.maskLinked ?? true,
      };
    }
    layers.push(newLayer({
      id: record.id,
      name: record.name,
      visible: record.isVisible,
      locked: false,
      parentId: record.parentID ?? null,
      isGroup: record.isGroup === true,
      opacity: record.opacity ?? 1,
      blendMode: record.blend,
      transform: record.transform,
      raster,
      mask,
      maskSourceId: record.maskSourceID ?? null,
      adjustment: record.adjustment ?? null,
      // Upstream only restores a live shape when its ordinary raster also exists.
      shape: record.shape && raster ? record.shape : null,
    }));
  }

  return {
    document: {
      id: manifest.documentID,
      width: manifest.width,
      height: manifest.height,
      resolution: manifest.resolution ?? 72,
      layers,
      artboards: [],
      selection: null,
    },
    name,
    activeLayerId: manifest.activeLayerID ?? null,
    version: manifest.version,
  };
}

/** Unzips a `.comp` archive and delegates to `readCompPackage`. */
export async function readCompZip(bytes: Uint8Array): Promise<LoadedCompPackage> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter: (entry) => {
        if (!safeMember(entry.name)) invalid('unsafe ZIP member');
        if (entry.originalSize > ASSET_LIMIT) tooLarge();
        return true;
      },
    });
  } catch (error) {
    if (error instanceof ProjectError) throw error;
    invalid('unreadable ZIP archive');
  }
  return readCompPackage(new Map(Object.entries(entries)));
}

function assertWritableDocument(document: CanvasDocument, activeLayerId: string | null): void {
  uuid(document.id, 'document id');
  if (!Number.isInteger(document.width) || !Number.isInteger(document.height)
    || document.width < 1 || document.height < 1 || document.width > MAX_SIDE || document.height > MAX_SIDE
    || document.layers.length > MAX_LAYERS) tooLarge();
  if (!finite(document.resolution) || document.resolution < 1 || document.resolution > 9600) invalid('resolution');
  const ids = new Set<string>();
  let imagePixels = 0;
  let maskPixels = 0;
  for (const layer of document.layers) {
    const id = uuid(layer.id, 'layer id');
    if (id !== layer.id || ids.has(id)) invalid('layer ids must be canonical unique UUIDs');
    ids.add(id);
    if (typeof layer.name !== 'string' || !layer.name.trim() || encoder.encode(layer.name).byteLength > 16_384) invalid('layer name');
    if (!isValidTransform(layer.transform)) invalid('layer transform');
    if (!finite(layer.opacity) || layer.opacity < 0 || layer.opacity > 1 || (layer.isGroup && (layer.opacity !== 1 || layer.blendMode !== 'normal'))) {
      invalid('layer appearance');
    }
    if (!blendToLabel.has(layer.blendMode)) invalid('blend mode');
    if (layer.isGroup && layer.raster) invalid('group with image');
    if (layer.raster && layer.raster.channels !== 4) invalid('image is not RGBA');
    if (layer.adjustment && (layer.isGroup || layer.raster)) invalid('adjustment layer');
    if (layer.adjustment) parseAdjustment(layer.adjustment);
    if (layer.shape) parseShape(layer.shape);
    if (layer.raster) {
      if (layer.raster.width > MAX_SIDE || layer.raster.height > MAX_SIDE) tooLarge();
      imagePixels += layer.raster.width * layer.raster.height;
    }
    if (layer.mask) {
      if (layer.mask.raster.channels !== 1) invalid('mask is not grayscale');
      if (layer.mask.placement && !isValidTransform(layer.mask.placement)) invalid('mask placement');
      if (layer.mask.raster.width > MAX_SIDE || layer.mask.raster.height > MAX_SIDE) tooLarge();
      maskPixels += layer.mask.raster.width * layer.mask.raster.height;
    }
  }
  if (imagePixels > MAX_PIXELS || maskPixels > MAX_PIXELS) tooLarge();
  if (activeLayerId && !ids.has(activeLayerId)) invalid('active layer');
  const records = document.layers.map(hierarchyRecord);
  try { validateHierarchy(records); validateLiveMasks(records); } catch (error) {
    if (error instanceof InvalidProjectError) invalid('layer hierarchy or clipping graph');
    throw error;
  }
}

function packageName(value: string | undefined): string {
  const withoutSuffix = (value ?? 'Untitled').replace(/\.comp$/i, '').trim();
  const safe = withoutSuffix.replace(/[\\/\u0000-\u001f:]/g, '-');
  return safe && safe !== '.' && safe !== '..' ? safe : 'Untitled';
}

function layerRecord(layer: Layer): CompLayerRecord {
  const id = layer.id;
  const record: CompLayerRecord = {
    id,
    name: layer.name,
    isVisible: layer.visible,
    transform: layer.transform,
    ...(layer.raster ? { imageFile: `${id}.png` } : {}),
    ...(layer.parentId ? { parentID: layer.parentId } : {}),
    isGroup: layer.isGroup,
    opacity: layer.opacity,
    blendMode: blendToLabel.get(layer.blendMode)!,
    ...(layer.mask ? {
      maskFile: `${id}.mask.png`,
      maskEnabled: layer.mask.enabled,
      ...(layer.mask.placement ? { maskPlacement: layer.mask.placement } : {}),
      maskLinked: layer.mask.linked,
    } : {}),
    ...(layer.maskSourceId ? { maskSourceID: layer.maskSourceId } : {}),
    ...(layer.adjustment ? { adjustment: layer.adjustment } : {}),
    ...(layer.shape && layer.raster ? { shape: layer.shape } : {}),
  };
  return record;
}

function sortedJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortedJsonValue(item));
  if (object(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) result[key] = sortedJsonValue(value[key]);
    }
    return result;
  }
  return value;
}

/** Writes a ZIP containing `<name>.comp/` in current upstream format version 7. */
export async function writeCompZip(document: CanvasDocument, options: CompWriteOptions = {}): Promise<Uint8Array> {
  const activeLayerId = options.activeLayerId ?? null;
  assertWritableDocument(document, activeLayerId);
  const manifest: CompManifest = {
    format: COMP_FORMAT,
    version: COMP_CURRENT_VERSION,
    colorSpace: 'sRGB',
    resolution: document.resolution,
    documentID: document.id,
    width: document.width,
    height: document.height,
    ...(activeLayerId ? { activeLayerID: activeLayerId } : {}),
    layers: document.layers.map(layerRecord),
  };
  const metadata = encoder.encode(JSON.stringify(sortedJsonValue(manifest), null, 2));
  if (metadata.byteLength > MANIFEST_LIMIT) tooLarge();

  const root = `${packageName(options.name)}.comp/`;
  const files: Zippable = {
    [root]: new Uint8Array(),
    [`${root}manifest.json`]: [metadata, { level: 6 }],
    [`${root}images/`]: new Uint8Array(),
  };
  for (const layer of document.layers) {
    if (layer.raster) {
      const bytes = encodePng(layer.raster.toPixels(), layer.raster.width, layer.raster.height, layer.raster.channels);
      if (bytes.byteLength > ASSET_LIMIT) tooLarge();
      files[`${root}images/${layer.id}.png`] = [bytes, { level: 0 }];
    }
    if (layer.mask) {
      const raster = layer.mask.raster;
      const bytes = encodePng(raster.toPixels(), raster.width, raster.height, 1);
      if (bytes.byteLength > ASSET_LIMIT) tooLarge();
      files[`${root}images/${layer.id}.mask.png`] = [bytes, { level: 0 }];
    }
  }
  return zipSync(files, { mtime: new Date('2026-01-01T00:00:00Z') });
}
