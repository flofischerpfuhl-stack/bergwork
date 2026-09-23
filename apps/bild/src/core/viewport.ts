/**
 * Canvas viewport, ported from Rendering/CanvasViewport.swift.
 * Document: pixels with top-left origin. View: CSS pixels (AppKit points). Zoom 1 means actual
 * device pixels, so `pointsPerPixel = zoom / devicePixelRatio`.
 */

import type { Point, Rect, Size } from './geometry';

export const ZOOM_MIN = 0.001;
export const ZOOM_MAX = 32;

export class CanvasViewport {
  viewSize: Size = { width: 0, height: 0 };
  backingScale = 1;
  zoom = 1;
  pan: Point = { x: 0, y: 0 };
  followsFit = true;
  /** Space kept free around a fitted canvas (96 points upstream; less on small screens). */
  fitMargin = 96;

  clone(): CanvasViewport {
    const copy = new CanvasViewport();
    Object.assign(copy, this, { viewSize: { ...this.viewSize }, pan: { ...this.pan } });
    return copy;
  }

  get pointsPerPixel(): number { return this.zoom / this.backingScale; }
  get center(): Point { return { x: this.viewSize.width / 2, y: this.viewSize.height / 2 }; }

  documentRect(size: Size): Rect {
    const w = size.width * this.pointsPerPixel, h = size.height * this.pointsPerPixel;
    return { x: this.center.x - w / 2 + this.pan.x, y: this.center.y - h / 2 + this.pan.y, width: w, height: h };
  }

  documentPoint(point: Point, size: Size): Point {
    const origin = this.documentRect(size);
    return { x: (point.x - origin.x) / this.pointsPerPixel, y: (point.y - origin.y) / this.pointsPerPixel };
  }

  viewPoint(point: Point, size: Size): Point {
    const origin = this.documentRect(size);
    return { x: origin.x + point.x * this.pointsPerPixel, y: origin.y + point.y * this.pointsPerPixel };
  }

  fit(size: Size): void {
    if (this.viewSize.width <= 0 || this.viewSize.height <= 0) { this.followsFit = true; return; }
    const margin = Math.min(this.fitMargin, Math.min(this.viewSize.width, this.viewSize.height) * 0.12);
    this.zoom = clampZoom(Math.min(Math.max(1, this.viewSize.width - margin) / size.width,
      Math.max(1, this.viewSize.height - margin) / size.height) * this.backingScale);
    this.pan = { x: 0, y: 0 };
    this.followsFit = true;
  }

  resize(size: Size, backingScale: number, documentSize: Size | null): void {
    const oldScale = this.pointsPerPixel;
    this.viewSize = size;
    this.backingScale = Math.max(1, backingScale);
    if (this.followsFit && documentSize) this.fit(documentSize);
    else {
      const ratio = this.pointsPerPixel / oldScale;
      this.pan = { x: this.pan.x * ratio, y: this.pan.y * ratio };
    }
  }

  setZoom(value: number, anchor: Point, documentSize: Size): void {
    if (!Number.isFinite(value)) return;
    const pixel = this.documentPoint(anchor, documentSize);
    this.zoom = clampZoom(value);
    const moved = this.viewPoint(pixel, documentSize);
    this.pan = { x: this.pan.x + anchor.x - moved.x, y: this.pan.y + anchor.y - moved.y };
    this.followsFit = false;
  }

  translate(dx: number, dy: number): void {
    this.pan = { x: this.pan.x + dx, y: this.pan.y + dy };
    this.followsFit = false;
  }
}

export function clampZoom(value: number): number { return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value)); }
