const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

/** Keeps a typed signature on one line whenever it fits the page. The font
 * size is never reduced; the frame grows around measured ink instead. */
export function typedSignatureFrame({ text, centerX, centerY, pageWidth, pageHeight, fontSize, measureText }) {
  const size = Math.max(1, finite(fontSize, 34));
  const widthLimit = Math.max(24, finite(pageWidth, 612) - 16);
  const heightLimit = Math.max(24, finite(pageHeight, 792) - 16);
  const paddingX = Math.max(16, size * 0.5);
  const paddingY = Math.max(10, size * 0.35);
  const measured = typeof measureText === 'function' ? measureText : value => String(value || '').length * size * 0.52;
  const naturalWidth = finite(measured(String(text || ''), size), 0);
  const w = Math.min(widthLimit, Math.max(220, naturalWidth + paddingX));
  const layout = layoutTextBlock({
    text: String(text || ''), width: Math.max(1, w - paddingX), height: heightLimit,
    fontSize: size, minFontSize: size, lineHeight: 1.2, overflow: 'visible', measureText: measured,
  });
  const h = Math.min(heightLimit, Math.max(48, layout.blockHeight + paddingY));
  return {
    x: Math.min(widthLimit + 8 - w, Math.max(8, finite(centerX, w / 2) - w / 2)),
    y: Math.min(heightLimit + 8 - h, Math.max(8, finite(centerY, h / 2) - h / 2)),
    w, h,
  };
}
import { layoutTextBlock } from './text-layout.js';
