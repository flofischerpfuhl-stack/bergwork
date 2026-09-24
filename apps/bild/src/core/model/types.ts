import type { LayerTransform, Point, Rect } from '../geometry';
import type { Raster } from '../raster';
import type { DocumentSelection } from '../selection';

/** All 27 Photoshop blend modes in its menu-group order (A8). */
export type BlendMode =
  | 'normal' | 'dissolve'
  | 'darken' | 'multiply' | 'colorBurn' | 'linearBurn' | 'darkerColor'
  | 'lighten' | 'screen' | 'colorDodge' | 'linearDodge' | 'lighterColor'
  | 'overlay' | 'softLight' | 'hardLight' | 'vividLight' | 'linearLight' | 'pinLight' | 'hardMix'
  | 'difference' | 'exclusion' | 'subtract' | 'divide'
  | 'hue' | 'saturation' | 'color' | 'luminosity';

export type AdjustmentKind = 'Hue/Saturation' | 'Levels' | 'Curves' | 'Exposure' | 'Gradient Map' | 'Grain';
export type ColorLabel = 'none' | 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'violet' | 'gray';

export interface RGB { readonly red: number; readonly green: number; readonly blue: number }
export type LevelsChannel = 'RGB' | 'Red' | 'Green' | 'Blue';
export type ColorRange = 'Master' | 'Reds' | 'Yellows' | 'Greens' | 'Cyans' | 'Blues' | 'Magentas';
export interface RangeAdjustment { readonly hue: number; readonly saturation: number; readonly lightness: number }
export interface HueBand {
  readonly falloffStart: number; readonly rangeStart: number; readonly rangeEnd: number; readonly falloffEnd: number;
}
export interface HueSaturationSettings {
  readonly range: ColorRange; readonly colorize: boolean; readonly invertRange: boolean;
  readonly adjustments: Partial<Record<ColorRange, RangeAdjustment>>;
  readonly bands: Partial<Record<ColorRange, HueBand>>;
}
export interface LevelRange {
  readonly black: number; readonly gamma: number; readonly white: number;
  readonly outputBlack: number; readonly outputWhite: number;
}
export interface LevelsSettings { readonly channel: LevelsChannel; readonly ranges: readonly LevelRange[] }
export interface CurvePoint { readonly x: number; readonly y: number }
export interface CurvesSettings { readonly channel: LevelsChannel; readonly channels: readonly (readonly CurvePoint[])[] }
export interface ExposureSettings { readonly exposure: number; readonly offset: number; readonly gamma: number }
export interface GradientMapSettings { readonly shadows: RGB; readonly highlights: RGB; readonly reversed: boolean }
export interface GrainSettings { readonly amount: number; readonly size: number; readonly roughness: number; readonly seed: number }

/** Strict live adjustment shape. Optional fields are the backward-compatible Codable defaults. */
export interface LayerAdjustment {
  readonly [key: string]: AdjustmentKind | 1 | number | boolean | HueSaturationSettings | LevelsSettings
    | CurvesSettings | ExposureSettings | GradientMapSettings | GrainSettings | undefined;
  readonly schemaVersion?: 1;
  readonly kind: AdjustmentKind;
  readonly hue?: number;
  readonly saturation?: number;
  readonly lightness?: number;
  readonly colorize?: boolean;
  readonly hsvSettings?: HueSaturationSettings;
  readonly levels?: LevelsSettings;
  readonly curves?: CurvesSettings;
  readonly exposureSettings?: ExposureSettings;
  readonly gradientMapSettings?: GradientMapSettings;
  readonly grainSettings?: GrainSettings;
}

export interface LayerShape {
  readonly kind?: 'Rectangle' | 'Ellipse';
  readonly red?: number;
  readonly green?: number;
  readonly blue?: number;
  readonly cornerRadius?: number;
}

export interface LayerLocks {
  readonly transparency: boolean;
  readonly pixels: boolean;
  readonly position: boolean;
  readonly all: boolean;
}

export interface LayerMask {
  readonly raster: Raster;
  readonly enabled: boolean;
  readonly placement: LayerTransform | null;
  readonly linked: boolean;
}

export interface VectorPath {
  readonly closed: boolean;
  readonly points: readonly {
    readonly anchor: Point;
    readonly in: Point;
    readonly out: Point;
  }[];
}
export interface VectorMask { readonly enabled: boolean; readonly inverted: boolean; readonly paths: readonly VectorPath[] }
export interface CropParameters { readonly rect: Rect; readonly feather: number }
export interface WarpQuad { readonly kind: 'quad'; readonly schemaVersion: 1; readonly corners: readonly [Point, Point, Point, Point] }

export type LayerEffect =
  | { readonly kind: 'dropShadow'; readonly schemaVersion: 1; readonly enabled: boolean; readonly opacity: number;
      readonly angle: number; readonly distance: number; readonly blur: number; readonly color: RGB }
  | { readonly kind: 'stroke'; readonly schemaVersion: 1; readonly enabled: boolean; readonly width: number;
      readonly position: 'inside' | 'center' | 'outside'; readonly color: RGB }
  | { readonly kind: 'colorOverlay'; readonly schemaVersion: 1; readonly enabled: boolean; readonly opacity: number; readonly color: RGB };

export type LiveFilter =
  | { readonly kind: 'gaussianBlur'; readonly schemaVersion: 1; readonly enabled: boolean; readonly radius: number }
  | { readonly kind: 'motionBlur'; readonly schemaVersion: 1; readonly enabled: boolean; readonly angle: number; readonly distance: number }
  | { readonly kind: 'noise'; readonly schemaVersion: 1; readonly enabled: boolean; readonly amount: number;
      readonly gaussian: boolean; readonly monochromatic: boolean }
  | { readonly kind: 'lensCorrection'; readonly schemaVersion: 1; readonly enabled: boolean; readonly distortion: number };

export interface LayerCommon {
  readonly id: string;
  readonly name: string;
  readonly visible: boolean;
  readonly locked: boolean;
  readonly parentId: string | null;
  readonly isGroup: boolean;
  readonly opacity: number;
  readonly fillOpacity: number;
  readonly blendMode: BlendMode;
  readonly locks: LayerLocks;
  readonly colorLabel: ColorLabel;
  readonly transform: LayerTransform;
  readonly warp: WarpQuad | null;
  readonly crop: CropParameters | null;
  readonly raster: Raster | null;
  readonly mask: LayerMask | null;
  readonly vectorMask: VectorMask | null;
  readonly maskSourceId: string | null;
  readonly effects: readonly LayerEffect[];
  readonly filters: readonly LiveFilter[];
  /** Compatibility projections used by the existing renderer/tool engine. */
  readonly adjustment: LayerAdjustment | null;
  readonly shape: LayerShape | null;
}

export interface PixelLayer extends LayerCommon { readonly kind: 'pixel'; readonly isGroup: false }
export interface GroupLayer extends LayerCommon { readonly kind: 'group'; readonly isGroup: true }
export interface AdjustmentLayer extends LayerCommon { readonly kind: 'adjustment'; readonly isGroup: false; readonly adjustment: LayerAdjustment }
export type FillParameters =
  | { readonly kind: 'solid'; readonly schemaVersion: 1; readonly color: RGB }
  | { readonly kind: 'gradient'; readonly schemaVersion: 1; readonly angle: number; readonly stops: readonly { offset: number; color: RGB; opacity: number }[] }
  | { readonly kind: 'pattern'; readonly schemaVersion: 1; readonly assetId: string; readonly scale: number; readonly angle: number };
export interface FillLayer extends LayerCommon { readonly kind: 'fill'; readonly isGroup: false; readonly fill: FillParameters }
export interface VectorStyle {
  readonly fill: FillParameters | null;
  readonly stroke: { readonly color: RGB; readonly width: number; readonly alignment: 'inside' | 'center' | 'outside' } | null;
}
export interface VectorLayer extends LayerCommon { readonly kind: 'vector'; readonly isGroup: false; readonly paths: readonly VectorPath[]; readonly style: VectorStyle }
export interface TextRun { readonly from: number; readonly to: number; readonly fontFamily: string; readonly fontSize: number; readonly color: RGB }
export interface TextLayer extends LayerCommon {
  readonly kind: 'text'; readonly isGroup: false; readonly text: string; readonly runs: readonly TextRun[];
  readonly box: { readonly width: number; readonly height: number } | null;
  readonly alignment: 'left' | 'center' | 'right' | 'justify';
}
export interface EmbeddedLayer extends LayerCommon {
  readonly kind: 'embedded'; readonly isGroup: false;
  readonly content: { readonly mode: 'embedded' | 'linked'; readonly mediaType: 'image' | 'svg' | 'pdf' | 'project';
    readonly assetId?: string; readonly uri?: string; readonly sourceName: string };
}

export type ModelLayer = PixelLayer | GroupLayer | AdjustmentLayer | FillLayer | VectorLayer | TextLayer | EmbeddedLayer;

/**
 * Source-compatible input shape for v1 callers. Persistence normalises this to `ModelLayer`.
 * New documents and all public factories always produce a discriminated `ModelLayer`.
 */
export interface LegacyLayer {
  readonly kind?: ModelLayer['kind'];
  readonly id: string;
  readonly name: string;
  readonly visible: boolean;
  readonly locked: boolean;
  readonly parentId: string | null;
  readonly isGroup: boolean;
  readonly opacity: number;
  readonly fillOpacity?: number;
  readonly blendMode: BlendMode;
  readonly locks?: LayerLocks;
  readonly colorLabel?: ColorLabel;
  readonly transform: LayerTransform;
  readonly warp?: WarpQuad | null;
  readonly crop?: CropParameters | null;
  readonly raster: Raster | null;
  readonly mask: LayerMask | null;
  readonly vectorMask?: VectorMask | null;
  readonly maskSourceId: string | null;
  readonly effects?: readonly LayerEffect[];
  readonly filters?: readonly LiveFilter[];
  readonly adjustment: LayerAdjustment | null;
  readonly shape: LayerShape | null;
}

export type Layer = ModelLayer | LegacyLayer;

export interface Guide { readonly id: string; readonly orientation: 'horizontal' | 'vertical'; readonly position: number }

export interface Artboard {
  readonly id: string;
  readonly name: string;
  readonly rect: Rect;
  readonly background: RGB & { readonly alpha: number };
  readonly colorLabel: ColorLabel;
}

export interface DocumentResource {
  readonly id: string;
  readonly role: 'pattern' | 'embedded';
  readonly mime: string;
  readonly bytes: Uint8Array;
}

export interface CanvasDocument {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly resolution: number;
  readonly layers: readonly Layer[];
  readonly artboards?: readonly Artboard[];
  /** Ruler guides in document pixels (PRODUCT-PLAN 6.1). */
  readonly guides?: readonly Guide[];
  readonly resources?: readonly DocumentResource[];
  readonly selection: DocumentSelection | null;
}

export type { Point };
