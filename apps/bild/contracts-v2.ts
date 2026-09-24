import type { EditorHandle, HostAdapter, Matrix2D } from './contracts';

export type AssetIdV2 = string;
export type LayerIdV2 = string;
export type PointV2 = Readonly<{ x: number; y: number }>;
export type RectV2 = Readonly<{ x: number; y: number; width: number; height: number }>;
export type RGBV2 = Readonly<{ red: number; green: number; blue: number }>;

export interface AssetRecordV2 {
  id: AssetIdV2;
  path: string;
  mime: string;
  width?: number;
  height?: number;
  channels?: 1 | 4;
  sha256: string;
  role: 'image' | 'mask' | 'pattern' | 'embedded' | 'font' | 'history-tile';
}

export interface TextRunStyleRecordV2 {
  schemaVersion: 1;
  fontFamily: string;
  fontStyle: 'normal' | 'italic' | 'oblique';
  fontWeight: number;
  fontSize: number;
  color: RGBV2 & { alpha?: number };
  tracking: number;
  kerning: 'metric' | 'optical' | 'none';
  leading: number | null;
  baselineShift: number;
  features: Partial<Record<'liga' | 'dlig' | 'tnum' | 'lnum' | 'onum' | 'smcp', boolean>>;
  axes: Record<string, number>;
}
export interface TextRunRecordV2 { from: number; to: number; style: TextRunStyleRecordV2 }
export interface TextParagraphStyleRecordV2 {
  schemaVersion: 1;
  alignment: 'left' | 'center' | 'right' | 'justify';
  direction: 'auto' | 'ltr' | 'rtl';
  firstLineIndent: number;
  startIndent: number;
  endIndent: number;
  spaceBefore: number;
  spaceAfter: number;
}
export interface TextParagraphRecordV2 { from: number; to: number; style: TextParagraphStyleRecordV2 }
export interface DocumentFontRecordV2 {
  id: string;
  family: string;
  style: string;
  weight: number;
  source: 'bundled' | 'system' | 'local' | 'embedded';
  postscriptName?: string;
  resourceId?: AssetIdV2;
  embeddingAllowed: boolean;
}

export interface LayerTransformV2 {
  origin: PointV2;
  size: Readonly<{ width: number; height: number }>;
  rotation: number;
  flipX: boolean;
  flipY: boolean;
  sampling: 'Nearest' | 'Smooth' | 'High quality';
}

export interface LayerCommonV2 {
  id: LayerIdV2;
  parentId: LayerIdV2 | null;
  name: string;
  visible: boolean;
  opacity: number;
  fillOpacity: number;
  blendMode: string;
  locks: { transparency: boolean; pixels: boolean; position: boolean; all: boolean };
  colorLabel: 'none' | 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'violet' | 'gray';
  transform: LayerTransformV2;
  warp: { kind: 'quad'; schemaVersion: 1; corners: readonly [PointV2, PointV2, PointV2, PointV2] } | null;
  crop: { rect: RectV2; feather: number } | null;
  mask: { assetId: AssetIdV2; transform: LayerTransformV2 | null; linked: boolean; enabled: boolean } | null;
  vectorMask: VectorMaskRecordV2 | null;
  clippedTo: LayerIdV2 | null;
  effects: readonly EffectRecordV2[];
  filters: readonly FilterRecordV2[];
}

export interface VectorPathRecordV2 {
  closed: boolean;
  points: readonly { anchor: PointV2; in: PointV2; out: PointV2 }[];
}
export interface VectorMaskRecordV2 { enabled: boolean; inverted: boolean; paths: readonly VectorPathRecordV2[] }

export type EffectRecordV2 =
  | { kind: 'dropShadow'; schemaVersion: 1; enabled: boolean; opacity: number; angle: number; distance: number; blur: number; color: RGBV2 }
  | { kind: 'stroke'; schemaVersion: 1; enabled: boolean; width: number; position: 'inside' | 'center' | 'outside'; color: RGBV2 }
  | { kind: 'colorOverlay'; schemaVersion: 1; enabled: boolean; opacity: number; color: RGBV2 };

export type FilterRecordV2 =
  | { kind: 'gaussianBlur'; schemaVersion: 1; enabled: boolean; radius: number }
  | { kind: 'motionBlur'; schemaVersion: 1; enabled: boolean; angle: number; distance: number }
  | { kind: 'noise'; schemaVersion: 1; enabled: boolean; amount: number; gaussian: boolean; monochromatic: boolean }
  | { kind: 'lensCorrection'; schemaVersion: 1; enabled: boolean; distortion: number };

export interface HueSaturationParametersV1 {
  hue: number; saturation: number; lightness: number; colorize: boolean;
  settings: {
    range: 'Master' | 'Reds' | 'Yellows' | 'Greens' | 'Cyans' | 'Blues' | 'Magentas';
    colorize: boolean;
    invertRange: boolean;
    adjustments: Partial<Record<'Master' | 'Reds' | 'Yellows' | 'Greens' | 'Cyans' | 'Blues' | 'Magentas',
      { hue: number; saturation: number; lightness: number }>>;
    bands: Partial<Record<'Master' | 'Reds' | 'Yellows' | 'Greens' | 'Cyans' | 'Blues' | 'Magentas',
      { falloffStart: number; rangeStart: number; rangeEnd: number; falloffEnd: number }>>;
  };
}
export interface LevelsParametersV1 { channel: 'RGB' | 'Red' | 'Green' | 'Blue'; ranges: readonly { black: number; gamma: number; white: number; outputBlack: number; outputWhite: number }[] }
export interface CurvesParametersV1 { channel: 'RGB' | 'Red' | 'Green' | 'Blue'; channels: readonly (readonly { x: number; y: number }[])[] }
export interface ExposureParametersV1 { exposure: number; offset: number; gamma: number }
export interface GradientMapParametersV1 { shadows: RGBV2; highlights: RGBV2; reversed: boolean }
export interface GrainParametersV1 { amount: number; size: number; roughness: number; seed: number }
export type AdjustmentRecordV2 =
  | { kind: 'Hue/Saturation'; schemaVersion: 1; parameters: HueSaturationParametersV1 }
  | { kind: 'Levels'; schemaVersion: 1; parameters: LevelsParametersV1 }
  | { kind: 'Curves'; schemaVersion: 1; parameters: CurvesParametersV1 }
  | { kind: 'Exposure'; schemaVersion: 1; parameters: ExposureParametersV1 }
  | { kind: 'Gradient Map'; schemaVersion: 1; parameters: GradientMapParametersV1 }
  | { kind: 'Grain'; schemaVersion: 1; parameters: GrainParametersV1 };

export type FillRecordV2 =
  | { kind: 'solid'; schemaVersion: 1; color: RGBV2 }
  | { kind: 'gradient'; schemaVersion: 1; angle: number; stops: readonly { offset: number; color: RGBV2; opacity: number }[] }
  | { kind: 'pattern'; schemaVersion: 1; assetId: AssetIdV2; scale: number; angle: number };

export type LayerRecordV2 =
  | (LayerCommonV2 & { kind: 'pixel'; assetId: AssetIdV2 | null })
  | (LayerCommonV2 & { kind: 'group' })
  | (LayerCommonV2 & { kind: 'adjustment'; adjustment: AdjustmentRecordV2 })
  | (LayerCommonV2 & { kind: 'fill'; fill: FillRecordV2 })
  | (LayerCommonV2 & { kind: 'vector'; paths: readonly VectorPathRecordV2[]; style: { fill: FillRecordV2 | null; stroke: { color: RGBV2; width: number; alignment: 'inside' | 'center' | 'outside' } | null }; previewAssetId: AssetIdV2 | null;
      sourceShape: { kind: 'Rectangle' | 'Ellipse'; red: number; green: number; blue: number; cornerRadius: number } | null })
  | (LayerCommonV2 & { kind: 'text'; textSchemaVersion: 1; text: string; runs: readonly TextRunRecordV2[];
      paragraphs: readonly TextParagraphRecordV2[]; box: { width: number; height: number } | null;
      alignment: 'left' | 'center' | 'right' | 'justify'; previewAssetId: AssetIdV2 | null;
      previewTransform: LayerTransformV2 | null })
  | (LayerCommonV2 & { kind: 'embedded'; content: { mode: 'embedded' | 'linked'; mediaType: 'image' | 'svg' | 'pdf' | 'project'; assetId?: AssetIdV2; uri?: string; sourceName: string }; previewAssetId: AssetIdV2 | null });

export interface ArtboardRecordV2 {
  id: string;
  name: string;
  rect: RectV2;
  background: RGBV2 & { alpha: number };
  colorLabel: LayerCommonV2['colorLabel'];
}

export interface HistorySnapshotRecordV2 {
  id: string;
  path: string;
  activeLayerId: LayerIdV2 | null;
  revision: number;
}
export interface HistoryCommandRecordV2 { name: string; before: string; after: string }
export interface ProjectHistoryV2 {
  schemaVersion: 1;
  enabled: boolean;
  retainedByteLimit: number;
  cursor: number;
  commands: readonly HistoryCommandRecordV2[];
  snapshots: readonly HistorySnapshotRecordV2[];
}

export interface ProjectManifestV2 {
  format: 'fernwork-image';
  version: 2;
  id: string;
  name: string;
  width: number;
  height: number;
  resolution: number;
  colorSpace: 'srgb';
  activeLayerId: LayerIdV2 | null;
  layers: readonly LayerRecordV2[];
  artboards: readonly ArtboardRecordV2[];
  /** Ruler guides (optional; absent in files written before guides existed). */
  guides?: readonly { id: string; orientation: 'horizontal' | 'vertical'; position: number }[];
  assets: readonly AssetRecordV2[];
  fonts?: readonly DocumentFontRecordV2[];
  history?: ProjectHistoryV2;
  extensions?: Record<string, unknown>;
}

/** Additive host surface; the v1 `EditorHandle` remains source-compatible. */
export interface EditorHandleV2 extends EditorHandle {
  getManifestV2(): ProjectManifestV2;
}

export type EditorProfileId = 'pro' | 'lite';
export interface MountEditorOptionsV2 {
  host: HostAdapter;
  locale?: 'de' | 'en';
  theme?: 'dark' | 'light';
  profile?: EditorProfileId;
}
export type MountEditorV2 = (root: HTMLElement, options: MountEditorOptionsV2) => Promise<EditorHandleV2>;

/** Migration readers may use v1 affine matrices while reconstructing semantic transforms. */
export type LegacyMatrixV1 = Matrix2D;
