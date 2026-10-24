/** Shared host/project boundary. Both lanes implement this exact contract. */
export type Matrix2D = readonly [number, number, number, number, number, number];
export type AssetId = string;
export type LayerId = string;
export interface AssetRecord {
  id: AssetId;
  path: string; // relative ZIP member; reject traversal/absolute paths on import
  mime: string;
  width: number;
  height: number;
  sha256: string;
}
export interface MaskRecord {
  assetId: AssetId;
  transform: Matrix2D;
  linked: boolean;
  enabled: boolean;
}
export interface LayerRecord {
  id: LayerId;
  parentId: LayerId | null;
  name: string;
  kind: 'raster' | 'group' | 'adjustment' | 'shape';
  visible: boolean;
  locked: boolean;
  opacity: number; // 0..1
  blendMode: string; // canonical upstream case name, not renderer constants
  transform: Matrix2D;
  assetId?: AssetId;
  warpQuad?: readonly [number, number, number, number, number, number, number, number];
  mask?: MaskRecord;
  clippedToBelow: boolean;
  parameters: Record<string, unknown>; // canonical upstream names/units, JSON only
}
export interface ProjectManifestV1 {
  format: 'fernwork-compositor';
  version: 1;
  id: string;
  name: string;
  width: number;
  height: number;
  colorSpace: 'srgb';
  layers: LayerRecord[]; // sibling order bottom-to-top
  assets: AssetRecord[];
  extensions?: Record<string, unknown>;
}
export interface HostAdapter {
  chooseImages(): Promise<File[]>;
  chooseProject(): Promise<Blob | null>;
  saveFile(blob: Blob, suggestedName: string): Promise<void>;
  reportError(error: { code: string; message: string }): void;
}
export interface EditorHandle {
  newProject(options: { name: string; width: number; height: number }): Promise<void>;
  importImage(file: Blob, name: string): Promise<LayerId>;
  openProject(archive: Blob): Promise<void>;
  saveProject(): Promise<Blob>;
  exportImage(options: { format: 'png' | 'jpeg'; quality?: number }): Promise<Blob>;
  getManifest(): ProjectManifestV1;
  undo(): Promise<boolean>;
  redo(): Promise<boolean>;
  destroy(): void;
}
export type MountEditor = (
  root: HTMLElement,
  options: { host: HostAdapter; locale?: 'de' | 'en'; theme?: 'dark' | 'light' },
) => Promise<EditorHandle>;
