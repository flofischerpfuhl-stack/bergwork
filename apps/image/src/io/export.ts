/**
 * JPEG export settings remembered by the editor (UI/JPEGExportSheet.swift): quality and the matte
 * colour under transparent pixels. Encoding itself is the single export pipeline in
 * `./exportPipeline` (PRODUCT-PLAN P4: one way per task); exports never mark the project saved.
 */

export interface JpegOptions { quality: number; red: number; green: number; blue: number }
export const DEFAULT_JPEG: JpegOptions = { quality: 0.85, red: 1, green: 1, blue: 1 };
