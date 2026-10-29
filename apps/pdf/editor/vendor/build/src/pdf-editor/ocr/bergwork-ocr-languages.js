// berg:work: OCR languages beyond the six that ship with the app, downloaded
// on first use. The files are Tesseract.js's own language packages
// (@tesseract.js-data/<code>@1.0.0, the 4.0.0_best_int models that the bundled
// languages use too) from jsDelivr, pinned by size and SHA-256. A verified
// file goes into Tesseract.js's language cache (IndexedDB "keyval-store",
// key "./<code>.traineddata", the entry the engine itself reads before it
// downloads anything), so later runs work offline. Only Latin, Greek and
// Cyrillic scripts are listed: the searchable text layer embeds Noto Sans,
// which has no glyphs for other scripts.

export const OCR_LANGUAGE_CDN = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data';

// [code, label, bytes, sha256 of <code>.traineddata.gz]
const EXTRA = [
  ['afr', 'Afrikaans', 1834273, 'a2a9ec1631e4d1a80f89518bd60c680464d3b87afa1483178859c1af19fdc9df'],
  ['sqi', 'Albanian', 962962, 'a84023c64e1c0910f8fddc25d13f2dbe1157ce2f478abb48adc8013de9b108f1'],
  ['eus', 'Basque', 2240649, 'e5a4ba32654272462f3a87965ae9812a98b787f4d437dd63914b85b1c2bf8ea7'],
  ['bel', 'Belarusian', 2106984, '642fd20eb04ae62b217800cb39d09bee030554ccee37751cc4e4edaaca51cac2'],
  ['bos', 'Bosnian', 1155304, '3304de098dbdf006ebb365d4f5187686e8eb7e773899ac1d1d2d65a60462ec7c'],
  ['bul', 'Bulgarian', 1411343, 'a38fdba9367316dad1d595427a975756e8c31367fc94a6530d012827833db8d7'],
  ['cat', 'Catalan', 639438, '1003ea7490d8c88b9308ed5dead936910a662fc9a4222cd536b92a17178e41eb'],
  ['hrv', 'Croatian', 2290948, '3256cd52165cb82f5f136264daf68ee54320ee68fad6a4a9ddfd1bc1861f806a'],
  ['ces', 'Czech', 2225029, '1ea33a8b6f9a9c18a6aae44a71eda06bbfdc206fe53cf1fc8121fb74def99166'],
  ['dan', 'Danish', 1845116, '6af1a07c22894b728ebc75f0fd0c8519eca002cfab6da903eb4d62e24f163abc'],
  ['nld', 'Dutch', 3005696, 'a2d904b6ddc4feb0d31ecfcd7361a554102e7aa2e278c54f4fc029e0d0815571'],
  ['epo', 'Esperanto', 2144471, '34e89c4f626c87fda7fe1769b748775b321869b2cbcb17944942a503b398f15c'],
  ['est', 'Estonian', 3101722, '27a3ddb4ec40348c36277463285221c8638de4ac126e7da88af36837d2db9a4a'],
  ['fin', 'Finnish', 3795323, '138c59f6a0bef68fd98d8baf565477f5cdb5198bfc4a68e558efd3b6a57acadd'],
  ['glg', 'Galician', 1743024, '950fe77dd9218d2bf642eeb423ab78fc2b3c7dab47c54cac6ccae2d1f81817f8'],
  ['frk', 'German (Fraktur)', 3362304, '22186f9eae55cdc13846ea4d586f24f9fe64765c5400c41c2c46e55a8bb735be'],
  ['ell', 'Greek', 1324749, 'e8a293abb398ec479176c1575aef24e2bacb0611c713f3fa996f97f0cd996fb3'],
  ['hun', 'Hungarian', 2854466, '99feb1ac618ddd39942d646f1df792e5bd4504df45e1ef68e47df51db476a2ed'],
  ['isl', 'Icelandic', 1696807, '002a0b366f0e96c06a65896033b0aabb313c6cc4c6d9c9cca0969dee11ff1f56'],
  ['ind', 'Indonesian', 1194182, 'a8896d2f584a5baae73d658b86b765acc7b15b7ba05e014f62b1a2a23b699a91'],
  ['gle', 'Irish', 678843, '89a1eca11aff0e62280bdaa6c0344eb1de765b67058a7cbace95bf5b8b4b7be4'],
  ['lat', 'Latin', 1739234, '22101c28f8f9b3e0b08a526a3e7895bb319d1e876684a150901c2e8580060e31'],
  ['lav', 'Latvian', 1318441, '08bc2d5fd9c66a1893f2c4e131e3410321f4079e6d41810898706be49ae02a9c'],
  ['lit', 'Lithuanian', 1901451, 'b8dd9f13ee6570cd791b6e074176823f00fcf2c8102c0d37b665e7723933cd91'],
  ['ltz', 'Luxembourgish', 1816965, '2b33cc540a20d5ace6c73b6a081a220333f0dc3b0b903d30f6aa65df93ab0114'],
  ['mkd', 'Macedonian', 719182, '043ca096871a4b58bb1b3bca34c6793187e060a12f3d1384ab4e6d8d77e8b802'],
  ['msa', 'Malay', 1177136, '35ae490b99462d04cf4e2a7985d98f0ba5e10ca62adb13aeda070c6f1783f097'],
  ['mlt', 'Maltese', 1164274, '756b8c1962b8d68dd5a3868b6106f49004d4f66b877c9c018c88a9a1d9ff07ac'],
  ['nor', 'Norwegian', 2490241, '6c5d91a5b684da387bfcf16b38bae8d94771812dc9ef706b413c728ca1d37c93'],
  ['pol', 'Polish', 2642356, 'a20fdec4ff99d8f8e84c708da3e42a4e935c26863055a0ed88aef5c66a59b91b'],
  ['ron', 'Romanian', 1692160, '3c2f550b6369f43254adf637cfe1088c7b6faff3d0382555219315112a24582a'],
  ['rus', 'Russian', 2679598, 'f51f5edc992249ff9b70a227b22f242dfa47b2b1bbc7ae0ea74908640c101f6a'],
  ['srp', 'Serbian (Cyrillic)', 1537929, '4a864eba46de4a7c264fc3c34b63db6889218eb51eefc5d38c5eaac548d58c96'],
  ['slk', 'Slovak', 2377899, '839350509c06e498448e35ce9faf13e24b28150b2d5cc39b900a751c5009127f'],
  ['slv', 'Slovenian', 1346857, '23550808c5ae045a2c6cabcb8a03a52239ffeaf45571d1120135ddc632d021f1'],
  ['swe', 'Swedish', 2503095, 'b60d9fea7e570d11d6fdf26c8d0ef1d63b49222313773ce66777ed08fa20dc5a'],
  ['tur', 'Turkish', 2141291, '384ba0dc28040451b7818d7d60e0a88df0d3003fa5a01d713a468779bc3d8c04'],
  ['ukr', 'Ukrainian', 2114206, 'ea2789a0ad99ff84bfd252a7410a1e8661a7bc5acaa41573d23b54b71446aa4c'],
  ['vie', 'Vietnamese', 1423003, '2284f610f262a1b19ec8df9f196b9ff6ce38ddb4a66329e998941df4b8961c8d'],
  ['cym', 'Welsh', 1363985, '9aa1e5a953c3241b74f9894252de51637c5d1ba1a11c1cf772f6db7cff0ca935'],
];

export const OCR_EXTRA_LANGUAGES = Object.freeze(EXTRA.map(([code, label, size, sha256]) => Object.freeze({ code, label, size, sha256 })));
const BY_CODE = new Map(OCR_EXTRA_LANGUAGES.map(entry => [entry.code, entry]));

export const isExtraOcrLanguage = code => BY_CODE.has(String(code || ''));
export const extraOcrLanguageUrl = code => `${OCR_LANGUAGE_CDN}/${code}@1.0.0/4.0.0_best_int`;

const CACHE_DB = 'keyval-store';
const CACHE_STORE = 'keyval';
const cacheKey = code => `./${code}.traineddata`;

function openCache() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(CACHE_DB);
    request.onupgradeneeded = () => request.result.createObjectStore(CACHE_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, run) {
  const db = await openCache();
  try {
    if (!db.objectStoreNames.contains(CACHE_STORE)) return undefined;
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(CACHE_STORE, mode);
      const result = run(transaction.objectStore(CACHE_STORE));
      transaction.oncomplete = () => resolve(result?.result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}

/** Whether a language's data is on this device already. */
export async function extraOcrLanguageCached(code) {
  if (!isExtraOcrLanguage(code) || typeof indexedDB === 'undefined') return false;
  try {
    return (await withStore('readonly', store => store.count(cacheKey(code)))) > 0;
  } catch {
    return false;
  }
}

const hex = buffer => Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('');

/**
 * Downloads a language once (verified against its pinned SHA-256) into the
 * engine's cache. onProgress(fraction) reports the download.
 */
export async function ensureExtraOcrLanguage(code, { signal, onProgress } = {}) {
  const entry = BY_CODE.get(String(code || ''));
  if (!entry) throw new Error(`OCR language data is not available: ${code}`);
  if (await extraOcrLanguageCached(code)) return { downloaded: false };
  const response = await fetch(`${extraOcrLanguageUrl(code)}/${code}.traineddata.gz`, { signal, mode: 'cors', credentials: 'omit' });
  if (!response.ok) throw new Error(`The ${entry.label} OCR language could not be downloaded (HTTP ${response.status}).`);
  const chunks = [];
  let received = 0;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      onProgress?.(Math.min(1, received / entry.size));
    }
  } else {
    chunks.push(new Uint8Array(await response.arrayBuffer()));
  }
  const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (bytes.byteLength !== entry.size || hex(await crypto.subtle.digest('SHA-256', bytes)) !== entry.sha256) {
    throw new Error(`The downloaded ${entry.label} OCR language did not match its checksum and was not used.`);
  }
  // Gzipped as downloaded; the engine unpacks cached data the same way.
  await withStore('readwrite', store => store.put(bytes, cacheKey(code)));
  return { downloaded: true };
}
