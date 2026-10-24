export const MAX_PAGE_GUIDES = 64;
export const GUIDE_UNITS = Object.freeze({ pt: 1, mm: 72 / 25.4, in: 72 });
export const EMPTY_GUIDES = Object.freeze([]);

const rotation = page => ((Number(page?.rotation || 0) % 360) + 360) % 360;
const validPage = page => [page?.width, page?.height].every(value => Number.isFinite(value) && value > 0);

/** Guides are project/editor state, never PDF page content. Store them in the
 * unrotated page's top-left coordinate system, like other editor geometry. */
export function normalizePageGuides(value, page = null) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.slice(0, MAX_PAGE_GUIDES).flatMap(guide => {
    const id = typeof guide?.id === 'string' ? guide.id : '';
    const axis = guide?.axis;
    const position = guide?.position;
    const limit = validPage(page) ? page[axis === 'x' ? 'width' : 'height'] : 1e7;
    if (!id || id.length > 128 || seen.has(id) || !['x', 'y'].includes(axis) ||
        !Number.isFinite(position) || position < 0 || position > limit) return [];
    seen.add(id);
    return [{ id, axis, position }];
  });
}

export function normalizeLayoutGuides(value, pages = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const byId = Array.isArray(pages) ? new Map(pages.map(page => [page.id, page])) : null;
  return Object.fromEntries(Object.entries(value).slice(0, 4096).flatMap(([pageId, guides]) => {
    if (!pageId || pageId.length > 256 || (byId && !byId.has(pageId))) return [];
    const normalized = normalizePageGuides(guides, byId?.get(pageId));
    return normalized.length ? [[pageId, normalized]] : [];
  }));
}

export function displayPageGuides(guides, page) {
  if (!validPage(page) || ![0, 90, 180, 270].includes(rotation(page))) return [];
  return normalizePageGuides(guides, page).map(guide => {
    const { axis, position } = guide;
    switch (rotation(page)) {
      case 90: return { ...guide, axis: axis === 'x' ? 'y' : 'x', position: axis === 'x' ? position : page.height - position };
      case 180: return { ...guide, position: page[axis === 'x' ? 'width' : 'height'] - position };
      case 270: return { ...guide, axis: axis === 'x' ? 'y' : 'x', position: axis === 'x' ? page.width - position : position };
      default: return guide;
    }
  });
}

export function sourceGuideForDisplay(guide, page) {
  if (!validPage(page)) return null;
  const quarter = rotation(page) % 180 !== 0;
  const inversePage = { width: quarter ? page.height : page.width, height: quarter ? page.width : page.height,
    rotation: -rotation(page) };
  return displayPageGuides([guide], inversePage)[0] || null;
}

/** Screen-density bounded ruler ticks, in explicit physical units. */
export function rulerTicks(lengthPt, zoom, unit = 'pt') {
  const factor = GUIDE_UNITS[unit];
  if (!(lengthPt > 0) || !(zoom > 0) || !Number.isFinite(lengthPt * zoom) || !factor) return [];
  const required = Math.max(48 / (zoom * factor), lengthPt / (factor * 200));
  const magnitude = 10 ** Math.floor(Math.log10(required));
  const major = [1, 2, 5, 10].map(value => value * magnitude).find(value => value >= required);
  const step = major * factor / 5;
  const count = Math.min(1001, Math.floor(lengthPt / step) + 1);
  return Array.from({ length: count }, (_, index) => ({
    position: index * step,
    major: index % 5 === 0,
    label: index % 5 === 0 ? String(Number((index * step / factor).toPrecision(8))) : '',
  }));
}
