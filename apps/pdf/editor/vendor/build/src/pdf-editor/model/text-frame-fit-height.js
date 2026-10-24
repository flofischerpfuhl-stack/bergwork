const positiveFinite = value => Number.isFinite(Number(value)) && Number(value) > 0;

/**
 * Return the exact native block height needed to reveal vertical text overflow.
 * Missing metadata means the frame's manual height remains authoritative.
 */
export function fittedTextFrameHeight(item = {}, nativeDescriptor = null) {
  const frame = nativeDescriptor?.textFrame === true
    ? nativeDescriptor
    : item?.textFrame === true
      ? item
      : null;
  const block = frame?.block;
  if (!block || !positiveFinite(block.height) || !positiveFinite(block.contentHeight)) return null;
  const height = Number(block.height);
  const contentHeight = Number(block.contentHeight);
  return contentHeight > height + 0.001 ? contentHeight : null;
}
