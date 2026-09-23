/**
 * Portable project archive: ZIP with `manifest.json` (the shared ProjectManifestV1 contract) and
 * binary assets. Replaces upstream's `.comp` document package (IO/ProjectStore.swift,
 * docs/project-format.md) while keeping its validation rules and limits: 30,000 px per side,
 * 100 Mpx of image pixels plus 100 Mpx of mask pixels, 10,000 layers, 4 MiB manifest, 512 MiB per
 * asset, safe relative paths only, hierarchy and live-mask graph validation, everything checked
 * before the live document is replaced.
 *
 * Exact upstream values the contract has no field for (the LayerTransform as origin/size/rotation/
 * flips/sampling, placed mask transforms, live-mask sources, resolution, active layer) travel in
 * `extensions["org.compositor.port"]`. Readers without it reconstruct them from the matrices.
 */

import { unzipSync, zipSync, type Zippable } from 'fflate';
import type { AssetRecord, LayerRecord, Matrix2D, ProjectManifestV1 } from '../../contracts';
import {
  BLEND_MODE_SET, hierarchyRecord, InvalidProjectError, layerPixelHeight, layerPixelWidth, MAX_LAYERS, MAX_PIXELS, MAX_SIDE,
  validateHierarchy, validateLiveMasks, type BlendMode, type CanvasDocument, type Layer, type LayerAdjustment, type LayerShape,
} from '../core/document';
import {
  concat, fromMatrix, isValidTransform, makeTransform, pixelToDocument, placing, scaling, toMatrix,
  LAYER_SAMPLINGS, type LayerTransform,
} from '../core/geometry';
import { Raster } from '../core/raster';
import { decodePng, encodePng } from './png';
import { sha256Hex } from './sha256';

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
  if (raster.source) asset = { bytes: raster.source.bytes, mime: raster.source.mime, sha256: raster.source.sha256 };
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
    const kind: LayerRecord['kind'] = layer.isGroup ? 'group' : layer.adjustment ? 'adjustment' : layer.shape ? 'shape' : 'raster';
    const record: LayerRecord = {
      id: layer.id, parentId: layer.parentId, name: layer.name, kind, visible: layer.visible, locked: layer.locked,
      opacity: layer.opacity, blendMode: layer.blendMode,
      transform: matrix(layer.transform, layerPixelWidth(layer), layerPixelHeight(layer)),
      clippedToBelow: layer.maskSourceId !== null,
      parameters: (layer.adjustment ?? layer.shape ?? {}) as Record<string, unknown>,
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

/** Writes the ZIP archive. Assets are stored uncompressed (already compressed images). */
export function writeArchive(document: CanvasDocument, name: string, activeLayerId: string | null): { blob: Blob; manifest: ProjectManifestV1 } {
  const manifest = buildManifest(document, name, activeLayerId);
  const json = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  if (json.byteLength > MANIFEST_LIMIT) throw new ProjectError('too-large', 'The project manifest exceeds 4 MiB.');
  const files: Zippable = { 'manifest.json': [json, { level: 6 }] };
  const rasters = new Map<string, Raster>();
  for (const layer of document.layers) {
    if (layer.raster) rasters.set(layer.raster.id, layer.raster);
    if (layer.mask) rasters.set(layer.mask.raster.id, layer.mask.raster);
  }
  for (const asset of manifest.assets) {
    const raster = rasters.get(asset.id)!;
    files[asset.path] = [encodedAsset(raster).bytes, { level: 0 }];
  }
  const zipped = zipSync(files, { mtime: new Date('2026-01-01T00:00:00Z') });
  return { blob: new Blob([zipped as BlobPart], { type: 'application/zip' }), manifest };
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
function invalid(detail: string): never { throw new ProjectError('invalid', `This is not a valid Compositor project, or its metadata is damaged (${detail}).`); }

export interface LoadedProject {
  document: CanvasDocument;
  name: string;
  activeLayerId: string | null;
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
  let manifest: ProjectManifestV1;
  try { manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as ProjectManifestV1; } catch { invalid('manifest is not JSON'); }
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
    let pixels: { width: number; height: number; channels: 1 | 4; data: Uint8Array };
    if (record.mime === 'image/png') {
      const png = decodePng(bytes);
      pixels = png;
    } else pixels = await decodeImage(bytes, record.mime);
    if (pixels.width !== record.width || pixels.height !== record.height) invalid('asset size does not match its record');
    let data = pixels.data;
    let channels = pixels.channels;
    if (mask && channels === 4) {
      // Masks are scalar coverage; accept an RGBA writer's gray by taking the red channel.
      const gray = new Uint8Array(pixels.width * pixels.height);
      for (let i = 0; i < gray.length; i++) gray[i] = data[i * 4]!;
      data = gray; channels = 1;
    } else if (!mask && channels === 1) {
      const rgba = new Uint8Array(pixels.width * pixels.height * 4);
      for (let i = 0; i < data.length; i++) { const v = data[i]!; rgba.set([v, v, v, 255], i * 4); }
      data = rgba; channels = 4;
    }
    const raster = Raster.fromPixels(pixels.width, pixels.height, channels, data, {
      id, source: { bytes, mime: record.mime, sha256: hash } });
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
    layers.push({
      id: record.id, name: record.name, visible: record.visible !== false, locked: record.locked === true,
      parentId: record.parentId ?? null, isGroup, opacity: record.opacity, blendMode: record.blendMode as BlendMode, transform, raster, mask,
      maskSourceId: null,
      adjustment: record.kind === 'adjustment' ? validAdjustment(record.parameters) : null,
      shape: record.kind === 'shape' ? (record.parameters as LayerShape) : null,
    });
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
      if (!below || below.isGroup) invalid('clipping mask without a base');
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
    document: { id: manifest.id, width: manifest.width, height: manifest.height, resolution, layers, selection: null },
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
  const value = parameters as LayerAdjustment;
  if (!value || typeof value !== 'object' || typeof value.kind !== 'string') invalid('adjustment parameters');
  return value;
}
