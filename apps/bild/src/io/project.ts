/**
 * Fernwork Image v2 archive and v1 migration reader: ZIP with `manifest.json` and binary assets.
 * Validation limits continue to follow upstream IO/ProjectStore.swift (`validate`, `readPackage`): 30,000 px per side,
 * 100 Mpx of image pixels plus 100 Mpx of mask pixels, 10,000 layers, 4 MiB manifest, 512 MiB per
 * asset, safe relative paths only, hierarchy and live-mask graph validation, everything checked
 * before the live document is replaced.
 *
 * The v1 compatibility projection carries exact upstream values absent from that contract (origin/size/rotation/
 * flips/sampling, placed mask transforms, live-mask sources, resolution, active layer) travel in
 * `extensions["org.compositor.port"]`. Readers without it reconstruct them from the matrices.
 */

import {
  defaultBasic, defaultBrightnessContrast, defaultChannelMixer, defaultColour, defaultCurves, defaultExposure,
  defaultGradientMap, defaultGrain, defaultHueSaturation, defaultLevels, defaultPhotoFilter,
  isValidAdjustment,
} from '../core/adjustments';
import { unzipSync, zipSync, type Zippable } from 'fflate';
import type { AssetRecord, LayerRecord, Matrix2D, ProjectManifestV1 } from '../../contracts';
import type {
  AdjustmentRecordV2, AssetRecordV2, LayerCommonV2, LayerRecordV2, ProjectHistoryV2, ProjectManifestV2,
} from '../../contracts-v2';
import type { HistorySnapshot, PersistedHistoryState } from '../core/history';
import {
  BLEND_MODE_SET, documentsEqual, hierarchyRecord, InvalidProjectError, layerPixelHeight, layerPixelWidth, MAX_LAYERS, MAX_PIXELS, MAX_SIDE,
  newLayer, validateHierarchy, validateLiveMasks, type Guide, type BlendMode, type CanvasDocument, type Layer, type LayerAdjustment, type LayerShape,
} from '../core/document';
import {
  concat, fromMatrix, isValidTransform, makeTransform, pixelToDocument, placing, scaling, toMatrix,
  LAYER_SAMPLINGS, type LayerTransform,
} from '../core/geometry';
import { Raster, TILE } from '../core/raster';
import { vectorPathsForShape } from '../core/shape';
import { decodePng, decodePngNativeRGBA, encodePng } from './png';
import { sha256Hex } from './sha256';
import { normalizeArtboards } from '../core/artboards';
import { parseCubeLut } from '../core/adjust/cube';

export const EXTENSION_KEY = 'org.compositor.port';
const MANIFEST_LIMIT = 4 * 1024 * 1024;
const ASSET_LIMIT = 512 * 1024 * 1024;

interface LayerExtension {
  transform: LayerTransform;
  maskPlacement?: LayerTransform | null;
  maskSourceId?: string | null;
}
interface PortExtension {
  resolution: number;
  activeLayerId: string | null;
  layers: Record<string, LayerExtension>;
}

export class ProjectError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'ProjectError'; }
}

function legacyRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('adjustment parameters');
  return value as Record<string, unknown>;
}

function legacySetting<T>(record: Record<string, unknown>, key: string, fallback: T): T {
  const value = record[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? value as T : fallback;
}

/** LayerAdjustment.swift's v1/v7 Codable shape is accepted only here, then becomes the strict live union. */
export function migrateLegacyAdjustment(value: unknown): LayerAdjustment {
  const record = legacyRecord(value);
  const kind = record.kind;
  let adjustment: LayerAdjustment;
  switch (kind) {
    case 'Hue/Saturation': {
      const hue = typeof record.hue === 'number' ? record.hue : 0;
      const saturation = typeof record.saturation === 'number' ? record.saturation : 0;
      const lightness = typeof record.lightness === 'number' ? record.lightness : 0;
      const colorize = typeof record.colorize === 'boolean' ? record.colorize : false;
      adjustment = { kind, schemaVersion: 1, parameters: { hue, saturation, lightness, colorize,
        settings: legacySetting(record, 'hsvSettings', defaultHueSaturation(hue, saturation, lightness, colorize)) } };
      break;
    }
    case 'Levels': adjustment = { kind, schemaVersion: 1, parameters: legacySetting(record, 'levels', defaultLevels()) }; break;
    case 'Curves': adjustment = { kind, schemaVersion: 1, parameters: legacySetting(record, 'curves', defaultCurves()) }; break;
    case 'Exposure': adjustment = { kind, schemaVersion: 1,
      parameters: legacySetting(record, 'exposureSettings', defaultExposure()) }; break;
    case 'Gradient Map': adjustment = { kind, schemaVersion: 1,
      parameters: legacySetting(record, 'gradientMapSettings', defaultGradientMap()) }; break;
    case 'Grain': adjustment = { kind, schemaVersion: 1, parameters: legacySetting(record, 'grainSettings', defaultGrain()) }; break;
    case 'Basic': adjustment = { kind, schemaVersion: 1, parameters: legacySetting(record, 'parameters', defaultBasic()) }; break;
    case 'Colour Lookup': adjustment = { kind, schemaVersion: 1,
      parameters: legacySetting(record, 'parameters', { resourceId: '', interpolation: 'tetrahedral' as const }) }; break;
    case 'Colour': adjustment = { kind, schemaVersion: 1, parameters: legacySetting(record, 'parameters', defaultColour()) }; break;
    case 'Invert': adjustment = { kind, schemaVersion: 1, parameters: {} }; break;
    case 'Threshold': adjustment = { kind, schemaVersion: 1, parameters: legacySetting(record, 'parameters', { level: 128 }) }; break;
    case 'Posterize': adjustment = { kind, schemaVersion: 1, parameters: legacySetting(record, 'parameters', { levels: 4 }) }; break;
    case 'Brightness/Contrast': adjustment = { kind, schemaVersion: 1,
      parameters: legacySetting(record, 'parameters', defaultBrightnessContrast()) }; break;
    case 'Photo Filter': adjustment = { kind, schemaVersion: 1, parameters: legacySetting(record, 'parameters', defaultPhotoFilter()) }; break;
    case 'Channel Mixer': adjustment = { kind, schemaVersion: 1, parameters: legacySetting(record, 'parameters', defaultChannelMixer()) }; break;
    default: invalid('adjustment parameters');
  }
  if (!isValidAdjustment(adjustment)) invalid('adjustment parameters');
  return adjustment;
}

export function legacyAdjustmentProjection(value: LayerAdjustment): Record<string, unknown> {
  switch (value.kind) {
    case 'Hue/Saturation': return { kind: value.kind, hue: value.parameters.hue, saturation: value.parameters.saturation,
      lightness: value.parameters.lightness, colorize: value.parameters.colorize, hsvSettings: value.parameters.settings };
    case 'Levels': return { kind: value.kind, levels: value.parameters };
    case 'Curves': return { kind: value.kind, curves: value.parameters };
    case 'Exposure': return { kind: value.kind, exposureSettings: value.parameters };
    case 'Gradient Map': return { kind: value.kind, gradientMapSettings: value.parameters };
    case 'Grain': return { kind: value.kind, grainSettings: value.parameters };
    case 'Basic': case 'Colour Lookup': case 'Colour': case 'Invert': case 'Threshold': case 'Posterize':
    case 'Brightness/Contrast': case 'Photo Filter': case 'Channel Mixer':
      return { kind: value.kind, parameters: value.parameters };
  }
}

// MARK: Encoding assets

export interface EncodedAsset { bytes: Uint8Array; mime: string; sha256: string }
const encodedCache = new WeakMap<Raster, EncodedAsset>();

/** Records bytes encoded elsewhere (the archive worker) so later manifests need not re-encode. */
export function rememberEncodedAsset(raster: Raster, asset: EncodedAsset): void {
  if (!encodedCache.has(raster)) encodedCache.set(raster, asset);
}
export function hasEncodedAsset(raster: Raster): boolean { return !!raster.source || encodedCache.has(raster); }

/** The raster's bytes as stored: its original file when unchanged, else a deterministic PNG. */
export function encodedAsset(raster: Raster): EncodedAsset {
  const cached = encodedCache.get(raster);
  if (cached) return cached;
  let asset: EncodedAsset;
  // V1 has no bit-depth field. RGBA16 is therefore canonicalized to a self-describing PNG16 asset;
  // retaining an original TIFF here would route reload through the legacy external RGBA8 decoder.
  if (raster.format === 'rgba16') {
    const bytes = encodePng(raster.toPixels16(), raster.width, raster.height, 4, { bitDepth: 16 });
    asset = { bytes, mime: 'image/png', sha256: sha256Hex(bytes) };
  } else if (raster.source) asset = { bytes: raster.source.bytes, mime: raster.source.mime, sha256: raster.source.sha256 };
  else {
    const bytes = encodePng(raster.toPixels(), raster.width, raster.height, raster.channels);
    asset = { bytes, mime: 'image/png', sha256: sha256Hex(bytes) };
  }
  encodedCache.set(raster, asset);
  return asset;
}

function extensionFor(mime: string): string {
  return mime === 'image/jpeg' ? 'jpg' : mime === 'image/png' ? 'png' : mime === 'image/heic' ? 'heic' : mime === 'image/tiff' ? 'tiff' : 'bin';
}

function matrix(transform: LayerTransform, width: number, height: number): Matrix2D {
  return toMatrix(pixelToDocument(transform, width, height));
}

/** The contract manifest for a document (EditorHandle.getManifest). */
export function buildManifest(document: CanvasDocument, name: string, activeLayerId: string | null): ProjectManifestV1 {
  const assets = new Map<string, AssetRecord>();
  const addAsset = (raster: Raster): string => {
    if (!assets.has(raster.id)) {
      const encoded = encodedAsset(raster);
      assets.set(raster.id, {
        id: raster.id, path: `assets/${raster.id}.${extensionFor(encoded.mime)}`, mime: encoded.mime,
        width: raster.width, height: raster.height, sha256: encoded.sha256,
      });
    }
    return raster.id;
  };
  const extension: PortExtension = { resolution: document.resolution, activeLayerId, layers: {} };
  const layers: LayerRecord[] = document.layers.map((layer) => {
    const kind: LayerRecord['kind'] = layer.kind === 'group' ? 'group' : layer.kind === 'adjustment' ? 'adjustment'
      : layer.kind === 'vector' && layer.sourceShape ? 'shape' : 'raster';
    const record: LayerRecord = {
      id: layer.id, parentId: layer.parentId, name: layer.name, kind, visible: layer.visible, locked: layer.locks.all,
      opacity: layer.opacity, blendMode: layer.blendMode,
      transform: matrix(layer.transform, layerPixelWidth(layer), layerPixelHeight(layer)),
      clippedToBelow: layer.maskSourceId !== null,
      parameters: (layer.kind === 'adjustment' ? legacyAdjustmentProjection(layer.adjustment)
        : layer.kind === 'vector' ? layer.sourceShape ?? {} : {}) as Record<string, unknown>,
    };
    if (layer.raster) record.assetId = addAsset(layer.raster);
    if (layer.mask) {
      const placement = layer.mask.placement ?? layer.transform;
      record.mask = { assetId: addAsset(layer.mask.raster), transform: matrix(placement, layer.mask.raster.width, layer.mask.raster.height),
        linked: layer.mask.linked, enabled: layer.mask.enabled };
    }
    const ext: LayerExtension = { transform: layer.transform };
    if (layer.mask) ext.maskPlacement = layer.mask.placement;
    if (layer.maskSourceId) ext.maskSourceId = layer.maskSourceId;
    extension.layers[layer.id] = ext;
    return record;
  });
  return {
    format: 'fernwork-compositor', version: 1, id: document.id, name, width: document.width, height: document.height,
    colorSpace: 'srgb', layers, assets: [...assets.values()], extensions: { [EXTENSION_KEY]: extension },
  };
}

function v2Adjustment(value: LayerAdjustment): AdjustmentRecordV2 {
  switch (value.kind) {
    case 'Hue/Saturation': return value;
    case 'Levels': return value;
    case 'Curves': return value;
    case 'Exposure': return value;
    case 'Gradient Map': return value;
    case 'Grain': return value;
    case 'Basic': return value;
    case 'Colour Lookup': return value;
    case 'Colour': return value;
    case 'Invert': return value;
    case 'Threshold': return value;
    case 'Posterize': return value;
    case 'Brightness/Contrast': return value;
    case 'Photo Filter': return value;
    case 'Channel Mixer': return value;
  }
}

function liveAdjustment(value: AdjustmentRecordV2): LayerAdjustment {
  switch (value.kind) {
    case 'Hue/Saturation': return value;
    case 'Levels': return value;
    case 'Curves': return value;
    case 'Exposure': return value;
    case 'Gradient Map': return value;
    case 'Grain': return value;
    case 'Basic': return value;
    case 'Colour Lookup': return value;
    case 'Colour': return value;
    case 'Invert': return value;
    case 'Threshold': return value;
    case 'Posterize': return value;
    case 'Brightness/Contrast': return value;
    case 'Photo Filter': return value;
    case 'Channel Mixer': return value;
  }
}

interface V2BuildContext { assets: Map<string, AssetRecordV2>; rasters: Map<string, Raster>; binaryAssets: Map<string, Uint8Array> }

function addV2Asset(context: V2BuildContext, raster: Raster, role: AssetRecordV2['role']): string {
  const occupied = context.assets.get(raster.id);
  if (occupied && occupied.role !== role) throw new ProjectError('invalid', `Asset ID ${raster.id} is used for incompatible roles.`);
  if (!context.assets.has(raster.id)) {
    const encoded = encodedAsset(raster);
    context.assets.set(raster.id, { id: raster.id, path: `assets/${raster.id}.${extensionFor(encoded.mime)}`,
      mime: encoded.mime, width: raster.width, height: raster.height, channels: raster.channels,
      sha256: encoded.sha256, role });
    context.rasters.set(raster.id, raster);
  }
  return raster.id;
}

function v2Layer(layer: Layer, context: V2BuildContext): LayerRecordV2 {
  const common: LayerCommonV2 = {
    id: layer.id, parentId: layer.parentId, name: layer.name, visible: layer.visible, opacity: layer.opacity,
    fillOpacity: layer.fillOpacity ?? 1, blendMode: layer.blendMode,
    locks: layer.locks,
    colorLabel: layer.colorLabel, transform: layer.transform, warp: layer.warp ?? null, crop: layer.crop ?? null,
    mask: layer.mask ? { assetId: addV2Asset(context, layer.mask.raster, 'mask'), transform: layer.mask.placement,
      linked: layer.mask.linked, enabled: layer.mask.enabled } : null,
    vectorMask: layer.vectorMask ? { ...layer.vectorMask, schemaVersion: 1, density: layer.vectorMask.density ?? 1,
      feather: layer.vectorMask.feather ?? 0, paths: layer.vectorMask.paths.map(v2VectorPath) } : null, clippedTo: layer.maskSourceId,
    effects: layer.effects ?? [], filters: layer.filters ?? [],
  };
  const preview = layer.raster ? addV2Asset(context, layer.raster, 'image') : null;
  switch (layer.kind) {
    case 'group': return { ...common, kind: 'group' };
    case 'adjustment': {
      return { ...common, kind: 'adjustment', adjustment: v2Adjustment(layer.adjustment) };
    }
    case 'fill': return { ...common, kind: 'fill', fill: (layer as import('../core/model').FillLayer).fill };
    case 'vector': {
      const value = layer as Partial<import('../core/model').VectorLayer>;
      const shape = layer.sourceShape;
      const sourceShape = shape ? { ...shape, schemaVersion: 1 as const } : null;
      const style = value.style ?? { fill: null, stroke: null };
      return { ...common, kind: 'vector', paths: (value.paths ?? []).map(v2VectorPath), style: { ...style, schemaVersion: 1 },
        previewAssetId: preview, sourceShape };
    }
    case 'text': {
      const value = layer as import('../core/model').TextLayer;
      return { ...common, kind: 'text', textSchemaVersion: 1, text: value.text, runs: value.runs,
        paragraphs: value.paragraphs, box: value.box,
        alignment: value.alignment, previewAssetId: preview, previewTransform: value.renderedTransform };
    }
    case 'embedded': {
      const value = layer as import('../core/model').EmbeddedLayer;
      return { ...common, kind: 'embedded', content: value.content, previewAssetId: preview };
    }
    default: return { ...common, kind: 'pixel', assetId: preview };
  }
}

function v2VectorPath(path: import('../core/model').VectorPath): import('../../contracts-v2').VectorPathRecordV2 {
  return { schemaVersion: 1, closed: path.closed, fillRule: path.fillRule ?? 'nonzero', points: path.points.map((point) => ({
    anchor: point.anchor, in: point.in, out: point.out, kind: point.kind ?? 'corner',
  })) };
}

function manifestV2WithContext(document: CanvasDocument, name: string, activeLayerId: string | null,
  context: V2BuildContext): ProjectManifestV2 {
  for (const resource of document.resources ?? []) {
    if (context.assets.has(resource.id)) continue;
    const hash = sha256Hex(resource.bytes);
    context.assets.set(resource.id, { id: resource.id, path: `assets/resource-${hash}.bin`, mime: resource.mime,
      sha256: hash, role: resource.role });
    context.binaryAssets.set(resource.id, resource.bytes);
  }
  const layers = document.layers.map((layer) => v2Layer(layer, context));
  return { format: 'fernwork-image', version: 2, id: document.id, name, width: document.width, height: document.height,
    resolution: document.resolution, globalLightAngle: document.globalLightAngle ?? 120,
    colorSpace: 'srgb', activeLayerId, layers, artboards: document.artboards ?? [],
    ...(document.guides?.length ? { guides: document.guides.map((g) => ({ id: g.id, orientation: g.orientation, position: g.position })) } : {}),
    assets: [...context.assets.values()], ...(document.fonts?.length ? { fonts: document.fonts } : {}) };
}

/** Native v2 manifest. `buildManifest` remains the v1 compatibility projection for EditorHandle. */
export function buildManifestV2(document: CanvasDocument, name: string, activeLayerId: string | null): ProjectManifestV2 {
  return manifestV2WithContext(document, name, activeLayerId, { assets: new Map(), rasters: new Map(), binaryAssets: new Map() });
}

/** Writes the ZIP archive. Assets are stored uncompressed (already compressed images). */
export function writeArchive(document: CanvasDocument, name: string, activeLayerId: string | null,
  history?: PersistedHistoryState): { blob: Blob; manifest: ProjectManifestV2 } {
  const context: V2BuildContext = { assets: new Map(), rasters: new Map(), binaryAssets: new Map() };
  const manifest = manifestV2WithContext(document, name, activeLayerId, context);
  const files: Zippable = {};
  if (history) manifest.history = writeHistory(history, name, context, files);
  manifest.assets = [...context.assets.values()];
  const json = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  if (json.byteLength > MANIFEST_LIMIT) throw new ProjectError('too-large', 'The project manifest exceeds 4 MiB.');
  files['manifest.json'] = [json, { level: 6 }];
  for (const asset of manifest.assets) {
    const raster = context.rasters.get(asset.id);
    if (raster) files[asset.path] = [encodedAsset(raster).bytes, { level: 0 }];
    else {
      const bytes = context.binaryAssets.get(asset.id);
      if (bytes) files[asset.path] = [bytes, { level: 0 }];
    }
  }
  const zipped = zipSync(files, { mtime: new Date('2026-01-01T00:00:00Z') });
  return { blob: new Blob([zipped as BlobPart], { type: 'application/zip' }), manifest };
}

interface HistorySnapshotFile {
  document: Omit<ProjectManifestV2, 'format' | 'version' | 'name' | 'assets' | 'history'> | null;
  activeLayerId: string | null;
  revision: number;
  tileRasters?: readonly { id: string; width: number; height: number; channels: 1 | 4; format?: string; tiles: readonly (string | null)[] }[];
}

function writeHistory(state: PersistedHistoryState, name: string, context: V2BuildContext, files: Zippable): ProjectHistoryV2 {
  if (!state.enabled) return { schemaVersion: 1, enabled: false, retainedByteLimit: state.retainedByteLimit,
    cursor: 0, commands: [], snapshots: [] };
  const commands = [...state.past, ...state.future];
  const liveRasterIds = new Set(context.rasters.keys());
  const snapshots: ProjectHistoryV2['snapshots'][number][] = [];
  const ids = new Map<HistorySnapshot, string>();
  const snapshotId = (snapshot: HistorySnapshot): string => {
    const known = ids.get(snapshot);
    if (known) return known;
    const id = `snapshot-${ids.size + 1}`;
    ids.set(snapshot, id);
    const path = `history/snapshots/${id}.json`;
    const built = snapshot.document ? manifestV2WithContext(snapshot.document, name, snapshot.activeLayerId, context) : null;
    const tileRasters: NonNullable<HistorySnapshotFile['tileRasters']>[number][] = [];
    for (const layer of snapshot.document?.layers ?? []) {
      for (const raster of [layer.raster, layer.mask?.raster ?? null]) {
        if (!raster || liveRasterIds.has(raster.id) || tileRasters.some((item) => item.id === raster.id)) continue;
        const tiles = raster.tiles.map((tile) => {
          if (!tile) return null;
          // 16-bit tiles are stored as their little-endian bytes; the raster's format says how to read them.
          const bytes = new Uint8Array(tile.buffer, tile.byteOffset, tile.byteLength);
          const hash = sha256Hex(bytes);
          const assetId = `history-tile-${hash}`;
          const path = `history/tiles/${hash}.bin`;
          if (!context.assets.has(assetId)) {
            context.assets.set(assetId, { id: assetId, path, mime: 'application/octet-stream', sha256: hash, role: 'history-tile' });
            files[path] = [bytes, { level: 0 }];
          }
          return assetId;
        });
        tileRasters.push({ id: raster.id, width: raster.width, height: raster.height, channels: raster.channels, format: raster.format, tiles });
      }
    }
    const value: HistorySnapshotFile = { document: built ? {
      id: built.id, width: built.width, height: built.height, resolution: built.resolution, colorSpace: built.colorSpace,
      globalLightAngle: built.globalLightAngle, activeLayerId: built.activeLayerId, layers: built.layers,
      artboards: built.artboards, extensions: built.extensions,
    } : null, activeLayerId: snapshot.activeLayerId, revision: snapshot.revision, tileRasters };
    files[path] = [new TextEncoder().encode(JSON.stringify(value)), { level: 6 }];
    snapshots.push({ id, path, activeLayerId: snapshot.activeLayerId, revision: snapshot.revision });
    return id;
  };
  const records = commands.map((command) => ({ name: command.name, before: snapshotId(command.before), after: snapshotId(command.after) }));
  return { schemaVersion: 1, enabled: true, retainedByteLimit: state.retainedByteLimit,
    cursor: state.past.length, commands: records, snapshots };
}

// MARK: Reading

export type ImageDecoder = (bytes: Uint8Array, mime: string) => Promise<{ width: number; height: number; channels: 1 | 4; data: Uint8Array }>;

/** Rejects absolute paths, drive letters, backslashes and any `..` segment. */
export function isSafeRelativePath(path: string): boolean {
  if (!path || path.length > 1024) return false;
  if (/^[\\/]|^[A-Za-z]:|\\/.test(path)) return false;
  if (path.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')) return false;
  return !/[\u0000-\u001f]/.test(path);
}

function num(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function invalid(detail: string): never { throw new ProjectError('invalid', `This is not a valid Fernwork Bildeditor project, or its metadata is damaged (${detail}).`); }

export interface LoadedProject {
  document: CanvasDocument;
  name: string;
  activeLayerId: string | null;
  history?: PersistedHistoryState;
}

/** Parses, validates and decodes an archive. Nothing is installed until everything succeeded. */
export async function readArchive(blob: Blob, decodeImage: ImageDecoder): Promise<LoadedProject> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(await blob.arrayBuffer()), {
      filter: (file) => {
        if (file.originalSize > ASSET_LIMIT) throw new ProjectError('too-large', 'A file inside the project exceeds 512 MiB.');
        return true;
      },
    });
  } catch (error) {
    if (error instanceof ProjectError) throw error;
    throw new ProjectError('invalid', 'This file is not a readable project archive.');
  }
  const manifestBytes = entries['manifest.json'];
  if (!manifestBytes) invalid('manifest.json is missing');
  if (manifestBytes.byteLength > MANIFEST_LIMIT) throw new ProjectError('too-large', 'The project manifest exceeds 4 MiB.');
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(manifestBytes)) as unknown; } catch { invalid('manifest is not JSON'); }
  const discriminator = parsed as { format?: unknown; version?: unknown };
  if (discriminator.format === 'fernwork-image') {
    if (discriminator.version !== 2) throw new ProjectError('version', `This project uses format version ${String(discriminator.version)}. This editor supports version 2.`);
    return readV2Archive(parsed as ProjectManifestV2, entries, decodeImage);
  }
  const manifest = parsed as ProjectManifestV1;
  if (manifest.format !== 'fernwork-compositor') invalid('unknown format');
  if (manifest.version !== 1) throw new ProjectError('version', `This project uses format version ${String(manifest.version)}. This editor supports version 1.`);
  if (manifest.colorSpace !== 'srgb') invalid('colour space');
  if (!Number.isInteger(manifest.width) || !Number.isInteger(manifest.height) || manifest.width < 1 || manifest.height < 1
    || manifest.width > MAX_SIDE || manifest.height > MAX_SIDE) throw new ProjectError('too-large', 'This project exceeds the supported canvas size.');
  if (!Array.isArray(manifest.layers) || !Array.isArray(manifest.assets) || manifest.layers.length > MAX_LAYERS) invalid('layers');
  if (typeof manifest.id !== 'string' || !manifest.id) invalid('id');
  const ext = (manifest.extensions?.[EXTENSION_KEY] ?? null) as PortExtension | null;
  const resolution = ext && num(ext.resolution) && ext.resolution >= 1 && ext.resolution <= 9600 ? ext.resolution : 72;

  // Assets: validate records, then decode each once.
  const records = new Map<string, AssetRecord>();
  for (const asset of manifest.assets) {
    if (!asset || typeof asset.id !== 'string' || !asset.id || records.has(asset.id)) invalid('asset ids');
    if (!isSafeRelativePath(asset.path)) invalid(`unsafe asset path ${JSON.stringify(asset.path)}`);
    if (!Number.isInteger(asset.width) || !Number.isInteger(asset.height) || asset.width < 1 || asset.height < 1
      || asset.width > MAX_SIDE || asset.height > MAX_SIDE) throw new ProjectError('too-large', 'An image inside the project exceeds 30,000 pixels per side.');
    if (typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256)) invalid('asset hash');
    records.set(asset.id, asset);
  }
  const maskAssetIds = new Set<string>();
  const imageAssetIds = new Set<string>();
  for (const layer of manifest.layers) {
    if (layer?.assetId) imageAssetIds.add(layer.assetId);
    if (layer?.mask?.assetId) maskAssetIds.add(layer.mask.assetId);
  }
  let imagePixels = 0, maskPixels = 0;
  for (const id of imageAssetIds) { const a = records.get(id); if (a) imagePixels += a.width * a.height; }
  for (const id of maskAssetIds) { const a = records.get(id); if (a) maskPixels += a.width * a.height; }
  if (imagePixels > MAX_PIXELS || maskPixels > MAX_PIXELS) throw new ProjectError('too-large', 'This project exceeds the 100-megapixel image limit.');

  const rasters = new Map<string, Raster>();
  const decode = async (id: string, mask: boolean): Promise<Raster> => {
    const existing = rasters.get(id);
    if (existing) {
      if ((existing.channels === 1) !== mask) invalid('asset used as both mask and image');
      return existing;
    }
    const record = records.get(id);
    if (!record) invalid(`missing asset record ${id}`);
    const bytes = entries[record.path];
    if (!bytes) throw new ProjectError('missing-image', 'An image inside the project is missing or damaged. The current document has not been replaced.');
    const hash = sha256Hex(bytes);
    if (hash !== record.sha256) throw new ProjectError('missing-image', 'An image inside the project is damaged (checksum mismatch). The current document has not been replaced.');
    let pixels: { width: number; height: number; channels: 1 | 4; data: Uint8Array | Uint16Array; bitDepth: 8 | 16 };
    if (record.mime === 'image/png') {
      if (mask) {
        const png = decodePng(bytes);
        pixels = { ...png, bitDepth: 8 };
      } else {
        const png = decodePngNativeRGBA(bytes);
        pixels = { ...png, channels: 4 };
      }
    } else pixels = { ...await decodeImage(bytes, record.mime), bitDepth: 8 };
    if (pixels.width !== record.width || pixels.height !== record.height) invalid('asset size does not match its record');
    let data = pixels.data;
    let channels = pixels.channels;
    if (mask && channels === 4) {
      // Masks are scalar coverage; accept an RGBA writer's gray by taking the red channel.
      const gray = new Uint8Array(pixels.width * pixels.height);
      for (let i = 0; i < gray.length; i++) gray[i] = data[i * 4]!;
      data = gray; channels = 1;
    } else if (!mask && channels === 1) {
      const rgba = pixels.bitDepth === 16
        ? new Uint16Array(pixels.width * pixels.height * 4) : new Uint8Array(pixels.width * pixels.height * 4);
      const maximum = pixels.bitDepth === 16 ? 65535 : 255;
      for (let i = 0; i < data.length; i++) { const v = data[i]!; rgba.set([v, v, v, maximum], i * 4); }
      data = rgba; channels = 4;
    }
    const raster = Raster.fromPixels(pixels.width, pixels.height, channels, data, {
      id, format: channels === 4 && pixels.bitDepth === 16 ? 'rgba16' : channels === 4 ? 'rgba8' : 'gray8',
      source: { bytes, mime: record.mime, sha256: hash } });
    rasters.set(id, raster);
    return raster;
  };

  const ids = new Set<string>();
  const layers: Layer[] = [];
  for (const record of manifest.layers) {
    if (!record || typeof record.id !== 'string' || !record.id || ids.has(record.id)) invalid('layer ids');
    ids.add(record.id);
    if (typeof record.name !== 'string' || !record.name.trim() || new TextEncoder().encode(record.name).length > 16_384) invalid('layer name');
    if (!['raster', 'group', 'adjustment', 'shape'].includes(record.kind)) invalid('layer kind');
    if (!num(record.opacity) || record.opacity < 0 || record.opacity > 1) invalid('opacity');
    if (!BLEND_MODE_SET.has(record.blendMode)) invalid(`blend mode ${String(record.blendMode)}`);
    if (!Array.isArray(record.transform) || record.transform.length !== 6 || !record.transform.every(num)) invalid('transform');
    const isGroup = record.kind === 'group';
    if (isGroup && record.assetId) invalid('group with pixels');
    if (isGroup && (record.opacity !== 1 || record.blendMode !== 'normal')) invalid('group appearance');
    const raster = record.assetId ? await decode(record.assetId, false) : null;
    const lext = ext?.layers?.[record.id];
    const gridW = raster?.width ?? null, gridH = raster?.height ?? null;
    const transform = resolveTransform(record.transform, lext?.transform, gridW, gridH, manifest.width, manifest.height);
    let mask: Layer['mask'] = null;
    if (record.mask) {
      if (!Array.isArray(record.mask.transform) || record.mask.transform.length !== 6 || !record.mask.transform.every(num)) invalid('mask transform');
      const maskRaster = await decode(record.mask.assetId, true);
      const stated = resolveTransform(record.mask.transform, lext?.maskPlacement ?? undefined, maskRaster.width, maskRaster.height,
        manifest.width, manifest.height);
      const same = sameMatrix(record.mask.transform, matrix(transform, maskRaster.width, maskRaster.height));
      mask = { raster: maskRaster, enabled: record.mask.enabled !== false, linked: record.mask.linked !== false,
        placement: lext && 'maskPlacement' in lext ? lext.maskPlacement ?? null : same ? null : stated };
    }
    const sourceShape = record.kind === 'shape' ? validLegacyShape(record.parameters) : null;
    layers.push(newLayer({
      id: record.id, name: record.name, visible: record.visible !== false, locked: record.locked === true,
      parentId: record.parentId ?? null,
      kind: isGroup ? 'group' : record.kind === 'adjustment' ? 'adjustment' : record.kind === 'shape' ? 'vector' : 'pixel',
      opacity: record.opacity, blendMode: record.blendMode as BlendMode, transform, raster, mask,
      maskSourceId: null,
      ...(record.kind === 'adjustment' ? { adjustment: validAdjustment(record.parameters) } : {}),
      ...(sourceShape ? {
        sourceShape,
        paths: vectorPathsForShape(sourceShape.kind, raster?.width ?? Math.max(1, Math.round(transform.size.width)),
          raster?.height ?? Math.max(1, Math.round(transform.size.height)), sourceShape.cornerRadius),
        style: { fill: { kind: 'solid' as const, schemaVersion: 1 as const,
          color: { red: sourceShape.red, green: sourceShape.green, blue: sourceShape.blue } }, stroke: null },
      } : {}),
    }));
  }
  // Live-mask sources: exact ids from the extension, else the clipping base below.
  for (let i = 0; i < layers.length; i++) {
    const record = manifest.layers[i]!;
    const stated = ext?.layers?.[record.id]?.maskSourceId;
    if (stated) layers[i] = { ...layers[i]!, maskSourceId: stated };
    else if (record.clippedToBelow) {
      const siblings = layers.filter((l) => l.parentId === layers[i]!.parentId);
      const index = siblings.findIndex((l) => l.id === layers[i]!.id);
      const below = siblings[index - 1];
      if (!below || below.kind === 'group') invalid('clipping mask without a base');
      layers[i] = { ...layers[i]!, maskSourceId: below.maskSourceId ?? below.id };
    }
  }
  const structure = layers.map(hierarchyRecord);
  try { validateHierarchy(structure); validateLiveMasks(structure); } catch (error) {
    if (error instanceof InvalidProjectError) invalid('layer hierarchy or clipping graph');
    throw error;
  }
  const activeLayerId = ext?.activeLayerId && ids.has(ext.activeLayerId) ? ext.activeLayerId : null;
  return {
    document: { id: manifest.id, width: manifest.width, height: manifest.height, resolution, layers, artboards: [], selection: null },
    name: typeof manifest.name === 'string' && manifest.name ? manifest.name : 'Untitled',
    activeLayerId,
  };
}

function sameMatrix(a: readonly number[], b: readonly number[], tolerance = 1e-6): boolean {
  return a.every((v, i) => Math.abs(v - b[i]!) <= tolerance * Math.max(1, Math.abs(v)));
}

/** The exact stored LayerTransform when it matches the matrix, else one reconstructed from it. */
function resolveTransform(m: readonly number[], stated: LayerTransform | undefined, gridW: number | null, gridH: number | null,
  canvasW: number, canvasH: number): LayerTransform {
  if (stated && isLayerTransform(stated)) {
    const w = gridW ?? Math.max(1, Math.round(stated.size.width)), h = gridH ?? Math.max(1, Math.round(stated.size.height));
    if (sameMatrix(m, matrix(stated, w, h))) return stated;
  }
  const affine = fromMatrix(m);
  const w = gridW ?? Math.max(1, Math.round(Math.hypot(affine.a, affine.b) || canvasW));
  const h = gridH ?? Math.max(1, Math.round(Math.hypot(affine.c, affine.d) || canvasH));
  const unit = concat(scaling(w, h), affine);
  const base = makeTransform({ x: 0, y: 0 }, { width: 1, height: 1 });
  const result = placing(base, unit);
  if (!isValidTransform(result)) invalid('transform out of range');
  return result;
}

function isLayerTransform(value: unknown): value is LayerTransform {
  const t = value as LayerTransform;
  return !!t && typeof t === 'object' && !!t.origin && !!t.size && num(t.origin.x) && num(t.origin.y) && num(t.size.width)
    && num(t.size.height) && num(t.rotation) && typeof t.flipX === 'boolean' && typeof t.flipY === 'boolean'
    && LAYER_SAMPLINGS.includes(t.sampling) && isValidTransform(t);
}

function validAdjustment(parameters: unknown): LayerAdjustment {
  return migrateLegacyAdjustment(parameters);
}

function validLegacyShape(parameters: unknown): LayerShape {
  const value = legacyRecord(parameters);
  if ((value.kind !== 'Rectangle' && value.kind !== 'Ellipse') || !num(value.red) || !num(value.green)
    || !num(value.blue) || !num(value.cornerRadius)) invalid('shape parameters');
  return { ...(value as unknown as LayerShape), schemaVersion: 1 };
}

function validParametricShape(parameters: unknown): LayerShape {
  const value = legacyRecord(parameters);
  if (!['Rectangle', 'Ellipse', 'Polygon', 'Star', 'Line'].includes(String(value.kind))
    || !num(value.red) || !num(value.green) || !num(value.blue) || !num(value.cornerRadius)
    || ![value.red, value.green, value.blue].every((part) => (part as number) >= 0 && (part as number) <= 1)
    || (value.schemaVersion !== undefined && value.schemaVersion !== 1)) invalid('parametric shape');
  if (value.cornerRadii !== undefined && (!Array.isArray(value.cornerRadii) || value.cornerRadii.length !== 4
    || !value.cornerRadii.every((part) => num(part) && part >= 0))) invalid('rectangle radii');
  if ((value.kind === 'Polygon' || value.kind === 'Star') && (!num(value.sides) || !Number.isInteger(value.sides)
    || value.sides < (value.kind === 'Star' ? 2 : 3) || value.sides > 1000)) invalid('shape sides');
  if (value.kind === 'Star' && (!num(value.innerRatio) || value.innerRatio <= 0 || value.innerRatio >= 1)) invalid('star ratio');
  if (value.kind === 'Line' && (!num(value.lineWidth) || value.lineWidth <= 0)) invalid('line width');
  return { ...(value as unknown as LayerShape), schemaVersion: 1 };
}

async function readV2Archive(manifest: ProjectManifestV2, entries: Record<string, Uint8Array>,
  decodeImage: ImageDecoder): Promise<LoadedProject> {
  if (manifest.format !== 'fernwork-image' || manifest.version !== 2 || manifest.colorSpace !== 'srgb') invalid('v2 header');
  if (!Number.isInteger(manifest.width) || !Number.isInteger(manifest.height) || manifest.width < 1 || manifest.height < 1
    || manifest.width > MAX_SIDE || manifest.height > MAX_SIDE) throw new ProjectError('too-large', 'This project exceeds the supported canvas size.');
  if (!num(manifest.resolution) || manifest.resolution < 1 || manifest.resolution > 9600) invalid('resolution');
  if (typeof manifest.id !== 'string' || !manifest.id || typeof manifest.name !== 'string') invalid('identity');
  if (!Array.isArray(manifest.layers) || !Array.isArray(manifest.assets) || !Array.isArray(manifest.artboards)
    || manifest.layers.length > MAX_LAYERS) invalid('v2 collections');

  const records = new Map<string, AssetRecordV2>();
  let imagePixels = 0, maskPixels = 0;
  for (const asset of manifest.assets) {
    if (!asset || typeof asset.id !== 'string' || !asset.id || records.has(asset.id) || !isSafeRelativePath(asset.path)
      || typeof asset.mime !== 'string' || typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256)
      || !['image', 'mask', 'pattern', 'embedded', 'font', 'lut', 'history-tile'].includes(asset.role)) invalid('v2 asset');
    if (asset.width !== undefined && (!Number.isInteger(asset.width) || asset.width < 1 || asset.width > MAX_SIDE)) invalid('v2 asset width');
    if (asset.height !== undefined && (!Number.isInteger(asset.height) || asset.height < 1 || asset.height > MAX_SIDE)) invalid('v2 asset height');
    if (asset.width && asset.height) {
      if (asset.role === 'mask') maskPixels += asset.width * asset.height;
      else if (asset.role === 'image') imagePixels += asset.width * asset.height;
    }
    records.set(asset.id, asset);
  }
  if (imagePixels > MAX_PIXELS || maskPixels > MAX_PIXELS) throw new ProjectError('too-large', 'This project exceeds the 100-megapixel image limit.');

  const rasters = new Map<string, Raster>();
  const resources: Array<NonNullable<CanvasDocument['resources']>[number]> = [];
  for (const record of records.values()) {
    if (record.role !== 'pattern' && record.role !== 'embedded' && record.role !== 'font' && record.role !== 'lut') continue;
    const bytes = entries[record.path];
    if (!bytes || sha256Hex(bytes) !== record.sha256) throw new ProjectError('missing-image', 'An embedded project asset is missing or damaged.');
    if (record.role === 'lut') try { parseCubeLut(bytes); } catch { invalid('colour lookup resource'); }
    resources.push({ id: record.id, role: record.role, mime: record.mime, bytes });
  }
  const decode = async (id: string, mask: boolean): Promise<Raster> => {
    const existing = rasters.get(id);
    if (existing) {
      if ((existing.channels === 1) !== mask) invalid('asset used as both mask and image');
      return existing;
    }
    const record = records.get(id);
    if (!record || record.width === undefined || record.height === undefined) invalid(`missing raster record ${id}`);
    if (mask ? record.role !== 'mask' : record.role !== 'image') invalid('raster asset role');
    const bytes = entries[record.path];
    if (!bytes || sha256Hex(bytes) !== record.sha256) throw new ProjectError('missing-image', 'An image inside the project is missing or damaged.');
    // Image assets keep their depth: PNG16 stays 16-bit (A3); masks and other codecs are 8-bit.
    let decoded: { width: number; height: number; channels: 1 | 4; data: Uint8Array | Uint16Array; bitDepth: 8 | 16 };
    if (record.mime === 'image/png') decoded = mask ? { ...decodePng(bytes), bitDepth: 8 } : { ...decodePngNativeRGBA(bytes), channels: 4 };
    else decoded = { ...await decodeImage(bytes, record.mime), bitDepth: 8 };
    if (decoded.width !== record.width || decoded.height !== record.height) invalid('asset size does not match its record');
    let data = decoded.data, channels = decoded.channels;
    if (mask && channels === 4) {
      const gray = new Uint8Array(decoded.width * decoded.height);
      for (let i = 0; i < gray.length; i++) gray[i] = data[i * 4]!;
      data = gray; channels = 1;
    } else if (!mask && channels === 1) {
      const maximum = decoded.bitDepth === 16 ? 65535 : 255;
      const rgba = decoded.bitDepth === 16 ? new Uint16Array(decoded.width * decoded.height * 4) : new Uint8Array(decoded.width * decoded.height * 4);
      for (let i = 0; i < data.length; i++) { const v = data[i]!; rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = maximum; }
      data = rgba; channels = 4;
    }
    const raster = Raster.fromPixels(decoded.width, decoded.height, channels, data, {
      id, format: channels === 4 && decoded.bitDepth === 16 ? 'rgba16' : channels === 4 ? 'rgba8' : 'gray8',
      source: { bytes, mime: record.mime, sha256: record.sha256 } });
    rasters.set(id, raster);
    return raster;
  };

  const parseDocument = async (source: Pick<ProjectManifestV2, 'id' | 'width' | 'height' | 'resolution' | 'globalLightAngle' | 'layers' | 'artboards'>): Promise<CanvasDocument> => {
    if (typeof source.id !== 'string' || !source.id || !Number.isInteger(source.width) || !Number.isInteger(source.height)
      || source.width < 1 || source.height < 1 || source.width > MAX_SIDE || source.height > MAX_SIDE
      || !num(source.resolution) || source.resolution < 1 || source.resolution > 9600
      || !Array.isArray(source.layers) || !Array.isArray(source.artboards) || source.layers.length > MAX_LAYERS) invalid('snapshot document');
    const ids = new Set<string>();
    const layers: Layer[] = [];
    for (const record of source.layers) {
      if (!record || typeof record.id !== 'string' || !record.id || ids.has(record.id) || typeof record.name !== 'string'
        || !record.name.trim() || !num(record.opacity) || record.opacity < 0 || record.opacity > 1
        || !num(record.fillOpacity) || record.fillOpacity < 0 || record.fillOpacity > 1
        || !BLEND_MODE_SET.has(record.blendMode) || !isLayerTransform(record.transform)
        || !validLocks(record.locks) || !['none', 'red', 'orange', 'yellow', 'green', 'blue', 'violet', 'gray'].includes(record.colorLabel)
        || !Array.isArray(record.effects) || !record.effects.every(validEffect)
        || !Array.isArray(record.filters) || !record.filters.every(validLiveFilter)
        || !validVectorMaskRecord(record.vectorMask)) invalid('v2 layer');
      ids.add(record.id);
      if (!['pixel', 'group', 'adjustment', 'fill', 'vector', 'text', 'embedded'].includes(record.kind)) invalid('v2 layer kind');
      const assetId = record.kind === 'pixel' ? record.assetId
        : record.kind === 'vector' || record.kind === 'text' || record.kind === 'embedded' ? record.previewAssetId : null;
      const raster = assetId ? await decode(assetId, false) : null;
      const maskRaster = record.mask ? await decode(record.mask.assetId, true) : null;
      const mask = record.mask && maskRaster ? { raster: maskRaster, enabled: record.mask.enabled,
        linked: record.mask.linked, placement: record.mask.transform } : null;
      const common = {
        id: record.id, name: record.name, visible: record.visible !== false,
        parentId: record.parentId, opacity: record.opacity, fillOpacity: record.fillOpacity,
        blendMode: record.blendMode as BlendMode, locks: record.locks, colorLabel: record.colorLabel,
        transform: record.transform, warp: record.warp, crop: record.crop, raster, mask,
        vectorMask: normalizeVectorMaskRecord(record.vectorMask), maskSourceId: record.clippedTo, effects: record.effects, filters: record.filters,
      };
      switch (record.kind) {
        case 'group': layers.push(newLayer({ ...common, kind: 'group' })); break;
        case 'adjustment': {
          if (!record.adjustment || record.adjustment.schemaVersion !== 1) invalid('adjustment schema');
          const adjustment = liveAdjustment(record.adjustment);
          if (!isValidAdjustment(adjustment)) invalid('adjustment parameters');
          if (adjustment.kind === 'Colour Lookup' && records.get(adjustment.parameters.resourceId)?.role !== 'lut') {
            invalid('colour lookup resource');
          }
          layers.push(newLayer({ ...common, kind: 'adjustment', adjustment }));
          break;
        }
        case 'fill':
          if (!validFill(record.fill, records)) invalid('fill parameters');
          layers.push(newLayer({ ...common, kind: 'fill', fill: record.fill }));
          break;
        case 'vector':
          if (!Array.isArray(record.paths) || !record.paths.every(validVectorPath) || !record.style
            || (record.style.schemaVersion !== undefined && record.style.schemaVersion !== 1)
            || (record.style.fill !== null && !validFill(record.style.fill, records))
            || !validVectorStroke(record.style.stroke, records)) invalid('vector parameters');
          layers.push(newLayer({ ...common, kind: 'vector', paths: record.paths.map(normalizeVectorPath),
            style: { ...record.style, schemaVersion: 1 },
            sourceShape: record.sourceShape === null ? null : validParametricShape(record.sourceShape) })); break;
        case 'text':
          if (typeof record.text !== 'string' || !Array.isArray(record.runs)
            || !record.runs.every((run: unknown) => validTextRun(run, record.text.length))
            || !['left', 'center', 'right', 'justify'].includes(record.alignment)) invalid('text parameters');
          if ('textSchemaVersion' in record && record.textSchemaVersion !== 1) invalid('text schema');
          if ('paragraphs' in record && (!Array.isArray(record.paragraphs)
            || !record.paragraphs.every((paragraph: unknown) => validTextParagraph(paragraph, record.text.length)))) invalid('paragraph parameters');
          // Files written by the first v2 implementation used flat runs and one alignment.
          // `newLayer` performs that one-time migration; all new files carry textSchemaVersion 1.
          layers.push(newLayer({ ...common, kind: 'text', text: record.text, runs: record.runs,
            paragraphs: 'paragraphs' in record && Array.isArray(record.paragraphs) ? record.paragraphs : undefined,
            box: record.box, alignment: record.alignment,
            renderedTransform: 'previewTransform' in record ? record.previewTransform : null })); break;
        case 'embedded': {
          const content = record.content;
          if (!content || !['embedded', 'linked'].includes(content.mode) || !['image', 'svg', 'pdf', 'project'].includes(content.mediaType)
            || typeof content.sourceName !== 'string' || (content.mode === 'embedded'
              ? typeof content.assetId !== 'string' || records.get(content.assetId)?.role !== 'embedded'
              : typeof content.uri !== 'string')) invalid('embedded parameters');
          layers.push(newLayer({ ...common, kind: 'embedded', content })); break;
        }
        case 'pixel': layers.push(newLayer({ ...common, kind: 'pixel' })); break;
      }
    }
    const structure = layers.map(hierarchyRecord);
    try { validateHierarchy(structure); validateLiveMasks(structure); } catch { invalid('v2 layer hierarchy or clipping graph'); }
    for (const artboard of source.artboards) {
      if (!artboard || typeof artboard.id !== 'string' || !artboard.id || typeof artboard.name !== 'string'
        || !num(artboard.rect?.x) || !num(artboard.rect?.y) || !num(artboard.rect?.width) || !num(artboard.rect?.height)
        || artboard.rect.width < 1 || artboard.rect.height < 1) invalid('artboard');
    }
    const guides = (source as { guides?: unknown }).guides;
    if (guides !== undefined && (!Array.isArray(guides) || guides.length > 10_000 || !guides.every((g) => g && typeof g.id === 'string'
      && (g.orientation === 'horizontal' || g.orientation === 'vertical') && num(g.position) && Math.abs(g.position) <= 1_000_000))) invalid('guides');
    const fontRecords = (manifest as ProjectManifestV2).fonts;
    if (fontRecords !== undefined && (!Array.isArray(fontRecords) || fontRecords.some((font) => !font
      || typeof font.id !== 'string' || typeof font.family !== 'string' || typeof font.style !== 'string'
      || !num(font.weight) || typeof font.embeddingAllowed !== 'boolean'
      || !['bundled', 'system', 'local', 'embedded'].includes(font.source)
      || (font.resourceId !== undefined && records.get(font.resourceId)?.role !== 'font')))) invalid('fonts');
    if (source.globalLightAngle !== undefined && (!num(source.globalLightAngle) || Math.abs(source.globalLightAngle) > 360_000)) invalid('global light');
    return { id: source.id, width: source.width, height: source.height, resolution: source.resolution,
      globalLightAngle: source.globalLightAngle ?? 120,
      layers, artboards: normalizeArtboards(source.artboards), ...(guides?.length ? { guides: (guides as Guide[]).map((g) => ({ id: g.id, orientation: g.orientation, position: g.position })) } : {}),
      resources, ...(fontRecords?.length ? { fonts: fontRecords } : {}), selection: null };
  };

  const document = await parseDocument(manifest);
  const activeLayerId = manifest.activeLayerId && document.layers.some((layer) => layer.id === manifest.activeLayerId)
    ? manifest.activeLayerId : null;
  const history = manifest.history ? await readHistory(manifest.history, entries, records, parseDocument) : undefined;
  if (history?.enabled) {
    const expected = history.past.at(-1)?.after ?? history.future.at(-1)?.before;
    if (expected && (!documentsEqual(expected.document, document) || expected.activeLayerId !== activeLayerId)) invalid('history cursor state');
  }
  return { document, name: manifest.name || 'Untitled', activeLayerId, ...(history ? { history } : {}) };
}

function validLocks(value: LayerCommonV2['locks']): boolean {
  return !!value && [value.transparency, value.pixels, value.position, value.all].every((part) => typeof part === 'boolean');
}

function validRgb(value: { red: number; green: number; blue: number } | null | undefined): boolean {
  return !!value && [value.red, value.green, value.blue].every((part) => num(part) && part >= 0 && part <= 1);
}

function validTextRun(value: unknown, length: number): boolean {
  if (!value || typeof value !== 'object') return false;
  const run = value as Record<string, unknown>;
  if (!Number.isInteger(run.from) || !Number.isInteger(run.to) || (run.from as number) < 0
    || (run.to as number) <= (run.from as number) || (run.to as number) > length) return false;
  if (!('style' in run)) return typeof run.fontFamily === 'string' && num(run.fontSize)
    && validRgb(run.color as { red: number; green: number; blue: number });
  const style = run.style as Record<string, unknown>;
  if (!style || style.schemaVersion !== 1 || typeof style.fontFamily !== 'string' || !style.fontFamily.trim()
    || !['normal', 'italic', 'oblique'].includes(String(style.fontStyle)) || !num(style.fontWeight)
    || !num(style.fontSize) || (style.fontSize as number) <= 0 || !validRgb(style.color as { red: number; green: number; blue: number })
    || !num(style.tracking) || !['metric', 'optical', 'none'].includes(String(style.kerning))
    || !(style.leading === null || (num(style.leading) && style.leading > 0)) || !num(style.baselineShift)
    || !style.features || typeof style.features !== 'object' || !style.axes || typeof style.axes !== 'object') return false;
  return Object.entries(style.axes as Record<string, unknown>).every(([axis, value]) => axis.length === 4 && num(value));
}

function validTextParagraph(value: unknown, length: number): boolean {
  if (!value || typeof value !== 'object') return false;
  const paragraph = value as Record<string, unknown>, style = paragraph.style as Record<string, unknown> | undefined;
  return Number.isInteger(paragraph.from) && Number.isInteger(paragraph.to) && (paragraph.from as number) >= 0
    && (paragraph.to as number) >= (paragraph.from as number) && (paragraph.to as number) <= length
    && !!style && style.schemaVersion === 1 && ['left', 'center', 'right', 'justify'].includes(String(style.alignment))
    && ['auto', 'ltr', 'rtl'].includes(String(style.direction))
    && ['firstLineIndent', 'startIndent', 'endIndent', 'spaceBefore', 'spaceAfter'].every((key) => num(style[key]));
}

function validVectorPath(value: import('../../contracts-v2').VectorPathRecordV2): boolean {
  return !!value && (value.schemaVersion === undefined || value.schemaVersion === 1)
    && typeof value.closed === 'boolean' && (value.fillRule === undefined || value.fillRule === 'nonzero' || value.fillRule === 'evenodd')
    && Array.isArray(value.points) && value.points.length <= 1_000_000
    && value.points.every((point) => (point.kind === undefined || point.kind === 'corner' || point.kind === 'smooth')
      && [point?.anchor, point?.in, point?.out].every((part) => num(part?.x) && num(part?.y)));
}

function normalizeVectorPath(value: import('../../contracts-v2').VectorPathRecordV2): import('../core/model').VectorPath {
  return { schemaVersion: 1, closed: value.closed, fillRule: value.fillRule ?? 'nonzero', points: value.points.map((point) => ({
    anchor: point.anchor, in: point.in, out: point.out, kind: point.kind ?? 'corner',
  })) };
}

function validVectorMaskRecord(value: import('../../contracts-v2').VectorMaskRecordV2 | null): boolean {
  return value === null || (!!value && (value.schemaVersion === undefined || value.schemaVersion === 1)
    && typeof value.enabled === 'boolean' && typeof value.inverted === 'boolean'
    && (value.density === undefined || (num(value.density) && value.density >= 0 && value.density <= 1))
    && (value.feather === undefined || (num(value.feather) && value.feather >= 0 && value.feather <= 10_000))
    && Array.isArray(value.paths) && value.paths.every(validVectorPath));
}

function normalizeVectorMaskRecord(value: import('../../contracts-v2').VectorMaskRecordV2 | null): import('../core/model').VectorMask | null {
  return value ? { schemaVersion: 1, enabled: value.enabled, inverted: value.inverted, density: value.density ?? 1,
    feather: value.feather ?? 0, paths: value.paths.map(normalizeVectorPath) } : null;
}

function validVectorStroke(value: import('../../contracts-v2').VectorStrokeRecordV2 | null,
  assets: ReadonlyMap<string, AssetRecordV2>): boolean {
  if (value === null) return true;
  return !!value && validRgb(value.color) && num(value.width) && value.width > 0
    && ['inside', 'center', 'outside'].includes(value.alignment)
    && (value.paint === undefined || validFill(value.paint, assets))
    && (value.cap === undefined || ['butt', 'round', 'square'].includes(value.cap))
    && (value.join === undefined || ['miter', 'round', 'bevel'].includes(value.join))
    && (value.miterLimit === undefined || (num(value.miterLimit) && value.miterLimit >= 1))
    && (value.dash === undefined || (Array.isArray(value.dash) && value.dash.length % 2 === 0 && value.dash.every((part) => num(part) && part > 0)))
    && (value.dashOffset === undefined || num(value.dashOffset))
    && [value.startMarker, value.endMarker].every((marker) => marker === undefined
      || ['none', 'arrow', 'openArrow', 'circle', 'square'].includes(marker))
    && (value.markerSize === undefined || (num(value.markerSize) && value.markerSize > 0));
}

function validFill(value: import('../../contracts-v2').FillRecordV2, assets: ReadonlyMap<string, AssetRecordV2>): boolean {
  if (!value || value.schemaVersion !== 1) return false;
  if (value.kind === 'solid') return validRgb(value.color);
  if (value.kind === 'gradient') return num(value.angle) && Array.isArray(value.stops) && value.stops.length >= 2
    && value.stops.every((stop) => num(stop.offset) && stop.offset >= 0 && stop.offset <= 1 && validRgb(stop.color)
      && num(stop.opacity) && stop.opacity >= 0 && stop.opacity <= 1);
  return value.kind === 'pattern' && typeof value.assetId === 'string' && assets.get(value.assetId)?.role === 'pattern'
    && num(value.scale) && value.scale > 0 && num(value.angle);
}

function validEffect(value: import('../../contracts-v2').EffectRecordV2): boolean {
  if (!value || value.schemaVersion !== 1 || typeof value.enabled !== 'boolean') return false;
  if (value.kind === 'dropShadow') return validRgb(value.color)
    && unit(value.opacity) && num(value.angle) && range(value.distance, 0, 10_000) && range(value.blur, 0, 10_000)
    && (value.blendMode === undefined || BLEND_MODE_SET.has(value.blendMode))
    && (value.useGlobalLight === undefined || typeof value.useGlobalLight === 'boolean')
    && (value.spread === undefined || range(value.spread, 0, 100)) && (value.size === undefined || range(value.size, 0, 10_000))
    && (value.contour === undefined || value.contour === 'linear') && (value.noise === undefined || value.noise === 0)
    && (value.knockout === undefined || typeof value.knockout === 'boolean');
  if (value.kind === 'stroke') return (value.color !== undefined && validRgb(value.color) || value.fill !== undefined && validEffectFill(value.fill))
    && range(value.width, 0, 10_000) && ['inside', 'center', 'outside'].includes(value.position)
    && (value.opacity === undefined || unit(value.opacity)) && (value.blendMode === undefined || BLEND_MODE_SET.has(value.blendMode));
  if (value.kind === 'outerGlow') return validRgb(value.color) && unit(value.opacity) && range(value.spread, 0, 100)
    && range(value.size, 0, 10_000)
    && BLEND_MODE_SET.has(value.blendMode) && value.contour === 'linear' && value.noise === 0;
  if (value.kind === 'gradientOverlay') return unit(value.opacity) && num(value.angle) && range(value.scale, 1, 10_000)
    && BLEND_MODE_SET.has(value.blendMode) && validEffectGradient(value.gradient);
  return value.kind === 'colorOverlay' && validRgb(value.color) && unit(value.opacity)
    && (value.blendMode === undefined || BLEND_MODE_SET.has(value.blendMode));
}

function range(value: unknown, minimum: number, maximum: number): value is number {
  return num(value) && value >= minimum && value <= maximum;
}
function unit(value: unknown): value is number { return range(value, 0, 1); }

function validEffectGradient(value: import('../../contracts-v2').EffectGradientV2): boolean {
  return !!value && Array.isArray(value.stops) && value.stops.length >= 2
    && value.stops.every((stop) => num(stop.offset) && stop.offset >= 0 && stop.offset <= 1
      && validRgb(stop.color) && num(stop.opacity) && stop.opacity >= 0 && stop.opacity <= 1)
    && (value.reverse === undefined || typeof value.reverse === 'boolean');
}

function validEffectFill(value: import('../../contracts-v2').EffectFillV2): boolean {
  return value.kind === 'color' ? validRgb(value.color)
    : value.kind === 'gradient' && num(value.angle) && range(value.scale, 1, 10_000) && validEffectGradient(value.gradient);
}

function validLiveFilter(value: import('../../contracts-v2').FilterRecordV2): boolean {
  if (!value || value.schemaVersion !== 1 || typeof value.enabled !== 'boolean') return false;
  if (value.kind === 'gaussianBlur') return num(value.radius);
  if (value.kind === 'motionBlur') return num(value.angle) && num(value.distance);
  if (value.kind === 'noise') return num(value.amount) && typeof value.gaussian === 'boolean' && typeof value.monochromatic === 'boolean';
  if (value.kind === 'lensCorrection') return num(value.distortion);
  if (value.kind === 'unsharpMask') return num(value.amount) && num(value.radius) && num(value.threshold);
  if (value.kind === 'smartSharpen') return num(value.amount) && num(value.radius) && num(value.threshold) && num(value.reduceNoise);
  if (value.kind === 'highPass') return num(value.radius);
  return value.kind === 'denoise' && num(value.luminance) && num(value.colour);
}

async function readHistory(history: ProjectHistoryV2, entries: Record<string, Uint8Array>, records: ReadonlyMap<string, AssetRecordV2>,
  parseDocument: (source: Pick<ProjectManifestV2, 'id' | 'width' | 'height' | 'resolution' | 'globalLightAngle' | 'layers' | 'artboards'>) => Promise<CanvasDocument>): Promise<PersistedHistoryState | undefined> {
  if (history.schemaVersion !== 1 || !Number.isInteger(history.cursor) || history.cursor < 0 || history.cursor > history.commands.length
    || !num(history.retainedByteLimit) || history.retainedByteLimit < 0) invalid('history header');
  if (!history.enabled) return { schemaVersion: 1, enabled: false, retainedByteLimit: history.retainedByteLimit, past: [], future: [] };
  const snapshots = new Map<string, HistorySnapshot>();
  for (const record of history.snapshots) {
    if (!record || typeof record.id !== 'string' || snapshots.has(record.id) || !isSafeRelativePath(record.path)
      || !record.path.startsWith('history/snapshots/')) invalid('history snapshot');
    const bytes = entries[record.path];
    if (!bytes || bytes.byteLength > MANIFEST_LIMIT) invalid('history snapshot file');
    let raw: HistorySnapshotFile;
    try { raw = JSON.parse(new TextDecoder().decode(bytes)) as HistorySnapshotFile; } catch { invalid('history snapshot JSON'); }
    for (const raster of raw.tileRasters ?? []) {
      if (!Number.isInteger(raster.width) || !Number.isInteger(raster.height) || raster.width < 1 || raster.height < 1
        || ![1, 4].includes(raster.channels) || raster.tiles.length !== Math.ceil(raster.width / TILE) * Math.ceil(raster.height / TILE)) {
        invalid('history tile raster');
      }
      for (const assetId of raster.tiles) {
        if (assetId === null) continue;
        const asset = records.get(assetId), tile = asset ? entries[asset.path] : undefined;
        if (!asset || asset.role !== 'history-tile' || !tile || sha256Hex(tile) !== asset.sha256) invalid('history tile asset');
      }
    }
    const document = raw.document ? await parseDocument(raw.document as Pick<ProjectManifestV2, 'id' | 'width' | 'height' | 'resolution' | 'globalLightAngle' | 'layers' | 'artboards'>) : null;
    snapshots.set(record.id, { document, activeLayerId: raw.activeLayerId, revision: raw.revision });
  }
  const commands = history.commands.map((record) => {
    const before = snapshots.get(record.before), after = snapshots.get(record.after);
    if (!before || !after || typeof record.name !== 'string') invalid('history command');
    return { name: record.name, before, after };
  });
  return { schemaVersion: 1, enabled: true, retainedByteLimit: history.retainedByteLimit,
    past: commands.slice(0, history.cursor), future: commands.slice(history.cursor) };
}
