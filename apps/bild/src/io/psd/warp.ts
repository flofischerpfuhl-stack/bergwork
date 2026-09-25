/** ag-psd placed-layer warp bridge (SoLd/PlLd `warp` and `quiltWarp` descriptors). */

import type { Warp } from 'ag-psd';
import { apply, invert, unitToDocument, type LayerTransform } from '../../core/geometry';
import type { WarpMesh } from '../../core/model';

/** Serializes an editable Fernwork mesh as Photoshop's custom envelope/quilt warp. */
export function meshWarpToPsd(mesh: WarpMesh, transform: LayerTransform, sourceWidth: number, sourceHeight: number): Warp {
  if (!(sourceWidth > 0 && sourceHeight > 0)) throw new RangeError('PSD warp source size must be positive');
  const documentToUnit = invert(unitToDocument(transform));
  const meshPoints = mesh.points.map((point) => {
    const unit = apply(documentToUnit, point);
    return { x: unit.x * sourceWidth, y: unit.y * sourceHeight };
  });
  const customEnvelopeWarp: NonNullable<Warp['customEnvelopeWarp']> = { meshPoints };
  const quilt = mesh.splits.x > 1 || mesh.splits.y > 1;
  if (quilt) {
    customEnvelopeWarp.quiltSliceX = Array.from({ length: mesh.splits.x + 1 }, (_, index) => index * sourceWidth / mesh.splits.x);
    customEnvelopeWarp.quiltSliceY = Array.from({ length: mesh.splits.y + 1 }, (_, index) => index * sourceHeight / mesh.splits.y);
  }
  return {
    style: 'custom', value: 0, perspective: 0, perspectiveOther: 0, rotate: 'horizontal',
    bounds: {
      top: { value: 0, units: 'Pixels' }, left: { value: 0, units: 'Pixels' },
      bottom: { value: sourceHeight, units: 'Pixels' }, right: { value: sourceWidth, units: 'Pixels' },
    },
    uOrder: mesh.splits.x * 3 + 1, vOrder: mesh.splits.y * 3 + 1,
    ...(quilt ? { deformNumCols: mesh.splits.x, deformNumRows: mesh.splits.y } : {}), customEnvelopeWarp,
  };
}
