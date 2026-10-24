const HASH = /^[0-9a-f]{64}$/u;
const MAX_FACES = 16;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_FACE_BYTES = 32 * 1024 * 1024;

function hex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function installBrowserFontPreviews({
  catalog = [], copyResource, FontFaceCtor = globalThis.FontFace,
  fontSet = globalThis.document?.fonts, subtle = globalThis.crypto?.subtle,
  maxFaces = MAX_FACES, maxBytes = MAX_BYTES, signal = null,
  maxFaceBytes = MAX_FACE_BYTES, onStatus = null,
} = {}) {
  const families = new Map();
  const statuses = new Map();
  const ownedFaces = [];
  let consumed = 0;
  let considered = 0;
  if (typeof copyResource !== 'function' || typeof FontFaceCtor !== 'function' ||
      !fontSet?.add || !fontSet?.delete || !subtle?.digest) {
    return { families, statuses, dispose() {} };
  }
  for (const entry of catalog) {
    if (signal?.aborted) break;
    if (!HASH.test(String(entry?.hash || ''))) continue;
    const setStatus = status => {
      statuses.set(entry.hash, status);
      onStatus?.(entry.hash, status);
    };
    if (considered >= maxFaces) { setStatus('limited'); continue; }
    considered += 1;
    setStatus('loading');
    try {
      const resource = await copyResource(entry.hash);
      const bytes = resource?.bytes instanceof Uint8Array ? resource.bytes : null;
      if (!bytes?.byteLength) { setStatus('failed'); continue; }
      if (bytes.byteLength > maxFaceBytes || consumed + bytes.byteLength > maxBytes) {
        setStatus('limited');
        continue;
      }
      const digest = hex(new Uint8Array(await subtle.digest('SHA-256', bytes)));
      if (signal?.aborted) break;
      if (digest !== entry.hash) { setStatus('failed'); continue; }
      const family = `FernworkPreview_${entry.hash}`;
      const face = new FontFaceCtor(family, bytes.slice().buffer, {
        weight: String(entry.fontWeight || '400'),
        style: ['italic', 'oblique'].includes(String(entry.fontStyle)) ? String(entry.fontStyle) : 'normal',
      });
      await face.load();
      if (signal?.aborted) break;
      fontSet.add(face);
      consumed += bytes.byteLength;
      ownedFaces.push(face);
      families.set(entry.hash, family);
      setStatus('ready');
    } catch {
      // Browser font parsing is preview-only. Native embedding remains authoritative.
      if (!signal?.aborted) setStatus('failed');
    }
  }
  return {
    families, statuses,
    dispose() { for (const face of ownedFaces) fontSet.delete(face); },
  };
}
