// Compact object numbers for qpdf. PDFium keeps a document's object numbers
// when it saves, so an export that dropped most objects (a redaction that
// removed every font of a small page) can keep, say, six objects numbered
// 657–665 in a 1 KB file. qpdf 12 rejects object numbers that are large for
// the file size and then finds no /Root, so every later qpdf step of the
// export failed. Such files are renumbered from 1 in reading order.

const OBJECT_HEADER = /(?:^|[\r\n\s])(\d+)\s+\d+\s+obj\b/gu;

/** Whether the bytes look sparse enough to renumber (cheap scan, no parse). */
export function pdfObjectNumbersLookSparse(bytes) {
  const text = new TextDecoder('latin1').decode(bytes);
  if (text.includes('/Encrypt')) return false;
  let count = 0;
  let highest = 0;
  for (const match of text.matchAll(OBJECT_HEADER)) {
    count += 1;
    highest = Math.max(highest, Number(match[1]));
  }
  // Object streams hide their members from the scan; the parse below counts them.
  return highest > 64 && (highest > bytes.length / 32 || highest > 4 * count + 100);
}

/** Renumbers a sparse PDF; returns the input when it is not sparse. */
export async function compactSparsePdfObjectNumbers(PDFLib, bytes) {
  if (!pdfObjectNumbersLookSparse(bytes)) return bytes;
  const source = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const objects = source.context.enumerateIndirectObjects();
  const highest = Math.max(0, ...objects.map(([ref]) => ref.objectNumber));
  if (!(highest > bytes.length / 32 || highest > 4 * objects.length + 100)) return bytes;
  const context = PDFLib.PDFContext.create();
  const copier = PDFLib.PDFObjectCopier.for(source.context, context);
  const { Root, Info, ID } = source.context.trailerInfo;
  context.trailerInfo.Root = copier.copy(Root);
  if (Info) context.trailerInfo.Info = copier.copy(Info);
  if (ID) context.trailerInfo.ID = copier.copy(ID);
  context.header = source.context.header;
  return new Uint8Array(await PDFLib.PDFWriter.forContext(context, 50).serializeToBuffer());
}
