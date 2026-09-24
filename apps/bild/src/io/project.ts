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
  defaultCurves, defaultExposure, defaultGradientMap, defaultGrain, defaultHueSaturation, defaultLevels,
  isValidAdjustment,
} from '../core/adjustments';
import { unzipSync, zipSync, type Zippable } from 'fflate';
import type { AssetRecord, LayerRecord, Matrix2D, ProjectManifestV1 } from '../../contracts';
import type {
  AdjustmentRecordV2, AssetRecordV2, LayerCommonV2, LayerRecordV2, ProjectHistoryV2, ProjectManifestV2,
} from '../../contracts-v2';
import type { HistorySnapshot, PersistedHistoryState } from '../core/history';
import {
  BLEND_MODE_SET, documentsEqual, hierarchyRecord, InvalidProjectError, layerPixelHeight, layerPixelWidth, MAX_LAYERS,
  LITE_DOCUMENT_LIMITS, PRO_DOCUMENT_LIMITS,
  newLayer, validateHierarchy, validateLiveMasks, type Guide, type BlendMode, type CanvasDocument, type Layer, type LayerAdjustment, type LayerShape,
  type DocumentLimits,
} from '../core/document';
import {
  concat, fromMatrix, isValidTransform, makeTransform, pixelToDocument, placing, scaling, toMatrix,
  LAYER_SAMPLINGS, type LayerTransform,
} from '../core/geometry';
import { Raster, TILE } from '../core/raster';
import { vectorPathsForShape } from '../core/shape';
import { decodePng, decodePngNativeRGBA, encodePng, encodePngRasterStream } from './png';
import { prepareStreamingSha256, sha256Hex } from './sha256';
import type { RasterResidency } from '../core/storage';
import { convertStreamedPng, PngTileStreamDecoder, restoreStreamedPng, type StreamedPngRaster } from './pngStream';
import { readZipEntries, Zip64StreamWriter } from './zipStream';

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
    const bytes = encodePng(raster.toPixels16(), raster.width, raster.height, 4,
      { bitDepth: 16, limits: PRO_DOCUMENT_LIMITS });
    asset = { bytes, mime: 'image/png', sha256: sha256Hex(bytes) };
  } else if (raster.source) asset = { bytes: raster.source.bytes, mime: raster.source.mime, sha256: raster.source.sha256 };
  else {
    const bytes = encodePng(raster.toPixels(), raster.width, raster.height, raster.channels,
      { limits: PRO_DOCUMENT_LIMITS });
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
      const encoded = raster.archivedSource ?? encodedAsset(raster);
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
      id: layer.id, parentId: layer.parentId, name: layer.name, kind, visible: layer.visible, locked: layer.locked,
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
  }
}

interface V2BuildContext {
  assets: Map<string, AssetRecordV2>;
  rasters: Map<string, Raster>;
  binaryAssets: Map<string, Uint8Array>;
  deferEncoding?: boolean;
}

function addV2Asset(context: V2BuildContext, raster: Raster, role: AssetRecordV2['role']): string {
  const occupied = context.assets.get(raster.id);
  if (occupied && occupied.role !== role) throw new ProjectError('invalid', `Asset ID ${raster.id} is used for incompatible roles.`);
  if (!context.assets.has(raster.id)) {
    const original = raster.format !== 'rgba16' ? raster.source : null;
    const encoded = context.deferEncoding
      ? { mime: original?.mime ?? 'image/png', sha256: original?.sha256 ?? '' }
      : encodedAsset(raster);
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
    locks: layer.locks ?? { transparency: false, pixels: layer.locked, position: false, all: layer.locked },
    colorLabel: layer.colorLabel ?? 'none', transform: layer.transform, warp: layer.warp ?? null, crop: layer.crop ?? null,
    mask: layer.mask ? { assetId: addV2Asset(context, layer.mask.raster, 'mask'), transform: layer.mask.placement,
      linked: layer.mask.linked, enabled: layer.mask.enabled } : null,
    vectorMask: layer.vectorMask ?? null, clippedTo: layer.maskSourceId,
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
      const sourceShape = shape && (shape.kind === 'Rectangle' || shape.kind === 'Ellipse')
        && num(shape.red) && num(shape.green) && num(shape.blue) && num(shape.cornerRadius)
        ? { kind: shape.kind, red: shape.red, green: shape.green, blue: shape.blue, cornerRadius: shape.cornerRadius } : null;
      return { ...common, kind: 'vector', paths: value.paths ?? [], style: value.style ?? { fill: null, stroke: null },
        previewAssetId: preview, sourceShape };
    }
    case 'text': {
      const value = layer as import('../core/model').TextLayer;
      return { ...common, kind: 'text', text: value.text, runs: value.runs, box: value.box,
        alignment: value.alignment, previewAssetId: preview };
    }
    case 'embedded': {
      const value = layer as import('../core/model').EmbeddedLayer;
      return { ...common, kind: 'embedded', content: value.content, previewAssetId: preview };
    }
    default: return { ...common, kind: 'pixel', assetId: preview };
  }
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
    resolution: document.resolution, colorSpace: 'srgb', activeLayerId, layers, artboards: document.artboards ?? [],
    ...(document.guides?.length ? { guides: document.guides.map((g) => ({ id: g.id, orientation: g.orientation, position: g.position })) } : {}),
    assets: [...context.assets.values()] };
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

/**
 * A4 large-document writer: PNG rows and ZIP entries are pushed incrementally. The returned Blob
 * consists of bounded ZIP chunks; no contiguous raster or archive `Uint8Array` is constructed.
 */
export async function writeArchiveStreaming(document: CanvasDocument, name: string, activeLayerId: string | null,
  residency?: RasterResidency, history?: PersistedHistoryState,
  emitChunk?: (chunk: Uint8Array) => void | Promise<void>): Promise<{ blob: Blob; manifest: ProjectManifestV2 }> {
  const context: V2BuildContext = { assets: new Map(), rasters: new Map(), binaryAssets: new Map(), deferEncoding: true };
  const manifest = manifestV2WithContext(document, name, activeLayerId, context);
  const extraFiles = new Map<string, Uint8Array>();
  if (history) manifest.history = writeHistoryStreaming(history, name, context, extraFiles);
  const zip = new Zip64StreamWriter(emitChunk);
  const makeHasher = await prepareStreamingSha256();
  for (const record of [...context.assets.values()]) {
    const hash = makeHasher();
    const raster = context.rasters.get(record.id);
    const binary = context.binaryAssets.get(record.id);
    await zip.add(record.path, async (input) => {
      if (raster?.source && raster.format !== 'rgba16') {
        hash.update(raster.source.bytes); input.push(raster.source.bytes, true);
      } else if (raster) {
        await encodePngRasterStream(raster, (chunk) => { hash.update(chunk); input.push(chunk); },
          { bitDepth: raster.format === 'rgba16' ? 16 : 8, limits: PRO_DOCUMENT_LIMITS, residency,
            filter: 'none', level: 1, drain: () => zip.drain() });
        input.push(new Uint8Array(), true);
      } else if (binary) { hash.update(binary); input.push(binary, true); }
      else throw new ProjectError('missing-image', `Asset ${record.id} has no bytes.`);
    });
    context.assets.set(record.id, { ...record, sha256: hash.digestHex() });
  }
  for (const [path, bytes] of extraFiles) {
    await zip.add(path, (input) => { input.push(bytes, true); });
  }
  manifest.assets = [...context.assets.values()];
  const json = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  if (json.byteLength > MANIFEST_LIMIT) throw new ProjectError('too-large', 'The project manifest exceeds 4 MiB.');
  await zip.add('manifest.json', (input) => { input.push(json, true); });
  const blob = zip.finish();
  await zip.drain();
  return { blob, manifest };
}

function writeHistoryStreaming(state: PersistedHistoryState, name: string, context: V2BuildContext,
  files: Map<string, Uint8Array>): ProjectHistoryV2 {
  if (!state.enabled) return { schemaVersion: 1, enabled: false, retainedByteLimit: state.retainedByteLimit,
    cursor: 0, commands: [], snapshots: [] };
  const snapshots: ProjectHistoryV2['snapshots'][number][] = [];
  const ids = new Map<HistorySnapshot, string>();
  const snapshotId = (snapshot: HistorySnapshot): string => {
    const known = ids.get(snapshot);
    if (known) return known;
    const id = `snapshot-${ids.size + 1}`, path = `history/snapshots/${id}.json`;
    ids.set(snapshot, id);
    const built = snapshot.document ? manifestV2WithContext(snapshot.document, name, snapshot.activeLayerId, context) : null;
    const value: HistorySnapshotFile = { document: built ? {
      id: built.id, width: built.width, height: built.height, resolution: built.resolution, colorSpace: built.colorSpace,
      activeLayerId: built.activeLayerId, layers: built.layers, artboards: built.artboards, extensions: built.extensions,
    } : null, activeLayerId: snapshot.activeLayerId, revision: snapshot.revision, tileRasters: [] };
    files.set(path, new TextEncoder().encode(JSON.stringify(value)));
    snapshots.push({ id, path, activeLayerId: snapshot.activeLayerId, revision: snapshot.revision });
    return id;
  };
  const commands = [...state.past, ...state.future].map((command) => ({
    name: command.name, before: snapshotId(command.before), after: snapshotId(command.after),
  }));
  return { schemaVersion: 1, enabled: true, retainedByteLimit: state.retainedByteLimit,
    cursor: state.past.length, commands, snapshots };
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
      activeLayerId: built.activeLayerId, layers: built.layers, artboards: built.artboards, extensions: built.extensions,
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

interface StreamedArchive {
  readonly entries: Record<string, Uint8Array>;
  readonly png: ReadonlyMap<string, StreamedPngRaster>;
}

async function unzipBlobStreaming(blob: Blob, residency?: RasterResidency,
  limits: DocumentLimits = LITE_DOCUMENT_LIMITS): Promise<StreamedArchive> {
  const entries: Record<string, Uint8Array> = {};
  const png = new Map<string, StreamedPngRaster>();
  const makeHasher = await prepareStreamingSha256();
  for await (const file of readZipEntries(blob)) {
    const decoder = residency && file.name.toLowerCase().endsWith('.png')
      ? new PngTileStreamDecoder(residency, { maxSide: limits.maxSide, maxPixels: limits.maxPixels }, makeHasher()) : null;
    const chunks: Uint8Array[] = [];
    let length = 0;
    const maximum = decoder ? Math.max(ASSET_LIMIT, limits.maxPixels * 8 + 128 * 1024 * 1024) : ASSET_LIMIT;
    if (file.size > maximum) throw new ProjectError('too-large', 'A file inside the project exceeds the supported size.');
    for await (const chunk of file.chunks) {
      length += chunk.byteLength;
      if (length > maximum) throw new ProjectError('too-large', 'A file inside the project exceeds the supported size.');
      if (decoder) { decoder.push(chunk); await decoder.idle(); }
      else chunks.push(chunk.slice());
    }
    if (length !== file.size) throw new Error(`${file.name}: ZIP entry size does not match its central directory`);
    if (decoder) {
      try { png.set(file.name, await decoder.finish()); }
      catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`${file.name}: ${message}`);
      }
    } else {
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
      entries[file.name] = bytes;
    }
  }
  return { entries, png };
}

/** Parses, validates and decodes an archive. Nothing is installed until everything succeeded. */
export async function readArchive(blob: Blob, decodeImage: ImageDecoder, limits: DocumentLimits = LITE_DOCUMENT_LIMITS,
  residency?: RasterResidency): Promise<LoadedProject> {
  let archive: StreamedArchive;
  try {
    archive = await unzipBlobStreaming(blob, residency, limits);
  } catch (error) {
    if (error instanceof ProjectError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new ProjectError('invalid', `This file is not a readable project archive: ${detail}`);
  }
  const { entries } = archive;
  const manifestBytes = entries['manifest.json'];
  if (!manifestBytes) invalid('manifest.json is missing');
  if (manifestBytes.byteLength > MANIFEST_LIMIT) throw new ProjectError('too-large', 'The project manifest exceeds 4 MiB.');
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(manifestBytes)) as unknown; } catch { invalid('manifest is not JSON'); }
  const discriminator = parsed as { format?: unknown; version?: unknown };
  if (discriminator.format === 'fernwork-image') {
    if (discriminator.version !== 2) throw new ProjectError('version', `This project uses format version ${String(discriminator.version)}. This editor supports version 2.`);
    return readV2Archive(parsed as ProjectManifestV2, entries, archive.png, decodeImage, limits, residency);
  }
  const manifest = parsed as ProjectManifestV1;
  if (manifest.format !== 'fernwork-compositor') invalid('unknown format');
  if (manifest.version !== 1) throw new ProjectError('version', `This project uses format version ${String(manifest.version)}. This editor supports version 1.`);
  if (manifest.colorSpace !== 'srgb') invalid('colour space');
  if (!Number.isInteger(manifest.width) || !Number.isInteger(manifest.height) || manifest.width < 1 || manifest.height < 1
    || manifest.width > limits.maxSide || manifest.height > limits.maxSide || manifest.width * manifest.height > limits.maxPixels) throw new ProjectError('too-large', 'This project exceeds the supported canvas size.');
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
      || asset.width > limits.maxSide || asset.height > limits.maxSide) throw new ProjectError('too-large', 'An image inside the project exceeds the current side limit.');
    if (typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256)) invalid('asset hash');
    records.set(asset.id, asset);
  }
  const maskAssetIds = new Set<string>();
  const imageAssetIds = new Set<string>();
  for (const layer of manifest.layers) {
    if (layer?.assetId) imageAssetIds.add(layer.assetId);
    if (layer?.mask?.assetId) maskAssetIds.add(layer.mask.assetId);
  }
  for (const id of [...imageAssetIds, ...maskAssetIds]) {
    const asset = records.get(id);
    if (asset && asset.width * asset.height > limits.maxPixels) {
      throw new ProjectError('too-large', 'An image inside the project exceeds the current pixel limit.');
    }
  }

  const rasters = new Map<string, Raster>();
  const decode = async (id: string, mask: boolean): Promise<Raster> => {
    const existing = rasters.get(id);
    if (existing) {
      if ((existing.channels === 1) !== mask) invalid('asset used as both mask and image');
      return existing;
    }
    const record = records.get(id);
    if (!record) invalid(`missing asset record ${id}`);
    const streamed = archive.png.get(record.path);
    if (streamed) {
      if (!residency || streamed.sha256 !== record.sha256) throw new ProjectError('missing-image', 'An image inside the project is damaged (checksum mismatch). The current document has not been replaced.');
      if (streamed.width !== record.width || streamed.height !== record.height) invalid('asset size does not match its record');
      const converted = await convertStreamedPng(streamed, mask ? 1 : 4, residency);
      const raster = restoreStreamedPng(converted, id, residency);
      rasters.set(id, raster);
      return raster;
    }
    const bytes = entries[record.path];
    if (!bytes) throw new ProjectError('missing-image', 'An image inside the project is missing or damaged. The current document has not been replaced.');
    const hash = sha256Hex(bytes);
    if (hash !== record.sha256) throw new ProjectError('missing-image', 'An image inside the project is damaged (checksum mismatch). The current document has not been replaced.');
    let pixels: { width: number; height: number; channels: 1 | 4; data: Uint8Array | Uint16Array; bitDepth: 8 | 16 };
    if (record.mime === 'image/png') {
      const codecLimits = { maxSide: limits.maxSide, maxPixels: limits.maxPixels };
      if (mask) {
        const png = decodePng(bytes, codecLimits);
        pixels = { ...png, bitDepth: 8 };
      } else {
        const png = decodePngNativeRGBA(bytes, codecLimits);
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
  return value as unknown as LayerShape;
}

async function readV2Archive(manifest: ProjectManifestV2, entries: Record<string, Uint8Array>,
  streamedPng: ReadonlyMap<string, StreamedPngRaster>, decodeImage: ImageDecoder,
  limits: DocumentLimits, residency?: RasterResidency): Promise<LoadedProject> {
  if (manifest.format !== 'fernwork-image' || manifest.version !== 2 || manifest.colorSpace !== 'srgb') invalid('v2 header');
  if (!Number.isInteger(manifest.width) || !Number.isInteger(manifest.height) || manifest.width < 1 || manifest.height < 1
    || manifest.width > limits.maxSide || manifest.height > limits.maxSide || manifest.width * manifest.height > limits.maxPixels) throw new ProjectError('too-large', 'This project exceeds the supported canvas size.');
  if (!num(manifest.resolution) || manifest.resolution < 1 || manifest.resolution > 9600) invalid('resolution');
  if (typeof manifest.id !== 'string' || !manifest.id || typeof manifest.name !== 'string') invalid('identity');
  if (!Array.isArray(manifest.layers) || !Array.isArray(manifest.assets) || !Array.isArray(manifest.artboards)
    || manifest.layers.length > MAX_LAYERS) invalid('v2 collections');

  const records = new Map<string, AssetRecordV2>();
  for (const asset of manifest.assets) {
    if (!asset || typeof asset.id !== 'string' || !asset.id || records.has(asset.id) || !isSafeRelativePath(asset.path)
      || typeof asset.mime !== 'string' || typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256)
      || !['image', 'mask', 'pattern', 'embedded', 'history-tile'].includes(asset.role)) invalid('v2 asset');
    if (asset.width !== undefined && (!Number.isInteger(asset.width) || asset.width < 1 || asset.width > limits.maxSide)) invalid('v2 asset width');
    if (asset.height !== undefined && (!Number.isInteger(asset.height) || asset.height < 1 || asset.height > limits.maxSide)) invalid('v2 asset height');
    if (asset.width && asset.height && asset.width * asset.height > limits.maxPixels) {
      throw new ProjectError('too-large', 'An image inside the project exceeds the current pixel limit.');
    }
    records.set(asset.id, asset);
  }

  const rasters = new Map<string, Raster>();
  const resources: Array<NonNullable<CanvasDocument['resources']>[number]> = [];
  for (const record of records.values()) {
    if (record.role !== 'pattern' && record.role !== 'embedded') continue;
    const bytes = entries[record.path];
    if (!bytes || sha256Hex(bytes) !== record.sha256) throw new ProjectError('missing-image', 'An embedded project asset is missing or damaged.');
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
    const streamed = streamedPng.get(record.path);
    if (streamed) {
      if (!residency || streamed.sha256 !== record.sha256) throw new ProjectError('missing-image', 'An image inside the project is missing or damaged.');
      if (streamed.width !== record.width || streamed.height !== record.height) invalid('asset size does not match its record');
      const converted = await convertStreamedPng(streamed, mask ? 1 : 4, residency);
      const raster = restoreStreamedPng(converted, id, residency);
      rasters.set(id, raster);
      return raster;
    }
    const bytes = entries[record.path];
    if (!bytes || sha256Hex(bytes) !== record.sha256) throw new ProjectError('missing-image', 'An image inside the project is missing or damaged.');
    // Image assets keep their depth: PNG16 stays 16-bit (A3); masks and other codecs are 8-bit.
    let decoded: { width: number; height: number; channels: 1 | 4; data: Uint8Array | Uint16Array; bitDepth: 8 | 16 };
    if (record.mime === 'image/png') {
      const codecLimits = { maxSide: limits.maxSide, maxPixels: limits.maxPixels };
      decoded = mask ? { ...decodePng(bytes, codecLimits), bitDepth: 8 }
        : { ...decodePngNativeRGBA(bytes, codecLimits), channels: 4 };
    }
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

  const parseDocument = async (source: Pick<ProjectManifestV2, 'id' | 'width' | 'height' | 'resolution' | 'layers' | 'artboards'>): Promise<CanvasDocument> => {
    if (typeof source.id !== 'string' || !source.id || !Number.isInteger(source.width) || !Number.isInteger(source.height)
      || source.width < 1 || source.height < 1 || source.width > limits.maxSide || source.height > limits.maxSide
      || source.width * source.height > limits.maxPixels
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
        || !Array.isArray(record.filters) || !record.filters.every(validLiveFilter)) invalid('v2 layer');
      ids.add(record.id);
      if (!['pixel', 'group', 'adjustment', 'fill', 'vector', 'text', 'embedded'].includes(record.kind)) invalid('v2 layer kind');
      const assetId = record.kind === 'pixel' ? record.assetId
        : record.kind === 'vector' || record.kind === 'text' || record.kind === 'embedded' ? record.previewAssetId : null;
      const raster = assetId ? await decode(assetId, false) : null;
      const maskRaster = record.mask ? await decode(record.mask.assetId, true) : null;
      const mask = record.mask && maskRaster ? { raster: maskRaster, enabled: record.mask.enabled,
        linked: record.mask.linked, placement: record.mask.transform } : null;
      const common = {
        id: record.id, name: record.name, visible: record.visible !== false, locked: record.locks.all,
        parentId: record.parentId, opacity: record.opacity, fillOpacity: record.fillOpacity,
        blendMode: record.blendMode as BlendMode, locks: record.locks, colorLabel: record.colorLabel,
        transform: record.transform, warp: record.warp, crop: record.crop, raster, mask,
        vectorMask: record.vectorMask, maskSourceId: record.clippedTo, effects: record.effects, filters: record.filters,
      };
      switch (record.kind) {
        case 'group': layers.push(newLayer({ ...common, kind: 'group' })); break;
        case 'adjustment': {
          if (!record.adjustment || record.adjustment.schemaVersion !== 1) invalid('adjustment schema');
          const adjustment = liveAdjustment(record.adjustment);
          if (!isValidAdjustment(adjustment)) invalid('adjustment parameters');
          layers.push(newLayer({ ...common, kind: 'adjustment', adjustment }));
          break;
        }
        case 'fill':
          if (!validFill(record.fill, records)) invalid('fill parameters');
          layers.push(newLayer({ ...common, kind: 'fill', fill: record.fill }));
          break;
        case 'vector':
          if (!Array.isArray(record.paths) || !record.paths.every(validVectorPath) || !record.style
            || (record.style.fill !== null && !validFill(record.style.fill, records))) invalid('vector parameters');
          if (record.sourceShape !== null) validLegacyShape(record.sourceShape);
          layers.push(newLayer({ ...common, kind: 'vector', paths: record.paths, style: record.style,
            sourceShape: record.sourceShape })); break;
        case 'text':
          if (typeof record.text !== 'string' || !Array.isArray(record.runs)
            || !['left', 'center', 'right', 'justify'].includes(record.alignment)) invalid('text parameters');
          layers.push(newLayer({ ...common, kind: 'text', text: record.text, runs: record.runs,
            box: record.box, alignment: record.alignment })); break;
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
    return { id: source.id, width: source.width, height: source.height, resolution: source.resolution,
      layers, artboards: source.artboards, ...(guides?.length ? { guides: (guides as Guide[]).map((g) => ({ id: g.id, orientation: g.orientation, position: g.position })) } : {}),
      resources, selection: null };
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

function validVectorPath(value: import('../../contracts-v2').VectorPathRecordV2): boolean {
  return !!value && typeof value.closed === 'boolean' && Array.isArray(value.points)
    && value.points.every((point) => [point?.anchor, point?.in, point?.out].every((part) => num(part?.x) && num(part?.y)));
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
    && [value.opacity, value.angle, value.distance, value.blur].every(num);
  if (value.kind === 'stroke') return validRgb(value.color) && num(value.width)
    && ['inside', 'center', 'outside'].includes(value.position);
  return value.kind === 'colorOverlay' && validRgb(value.color) && num(value.opacity);
}

function validLiveFilter(value: import('../../contracts-v2').FilterRecordV2): boolean {
  if (!value || value.schemaVersion !== 1 || typeof value.enabled !== 'boolean') return false;
  if (value.kind === 'gaussianBlur') return num(value.radius);
  if (value.kind === 'motionBlur') return num(value.angle) && num(value.distance);
  if (value.kind === 'noise') return num(value.amount) && typeof value.gaussian === 'boolean' && typeof value.monochromatic === 'boolean';
  return value.kind === 'lensCorrection' && num(value.distortion);
}

async function readHistory(history: ProjectHistoryV2, entries: Record<string, Uint8Array>, records: ReadonlyMap<string, AssetRecordV2>,
  parseDocument: (source: Pick<ProjectManifestV2, 'id' | 'width' | 'height' | 'resolution' | 'layers' | 'artboards'>) => Promise<CanvasDocument>): Promise<PersistedHistoryState | undefined> {
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
    const document = raw.document ? await parseDocument(raw.document as Pick<ProjectManifestV2, 'id' | 'width' | 'height' | 'resolution' | 'layers' | 'artboards'>) : null;
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
