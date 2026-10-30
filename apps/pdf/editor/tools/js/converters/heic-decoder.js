// HEIC/HEIF input for the converters and Image Tools. Browsers other than Safari cannot show these files, so they are
// decoded with libheif in a worker and handed on as a PNG with the rotation applied and the colours in sRGB.

const HEVC_BRANDS = /^hei[cxms]$|^hev[cxms]$/;
const GENERIC_BRANDS = /^m[is]f1$/;
const AV1_BRANDS = /^avi[fs]$/;
const HEIC_NAME = /\.(heic|heif|hif)$/i;
const HEIC_MIME = /^image\/hei[cf](-sequence)?$/i;
const LOAD_TIMEOUT_MS = 30_000;
const LOAD_ATTEMPTS = 3;

// Looks at the file's bytes first: an iPhone photo renamed to .jpg is still HEIC, and an AVIF named .heif is not.
export async function isHeicFile(file) {
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const tag = (offset) => String.fromCharCode(...head.subarray(offset, offset + 4));
  if (tag(4) !== 'ftyp') return HEIC_NAME.test(file.name || '') || HEIC_MIME.test(file.type || '');
  const boxEnd = Math.min(new DataView(head.buffer).getUint32(0), head.length);
  const brands = [tag(8)];
  for (let offset = 16; offset + 4 <= boxEnd; offset += 4) brands.push(tag(offset));
  if (brands.some((brand) => HEVC_BRANDS.test(brand))) return true;
  return brands.some((brand) => GENERIC_BRANDS.test(brand)) && !brands.some((brand) => AV1_BRANDS.test(brand));
}

// The decoder is a 2 MB file fetched on first use, which on a first visit competes with the service worker's precache
// and can fail or stall on a weak connection. Starting it again is cheap; losing the user's photo to that is not.
function startWorker() {
  return new Promise((resolve, reject) => {
    const worker = new Worker('/tools/js/converters/heic-decode-worker.js');
    const fail = (message) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail('The HEIC decoder took too long to load'), LOAD_TIMEOUT_MS);
    worker.onmessage = () => {
      clearTimeout(timer);
      resolve(worker);
    };
    worker.onerror = (event) => fail(event.message || 'The HEIC decoder could not be loaded');
  });
}

async function loadWorker() {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await startWorker();
    } catch (error) {
      if (attempt === LOAD_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 500));
    }
  }
}

async function decodeInWorker(bytes) {
  const worker = await loadWorker();
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      worker.terminate();
      if (data.error) reject(new Error(data.error));
      else resolve(data);
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || 'The HEIC decoder stopped unexpectedly'));
    };
    worker.postMessage({ bytes }, [bytes.buffer]);
  });
}

export async function heicToPngFile(file) {
  const { rgba, width, height } = await decodeInWorker(new Uint8Array(await file.arrayBuffer()));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error(`${width} × ${height} px is too large for this browser`);
  return new File([blob], `${(file.name || 'image').replace(/\.[^.]+$/, '')}.png`, { type: 'image/png' });
}

export async function normalizeHeicFile(file) {
  return await isHeicFile(file) ? heicToPngFile(file) : file;
}
