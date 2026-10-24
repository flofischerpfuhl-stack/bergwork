// @ts-check

const RTL_RANGES = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/u;
const LTR_RANGES = /[A-Za-z\u00c0-\u02af\u0370-\u058f\u0900-\u1fff]/u;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, precision = 1000) {
  return Math.round(Number(value || 0) * precision) / precision;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function boundsUnion(items) {
  const left = Math.min(...items.map(item => item.bbox.x));
  const top = Math.min(...items.map(item => item.bbox.y));
  const right = Math.max(...items.map(item => item.bbox.x + item.bbox.w));
  const bottom = Math.max(...items.map(item => item.bbox.y + item.bbox.h));
  return Object.freeze({
    x: round(left),
    y: round(top),
    w: round(Math.max(0, right - left)),
    h: round(Math.max(0, bottom - top)),
  });
}

function rawBoundsFromBbox(bbox) {
  return {
    left: bbox.x,
    top: bbox.y,
    right: bbox.x + bbox.w,
    bottom: bbox.y + bbox.h,
  };
}

function extendRawBounds(bounds, bbox) {
  bounds.left = Math.min(bounds.left, bbox.x);
  bounds.top = Math.min(bounds.top, bbox.y);
  bounds.right = Math.max(bounds.right, bbox.x + bbox.w);
  bounds.bottom = Math.max(bounds.bottom, bbox.y + bbox.h);
}

function bboxFromRawBounds(bounds) {
  return Object.freeze({
    x: round(bounds.left),
    y: round(bounds.top),
    w: round(Math.max(0, bounds.right - bounds.left)),
    h: round(Math.max(0, bounds.bottom - bounds.top)),
  });
}

function sourceDirection(text) {
  for (const character of String(text || '')) {
    if (RTL_RANGES.test(character)) return 'rtl';
    if (LTR_RANGES.test(character)) return 'ltr';
  }
  return 'neutral';
}

function normalizedAngle(value) {
  let angle = Number(value || 0);
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle <= -Math.PI) angle += Math.PI * 2;
  return angle;
}

function angularDistance(left, right) {
  return Math.abs(normalizedAngle(left - right));
}

function writingModeForAngle(angle) {
  const normalized = Math.abs(normalizedAngle(angle));
  return Math.abs(normalized - Math.PI / 2) < Math.PI / 4
    ? 'vertical'
    : 'horizontal';
}

function styleSignature(item) {
  return [
    item.fontKey,
    item.pdfFontName,
    item.fontFamily,
    item.fontWeight,
    item.fontStyle,
    item.fillColor,
    round(item.fontSize, 100),
  ].join('|');
}

function axisMetrics(item) {
  const angle = item.angle;
  const inline = { x: Math.cos(angle), y: Math.sin(angle) };
  const block = { x: -inline.y, y: inline.x };
  const corners = [
    { x: item.bbox.x, y: item.bbox.y },
    { x: item.bbox.x + item.bbox.w, y: item.bbox.y },
    { x: item.bbox.x + item.bbox.w, y: item.bbox.y + item.bbox.h },
    { x: item.bbox.x, y: item.bbox.y + item.bbox.h },
  ];
  const along = corners.map(point => point.x * inline.x + point.y * inline.y);
  const across = corners.map(point => point.x * block.x + point.y * block.y);
  return Object.freeze({
    minInline: Math.min(...along),
    maxInline: Math.max(...along),
    centerInline: (Math.min(...along) + Math.max(...along)) / 2,
    minBlock: Math.min(...across),
    maxBlock: Math.max(...across),
    centerBlock: (Math.min(...across) + Math.max(...across)) / 2,
  });
}

function normalizeItem(raw, index) {
  const source = raw || {};
  const sourceBounds = source.bbox || source.rect || source;
  const bbox = {
    x: Number(sourceBounds.x),
    y: Number(sourceBounds.y),
    w: Number(sourceBounds.w),
    h: Number(sourceBounds.h),
  };
  if (
    !Object.values(bbox).every(Number.isFinite) ||
    !(bbox.w > 0) ||
    !(bbox.h > 0)
  ) {
    return null;
  }
  const text = String(source.text ?? source.str ?? '');
  if (!text.trim()) return null;
  const angle = normalizedAngle(source.angle);
  const item = {
    id: String(source.id ?? `item-${index + 1}`),
    sourceIndex: index,
    text,
    bbox: Object.freeze({
      x: round(bbox.x),
      y: round(bbox.y),
      w: round(bbox.w),
      h: round(bbox.h),
    }),
    angle,
    direction: source.direction || sourceDirection(text),
    writingMode: source.writingMode || writingModeForAngle(angle),
    fontSize: Number(source.fontSize || bbox.h || 12),
    fontKey: String(source.fontKey || ''),
    pdfFontName: String(source.pdfFontName || ''),
    fontFamily: String(source.fontFamily || ''),
    fontWeight: String(source.fontWeight || '400'),
    fontStyle: String(source.fontStyle || 'normal'),
    fillColor: String(source.fillColor || source.color || ''),
  };
  return Object.freeze({
    ...item,
    styleSignature: styleSignature(item),
    axis: axisMetrics(item),
  });
}

function compatibleLine(line, item, options) {
  if (line.writingMode !== item.writingMode) return false;
  if (angularDistance(line.angle, item.angle) > options.angleTolerance) return false;
  const typicalSize = Math.max(1, median([...line.items.map(entry => entry.fontSize), item.fontSize]));
  const baselineTolerance = Math.max(options.minimumBaselineTolerance, typicalSize * options.baselineTolerance);
  if (Math.abs(line.centerBlock - item.axis.centerBlock) > baselineTolerance) return false;
  const inlineGap = item.axis.minInline > line.maxInline
    ? item.axis.minInline - line.maxInline
    : line.minInline > item.axis.maxInline
      ? line.minInline - item.axis.maxInline
      : 0;
  return inlineGap <= typicalSize * options.maximumLineGap;
}

function lineSort(left, right) {
  if (left.writingMode !== right.writingMode) {
    return left.writingMode.localeCompare(right.writingMode);
  }
  const angle = left.angle - right.angle;
  if (Math.abs(angle) > 0.02) return angle;
  if (Math.abs(left.centerBlock - right.centerBlock) > 1) {
    return left.centerBlock - right.centerBlock;
  }
  return left.minInline - right.minInline;
}

function joinLineText(items, direction) {
  let text = '';
  let previous = null;
  for (const item of items) {
    if (previous) {
      const gap = direction === 'rtl'
        ? previous.axis.minInline - item.axis.maxInline
        : item.axis.minInline - previous.axis.maxInline;
      const typicalSize = Math.max(1, (previous.fontSize + item.fontSize) / 2);
      if (
        gap > typicalSize * 0.18 &&
        !/\s$/u.test(text) &&
        !/^\s/u.test(item.text)
      ) {
        text += ' ';
      }
    }
    text += item.text;
    previous = item;
  }
  return text;
}

function buildRuns(items) {
  const runs = [];
  let current = [];
  for (const item of items) {
    const previous = current.at(-1);
    const gap = previous
      ? Math.max(0, item.axis.minInline - previous.axis.maxInline)
      : 0;
    const maxJoinGap = Math.max(2, ((previous?.fontSize || item.fontSize) + item.fontSize) * 0.45);
    if (
      previous &&
      (previous.styleSignature !== item.styleSignature || gap > maxJoinGap)
    ) {
      runs.push(current);
      current = [];
    }
    current.push(item);
  }
  if (current.length) runs.push(current);
  return runs.map((entries, index) => Object.freeze({
    id: `run-${hashString(entries.map(item => item.id).join('|'))}`,
    index,
    itemIds: Object.freeze(entries.map(item => item.id)),
    text: joinLineText(entries, entries.find(item => item.direction !== 'neutral')?.direction || 'ltr'),
    bbox: boundsUnion(entries),
    style: Object.freeze({
      fontKey: entries[0].fontKey,
      pdfFontName: entries[0].pdfFontName,
      fontFamily: entries[0].fontFamily,
      fontSize: round(median(entries.map(item => item.fontSize))),
      fontWeight: entries[0].fontWeight,
      fontStyle: entries[0].fontStyle,
      fillColor: entries[0].fillColor,
    }),
  }));
}

function buildLines(items, options) {
  const seeds = [...items].sort((left, right) => {
    if (left.writingMode !== right.writingMode) {
      return left.writingMode.localeCompare(right.writingMode);
    }
    if (Math.abs(left.axis.centerBlock - right.axis.centerBlock) > 1) {
      return left.axis.centerBlock - right.axis.centerBlock;
    }
    return left.axis.minInline - right.axis.minInline;
  });
  const lines = [];
  for (const item of seeds) {
    const candidates = lines
      .filter(line => compatibleLine(line, item, options))
      .sort((left, right) =>
        Math.abs(left.centerBlock - item.axis.centerBlock) -
        Math.abs(right.centerBlock - item.axis.centerBlock));
    const line = candidates[0];
    if (line) {
      line.items.push(item);
      line.centerBlock = median(line.items.map(entry => entry.axis.centerBlock));
      line.minInline = Math.min(line.minInline, item.axis.minInline);
      line.maxInline = Math.max(line.maxInline, item.axis.maxInline);
      continue;
    }
    lines.push({
      items: [item],
      angle: item.angle,
      writingMode: item.writingMode,
      centerBlock: item.axis.centerBlock,
      minInline: item.axis.minInline,
      maxInline: item.axis.maxInline,
    });
  }
  return lines
    .sort(lineSort)
    .map((line, index) => {
      const directions = line.items.map(item => item.direction).filter(value => value !== 'neutral');
      const rtl = directions.filter(value => value === 'rtl').length;
      const direction = rtl > directions.length / 2 ? 'rtl' : 'ltr';
      const ordered = [...line.items].sort((left, right) =>
        direction === 'rtl'
          ? right.axis.minInline - left.axis.minInline
          : left.axis.minInline - right.axis.minInline);
      const bbox = boundsUnion(ordered);
      const baselineSpread = Math.max(...ordered.map(item => item.axis.centerBlock)) -
        Math.min(...ordered.map(item => item.axis.centerBlock));
      const fontSize = median(ordered.map(item => item.fontSize));
      return Object.freeze({
        id: `line-${hashString(ordered.map(item => item.id).join('|'))}`,
        index,
        itemIds: Object.freeze(ordered.map(item => item.id)),
        text: joinLineText(ordered, direction),
        bbox,
        angle: round(median(ordered.map(item => item.angle))),
        direction,
        writingMode: line.writingMode,
        fontSize: round(fontSize),
        baselineSpread: round(baselineSpread),
        baselineConfidence: round(1 - clamp(baselineSpread / Math.max(1, fontSize), 0, 1)),
        runs: Object.freeze(buildRuns(ordered)),
      });
    });
}

function horizontalOverlap(left, right) {
  const overlap = Math.max(
    0,
    Math.min(left.bbox.x + left.bbox.w, right.bbox.x + right.bbox.w) -
      Math.max(left.bbox.x, right.bbox.x),
  );
  return overlap / Math.max(1, Math.min(left.bbox.w, right.bbox.w));
}

function buildColumns(lines, options) {
  const columns = [];
  const sorted = [...lines].sort((left, right) =>
    left.bbox.x - right.bbox.x || left.bbox.y - right.bbox.y);
  for (const line of sorted) {
    if (line.writingMode !== 'horizontal') {
      columns.push({
        lines: [line],
        bbox: line.bbox,
        rawBounds: rawBoundsFromBbox(line.bbox),
        writingMode: line.writingMode,
      });
      continue;
    }
    const candidate = columns
      .filter(column => column.writingMode === line.writingMode)
      .map(column => ({
        column,
        overlap: horizontalOverlap(column, line),
        leftDelta: Math.abs(column.bbox.x - line.bbox.x),
      }))
      .filter(match =>
        match.overlap >= options.columnOverlap ||
        match.leftDelta <= Math.max(4, line.fontSize * options.columnLeftTolerance))
      .sort((left, right) => right.overlap - left.overlap || left.leftDelta - right.leftDelta)[0];
    if (!candidate) {
      columns.push({
        lines: [line],
        bbox: line.bbox,
        rawBounds: rawBoundsFromBbox(line.bbox),
        writingMode: line.writingMode,
      });
      continue;
    }
    candidate.column.lines.push(line);
    extendRawBounds(candidate.column.rawBounds, line.bbox);
    candidate.column.bbox = bboxFromRawBounds(candidate.column.rawBounds);
  }
  return columns
    .sort((left, right) => left.bbox.x - right.bbox.x || left.bbox.y - right.bbox.y)
    .map((column, index) => {
      const { rawBounds, ...result } = column;
      return {
        ...result,
        index,
        lines: column.lines.sort((left, right) =>
          left.bbox.y - right.bbox.y || left.bbox.x - right.bbox.x),
      };
    });
}

function buildParagraphs(columns, options) {
  const paragraphs = [];
  for (const column of columns) {
    let current = [];
    for (const line of column.lines) {
      const previous = current.at(-1);
      const gap = previous
        ? line.bbox.y - (previous.bbox.y + previous.bbox.h)
        : 0;
      const typicalHeight = previous
        ? median([previous.bbox.h, line.bbox.h, previous.fontSize, line.fontSize])
        : line.bbox.h;
      const indent = previous ? Math.abs(line.bbox.x - previous.bbox.x) : 0;
      const directionChanged = previous && previous.direction !== line.direction;
      const shouldSplit = previous && (
        gap > typicalHeight * options.paragraphGap ||
        indent > typicalHeight * options.paragraphIndent ||
        directionChanged ||
        previous.writingMode !== line.writingMode
      );
      if (shouldSplit) {
        paragraphs.push({ columnIndex: column.index, lines: current });
        current = [];
      }
      current.push(line);
    }
    if (current.length) paragraphs.push({ columnIndex: column.index, lines: current });
  }
  return paragraphs;
}

function confidenceForParagraph(paragraph, columns) {
  const lines = paragraph.lines;
  const baseline = median(lines.map(line => line.baselineConfidence));
  const gaps = lines.slice(1).map((line, index) =>
    line.bbox.y - (lines[index].bbox.y + lines[index].bbox.h));
  const typical = median(lines.map(line => Math.max(line.fontSize, line.bbox.h)));
  const gapVariance = gaps.length > 1
    ? median(gaps.map(gap => Math.abs(gap - median(gaps)))) / Math.max(1, typical)
    : 0;
  const lineSpacing = 1 - clamp(gapVariance, 0, 1);
  const directionConsistency = new Set(lines.map(line => line.direction)).size === 1 ? 1 : 0.55;
  const columnAmbiguity = columns.length > 1 &&
    columns.some((column, index) =>
      index !== paragraph.columnIndex &&
      horizontalOverlap(
        { bbox: paragraph.bbox },
        column,
      ) > 0.5)
    ? 0.65
    : 1;
  const score = baseline * 0.35 + lineSpacing * 0.30 +
    directionConsistency * 0.20 + columnAmbiguity * 0.15;
  return Object.freeze({
    score: round(score),
    level: score >= 0.86 ? 'high' : score >= 0.68 ? 'medium' : 'low',
    factors: Object.freeze({
      baseline: round(baseline),
      lineSpacing: round(lineSpacing),
      directionConsistency: round(directionConsistency),
      columnAmbiguity: round(columnAmbiguity),
    }),
  });
}

function blockFromLines(lines, {
  idPrefix = 'text-block',
  columnIndex = 0,
  columns = [],
  correction = null,
} = {}) {
  const bbox = boundsUnion(lines.map(line => ({ bbox: line.bbox })));
  const direction = lines.filter(line => line.direction === 'rtl').length > lines.length / 2
    ? 'rtl'
    : 'ltr';
  const itemIds = lines.flatMap(line => line.itemIds);
  const confidence = confidenceForParagraph({ lines, columnIndex, bbox }, columns);
  return Object.freeze({
    id: `${idPrefix}-${hashString(itemIds.join('|'))}`,
    columnIndex,
    itemIds: Object.freeze(itemIds),
    lineIds: Object.freeze(lines.map(line => line.id)),
    text: lines.map(line => line.text).join('\n'),
    bbox,
    direction,
    writingMode: lines[0]?.writingMode || 'horizontal',
    lines: Object.freeze(lines),
    runs: Object.freeze(lines.flatMap(line => line.runs)),
    confidence,
    alternatives: Object.freeze(lines.length > 1
      ? [{
          kind: 'split-lines',
          boundaries: Object.freeze(lines.slice(0, -1).map(line => line.id)),
          reason: 'Manual line-level correction if automatic paragraph grouping is wrong.',
        }]
      : []),
    correction,
  });
}

/**
 * Deterministically detects semantic runs, lines, paragraphs and text blocks
 * from PDF text extraction geometry. The result is advisory: confidence and
 * alternatives are retained so the editor never silently treats a heuristic
 * grouping as authoritative.
 */
export function detectSemanticTextBlocks(rawItems, inputOptions = {}) {
  const options = Object.freeze({
    angleTolerance: Number(inputOptions.angleTolerance ?? 0.045),
    baselineTolerance: Number(inputOptions.baselineTolerance ?? 0.42),
    minimumBaselineTolerance: Number(inputOptions.minimumBaselineTolerance ?? 2),
    columnOverlap: Number(inputOptions.columnOverlap ?? 0.18),
    columnLeftTolerance: Number(inputOptions.columnLeftTolerance ?? 1.4),
    paragraphGap: Number(inputOptions.paragraphGap ?? 1.35),
    paragraphIndent: Number(inputOptions.paragraphIndent ?? 2.2),
    maximumLineGap: Number(inputOptions.maximumLineGap ?? 6),
  });
  const items = Object.freeze((rawItems || [])
    .map(normalizeItem)
    .filter(Boolean));
  if (!items.length) {
    return Object.freeze({
      version: 1,
      items,
      lines: Object.freeze([]),
      paragraphs: Object.freeze([]),
      blocks: Object.freeze([]),
      columns: Object.freeze([]),
    });
  }
  const lines = Object.freeze(buildLines(items, options));
  const columns = buildColumns(lines, options);
  const paragraphSeeds = buildParagraphs(columns, options);
  const blocks = Object.freeze(paragraphSeeds.map(seed =>
    blockFromLines(seed.lines, {
      columnIndex: seed.columnIndex,
      columns,
    })));
  const paragraphs = Object.freeze(blocks.map(block => Object.freeze({
    id: `paragraph-${block.id.slice('text-block-'.length)}`,
    blockId: block.id,
    lineIds: block.lineIds,
    text: block.text,
    bbox: block.bbox,
    confidence: block.confidence,
  })));
  return Object.freeze({
    version: 1,
    items,
    lines,
    paragraphs,
    blocks,
    columns: Object.freeze(columns.map(column => Object.freeze({
      index: column.index,
      bbox: column.bbox,
      lineIds: Object.freeze(column.lines.map(line => line.id)),
    }))),
  });
}

/**
 * Applies an explicit user split while preserving the detector provenance.
 */
export function splitSemanticTextBlock(block, afterLineId) {
  const index = block?.lines?.findIndex(line => line.id === afterLineId) ?? -1;
  if (index < 0 || index >= block.lines.length - 1) {
    throw new TypeError('Split correction requires a non-terminal line ID from the block.');
  }
  const correction = Object.freeze({
    kind: 'manual-split',
    sourceBlockIds: Object.freeze([block.id]),
    boundaryLineId: afterLineId,
  });
  return Object.freeze([
    blockFromLines(block.lines.slice(0, index + 1), {
      idPrefix: 'corrected-text-block',
      columnIndex: block.columnIndex,
      correction,
    }),
    blockFromLines(block.lines.slice(index + 1), {
      idPrefix: 'corrected-text-block',
      columnIndex: block.columnIndex,
      correction,
    }),
  ]);
}

/**
 * Applies an explicit user merge. Blocks must share writing mode and direction;
 * the original block IDs are retained as correction provenance.
 */
export function mergeSemanticTextBlocks(blocks) {
  if (!Array.isArray(blocks) || blocks.length < 2) {
    throw new TypeError('Merge correction requires at least two blocks.');
  }
  const writingModes = new Set(blocks.map(block => block.writingMode));
  const directions = new Set(blocks.map(block => block.direction));
  if (writingModes.size !== 1 || directions.size !== 1) {
    throw new TypeError('Only blocks with a common writing mode and direction can be merged.');
  }
  const lines = blocks
    .flatMap(block => block.lines)
    .sort((left, right) => left.bbox.y - right.bbox.y || left.bbox.x - right.bbox.x);
  return blockFromLines(lines, {
    idPrefix: 'corrected-text-block',
    columnIndex: Math.min(...blocks.map(block => block.columnIndex || 0)),
    correction: Object.freeze({
      kind: 'manual-merge',
      sourceBlockIds: Object.freeze(blocks.map(block => block.id)),
    }),
  });
}

/**
 * Replays stable split/merge corrections over a fresh detection result.
 */
export function applyTextBlockCorrections(blocks, corrections = []) {
  let current = [...blocks];
  for (const correction of corrections) {
    if (correction?.kind === 'split') {
      const index = current.findIndex(block => block.id === correction.blockId);
      if (index < 0) continue;
      const split = splitSemanticTextBlock(current[index], correction.afterLineId);
      current.splice(index, 1, ...split);
    } else if (correction?.kind === 'merge') {
      const selected = correction.blockIds
        ?.map(id => current.find(block => block.id === id))
        .filter(Boolean);
      if (!selected || selected.length < 2) continue;
      const merged = mergeSemanticTextBlocks(selected);
      const ids = new Set(selected.map(block => block.id));
      const firstIndex = current.findIndex(block => ids.has(block.id));
      current = current.filter(block => !ids.has(block.id));
      current.splice(firstIndex, 0, merged);
    }
  }
  return Object.freeze(current);
}
