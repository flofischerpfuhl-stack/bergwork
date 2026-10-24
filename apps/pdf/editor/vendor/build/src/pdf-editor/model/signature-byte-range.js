// Whether PDF bytes still carry a signature whose /ByteRange matches them.
// Such bytes must never be rewritten: the signature covers exact offsets.
// A signature is intact when its excluded hole is exactly its hex /Contents
// string and its covered range ends at an end-of-file marker (the end of the
// signed revision). Bytes written from scratch by PDFium or pdf-lib keep the
// old /ByteRange numbers, which then no longer line up, so a hybrid form with
// an already broken usage-rights signature (IRS 1040) can still be repacked.
// Signature dictionaries are never inside object streams (the hole must be
// addressable by byte offset), so a plain byte scan finds them.
export function pdfBytesHaveIntactSignature(bytes) {
  if (!bytes?.byteLength) return false;
  const text = new TextDecoder('latin1').decode(bytes);
  for (const match of text.matchAll(/\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/gu)) {
    const [start, holeStart, holeEnd, tailLength] = match.slice(1).map(Number);
    const end = holeEnd + tailLength;
    if (start !== 0 || !(holeStart < holeEnd) || end > text.length) continue;
    if (text[holeStart] !== '<' || text[holeEnd - 1] !== '>') continue;
    if (!/%%EOF\s*$/u.test(text.slice(Math.max(0, end - 32), end))) continue;
    return true;
  }
  return false;
}
