/**
 * Folders of images (Compositor 1.4.10): a dropped or chosen folder imports its images as layers. Browsers hand a
 * dropped folder over as a directory entry, not as files, so it is read here; images come in name order.
 */

const IMAGE_NAME = /\.(jpe?g|png|gif|webp|avif|heic|heif|hif|tiff?|dng|bmp)$/i;

/** Images of a folder's listing, in natural name order; other files (and macOS "._" sidecars) are left out. */
export function folderImages(files: readonly File[]): File[] {
  return files.filter((file) => IMAGE_NAME.test(file.name) && !file.name.startsWith('._'))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

type Entry = { isFile: boolean; isDirectory: boolean; name: string; file?(ok: (file: File) => void, fail: (error: unknown) => void): void;
  createReader?(): { readEntries(ok: (entries: Entry[]) => void, fail: (error: unknown) => void): void } };

async function entriesOf(directory: Entry): Promise<Entry[]> {
  const reader = directory.createReader!(), all: Entry[] = [];
  // readEntries returns at most 100 entries per call; read until it hands back an empty batch.
  for (;;) {
    const batch = await new Promise<Entry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) return all;
    all.push(...batch);
  }
}

/**
 * The files of a drop, with each dropped folder replaced by its images (top level only, as Compositor does).
 * `folders` reports whether a folder was among them, so callers can import its images as layers of one project.
 */
export async function droppedFiles(data: DataTransfer): Promise<{ files: File[]; folders: boolean }> {
  const items = [...data.items].filter((item) => item.kind === 'file');
  const entries = items.map((item) => (item as DataTransferItem & { webkitGetAsEntry?(): Entry | null }).webkitGetAsEntry?.() ?? null);
  if (!entries.some((entry) => entry?.isDirectory)) return { files: [...data.files], folders: false };
  // Items die with the event: take every file and entry before the first await.
  const plain = items.map((item, index) => entries[index]?.isDirectory ? null : item.getAsFile());
  const files: File[] = [];
  for (let index = 0; index < items.length; index++) {
    const entry = entries[index];
    if (entry?.isDirectory) {
      const children = (await entriesOf(entry)).filter((child) => child.isFile);
      const read = await Promise.all(children.map((child) => new Promise<File | null>((resolve) => child.file!(resolve, () => resolve(null)))));
      files.push(...folderImages(read.filter((file): file is File => !!file)));
    } else if (plain[index]) files.push(plain[index]!);
  }
  return { files, folders: true };
}
