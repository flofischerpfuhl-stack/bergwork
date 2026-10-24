// @ts-check

import { createPdfCommand } from './commands.js';

export const PORTABLE_PDF_NATIVE_STATE_FORMAT = 'fernwork-pdf-native-state';
export const PORTABLE_PDF_NATIVE_STATE_VERSION = 1;

const MAX_CHECKPOINT_BYTES = 384 * 1024 * 1024;
const MAX_RESOURCE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_RESOURCES = 10_000;
const MAX_JOURNAL_ENTRIES = 10_000;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array();
}

function bytesToBase64(bytesLike) {
  const bytes = asBytes(bytesLike);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function decodedLength(value) {
  const text = String(value || '');
  if (!text.length || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(text)) return -1;
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  return (text.length / 4) * 3 - padding;
}

function base64ToBytes(value, byteLimit, label) {
  const length = decodedLength(value);
  if (length <= 0) throw new Error(`${label} is empty or is not valid base64.`);
  if (length > byteLimit) throw new Error(`${label} exceeds the portable project byte limit.`);
  let binary;
  try {
    binary = atob(String(value));
  } catch {
    throw new Error(`${label} is not valid base64.`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function sha256(bytesLike) {
  const bytes = asBytes(bytesLike);
  const owned = bytes.slice();
  const digest = await crypto.subtle.digest('SHA-256', owned.buffer);
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

function plainClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function resourceMetadata(resource) {
  const {
    bytes: _bytes,
    fileName: _fileName,
    indexedDbKey: _indexedDbKey,
    byteLength: _byteLength,
    ...metadata
  } = resource || {};
  return plainClone(metadata);
}

function commandResourceHashes(commands = []) {
  return [...new Set(commands.flatMap(command => [
    command?.payload?.resourceHash,
    command?.payload?.fontResourceHash,
    ...(Array.isArray(command?.payload?.fontResourceHashes)
      ? command.payload.fontResourceHashes
      : []),
  ]).filter(hash => typeof hash === 'string' && hash))].sort();
}

function normalizedEntry(entry, sourceDocumentId, targetDocumentId) {
  if (entry?.status !== 'committed') {
    throw new Error('Portable PDF native history can contain only committed transactions.');
  }
  if (!Number.isSafeInteger(entry.committedRevision) || entry.committedRevision < 1) {
    throw new Error('Portable PDF native history has an invalid committed revision.');
  }
  const remap = (command, index, kind) => createPdfCommand({
    commandId: String(command?.commandId || `import-${entry.committedRevision}-${kind}-${index + 1}`),
    type: command?.type,
    targetId: command?.targetId === sourceDocumentId ? targetDocumentId : command?.targetId,
    payload: command?.payload,
  });
  const commands = (entry.commands || []).map((command, index) => remap(command, index, 'command'));
  const inverseCommands = (entry.inverseCommands || [])
    .map((command, index) => remap(command, index, 'inverse'));
  if (!commands.length) throw new Error('Portable PDF native history contains an empty transaction.');
  const resourceHashes = [...new Set([
    ...(entry.resourceHashes || []),
    ...commandResourceHashes([...commands, ...inverseCommands]),
  ])].sort();
  if (resourceHashes.some(hash => typeof hash !== 'string' || !HASH_PATTERN.test(hash))) {
    throw new Error('Portable PDF native history contains an invalid resource hash.');
  }
  return {
    label: typeof entry.label === 'string' && entry.label ? entry.label : 'Imported PDF edit',
    transactionId: String(entry.transactionId || `imported-${entry.committedRevision}`),
    baseRevision: Number.isSafeInteger(entry.baseRevision) && entry.baseRevision >= 0
      ? entry.baseRevision
      : Math.max(0, entry.committedRevision - 1),
    createdAt: Number.isSafeInteger(entry.createdAt) && entry.createdAt >= 0
      ? entry.createdAt
      : 0,
    commands,
    resourceHashes,
    inverseCommands,
    status: 'committed',
    committedRevision: entry.committedRevision,
    effectDigest: typeof entry.effectDigest === 'string' && entry.effectDigest
      ? entry.effectDigest
      : `imported-${entry.committedRevision}`,
    rejection: null,
    historyMode: ['edit', 'undo', 'redo', 'none'].includes(entry.historyMode)
      ? entry.historyMode
      : 'edit',
    historyLabel: typeof entry.historyLabel === 'string' && entry.historyLabel
      ? entry.historyLabel
      : (entry.label || 'Imported PDF edit'),
    uiTransition: entry.uiTransition ? plainClone(entry.uiTransition) : null,
  };
}

function assertPdfBytes(bytes) {
  if (
    bytes.byteLength < 8 ||
    bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46 || bytes[4] !== 0x2d
  ) {
    throw new Error('Portable PDF native checkpoint is not a PDF document.');
  }
}

/**
 * Capture a self-contained native state after the semantic kernel has made a
 * current checkpoint durable. Resource bodies are hydrated one at a time so
 * large snapshot histories do not become resident in the worker or kernel.
 */
export async function exportPortablePdfNativeState({ store, documentKey, expectedRevision }) {
  if (!store?.load || !store?.loadResource) {
    throw new TypeError('A resource-capable PDF journal store is required.');
  }
  const record = await store.load(documentKey);
  const revision = Number(record?.checkpointRevision || 0);
  const checkpointBytes = asBytes(record?.checkpointBytes);
  if (!record || revision < 0 || !checkpointBytes.byteLength) {
    throw new Error('The current native PDF checkpoint is unavailable for project export.');
  }
  if (Number.isSafeInteger(expectedRevision) && revision !== expectedRevision) {
    throw new Error('The native PDF checkpoint does not match the current editing revision.');
  }
  if (checkpointBytes.byteLength > MAX_CHECKPOINT_BYTES) {
    throw new Error('The current native PDF checkpoint is too large for a portable project.');
  }
  assertPdfBytes(checkpointBytes);
  const entries = (record.entries || []).filter(entry => entry?.status !== 'rejected');
  if (entries.length > MAX_JOURNAL_ENTRIES) {
    throw new Error('The native PDF history is too large for a portable project.');
  }
  if (entries.some(entry => entry?.status !== 'committed')) {
    throw new Error('A native PDF transaction is still pending; project export was not started.');
  }
  const resources = record.resources || [];
  if (resources.length > MAX_RESOURCES) {
    throw new Error('The native PDF resource count exceeds the portable project limit.');
  }
  let resourceByteLength = 0;
  const portableResources = [];
  for (const metadata of resources) {
    if (!HASH_PATTERN.test(String(metadata?.hash || ''))) {
      throw new Error('The native PDF journal contains an invalid resource hash.');
    }
    const hydrated = await store.loadResource(documentKey, metadata.hash);
    const bytes = asBytes(hydrated?.bytes);
    if (!bytes.byteLength) {
      throw new Error(`Native PDF project resource is unavailable: ${metadata.hash}`);
    }
    resourceByteLength += bytes.byteLength;
    if (resourceByteLength > MAX_RESOURCE_BYTES) {
      throw new Error('The native PDF resources exceed the portable project byte limit.');
    }
    if (await sha256(bytes) !== metadata.hash) {
      throw new Error(`Native PDF project resource failed SHA-256 validation: ${metadata.hash}`);
    }
    portableResources.push({
      ...resourceMetadata(hydrated),
      hash: metadata.hash,
      byteLength: bytes.byteLength,
      bytesBase64: bytesToBase64(bytes),
    });
  }
  const checkpointHash = await sha256(checkpointBytes);
  return {
    format: PORTABLE_PDF_NATIVE_STATE_FORMAT,
    version: PORTABLE_PDF_NATIVE_STATE_VERSION,
    sourceDocumentId: String(documentKey),
    checkpoint: {
      revision,
      sha256: checkpointHash,
      byteLength: checkpointBytes.byteLength,
      bindings: plainClone(record.checkpointBindings || []),
      bytesBase64: bytesToBase64(checkpointBytes),
    },
    entries: plainClone(entries),
    resources: portableResources,
  };
}

/**
 * Validate and durably install a packaged journal under a fresh document key.
 * Nothing is written until every checkpoint, entry, and resource has passed
 * structural, byte-budget, and SHA-256 validation.
 */
export async function importPortablePdfNativeState({ store, documentKey, state }) {
  if (!store?.load || !store?.save) throw new TypeError('A PDF journal store is required.');
  if (typeof documentKey !== 'string' || !documentKey) throw new TypeError('documentKey is required.');
  if (state?.format !== PORTABLE_PDF_NATIVE_STATE_FORMAT) {
    throw new Error('The project has no recognized native PDF state package.');
  }
  if (state.version !== PORTABLE_PDF_NATIVE_STATE_VERSION) {
    throw new Error('The project native PDF state was created by an unsupported version.');
  }
  if (await store.load(documentKey)) {
    throw new Error('The imported PDF document key already has native recovery data.');
  }
  const sourceDocumentId = String(state.sourceDocumentId || '');
  if (!sourceDocumentId) throw new Error('The native PDF state has no source document identity.');
  const checkpointRevision = Number(state.checkpoint?.revision);
  if (!Number.isSafeInteger(checkpointRevision) || checkpointRevision < 0) {
    throw new Error('The native PDF state has an invalid checkpoint revision.');
  }
  const checkpointBytes = base64ToBytes(
    state.checkpoint?.bytesBase64,
    MAX_CHECKPOINT_BYTES,
    'Portable PDF native checkpoint',
  );
  if (checkpointBytes.byteLength !== Number(state.checkpoint?.byteLength)) {
    throw new Error('Portable PDF native checkpoint length does not match its manifest.');
  }
  assertPdfBytes(checkpointBytes);
  if (!HASH_PATTERN.test(String(state.checkpoint?.sha256 || '')) ||
      await sha256(checkpointBytes) !== state.checkpoint.sha256) {
    throw new Error('Portable PDF native checkpoint failed SHA-256 validation.');
  }
  if (!Array.isArray(state.entries) || state.entries.length > MAX_JOURNAL_ENTRIES) {
    throw new Error('Portable PDF native history exceeds the entry limit.');
  }
  const entries = state.entries.map(entry => normalizedEntry(
    entry,
    sourceDocumentId,
    documentKey,
  )).sort((left, right) => left.committedRevision - right.committedRevision);
  const revisions = new Set(entries.map(entry => entry.committedRevision));
  if (revisions.size !== entries.length || entries.some(entry => entry.committedRevision > checkpointRevision)) {
    throw new Error('Portable PDF native history does not align with its checkpoint revision.');
  }
  if (!Array.isArray(state.resources) || state.resources.length > MAX_RESOURCES) {
    throw new Error('Portable PDF native resources exceed the resource count limit.');
  }
  const resources = [];
  const resourceHashes = new Set();
  let resourceByteLength = 0;
  for (const packaged of state.resources) {
    const hash = String(packaged?.hash || '');
    if (!HASH_PATTERN.test(hash) || resourceHashes.has(hash)) {
      throw new Error('Portable PDF native resources contain an invalid or duplicate hash.');
    }
    const remaining = MAX_RESOURCE_BYTES - resourceByteLength;
    const bytes = base64ToBytes(packaged.bytesBase64, remaining, `Portable PDF resource ${hash}`);
    if (bytes.byteLength !== Number(packaged.byteLength)) {
      throw new Error(`Portable PDF resource length does not match its manifest: ${hash}`);
    }
    if (await sha256(bytes) !== hash) {
      throw new Error(`Portable PDF resource failed SHA-256 validation: ${hash}`);
    }
    resourceByteLength += bytes.byteLength;
    resourceHashes.add(hash);
    const {
      bytesBase64: _bytesBase64,
      fileName: _fileName,
      indexedDbKey: _indexedDbKey,
      ...metadata
    } = packaged;
    resources.push({ ...plainClone(metadata), hash, byteLength: bytes.byteLength, bytes });
  }
  for (const entry of entries) {
    for (const hash of entry.resourceHashes) {
      if (!resourceHashes.has(hash)) {
        throw new Error(`Portable PDF native history references a missing resource: ${hash}`);
      }
    }
  }
  const saved = await store.save(documentKey, {
    checkpointRevision,
    checkpointBytes,
    checkpointBindings: plainClone(state.checkpoint?.bindings || []),
    resources,
    entries,
  });
  const durable = await store.load(documentKey);
  if (
    !durable ||
    Number(durable.checkpointRevision) !== checkpointRevision ||
    asBytes(durable.checkpointBytes).byteLength !== checkpointBytes.byteLength
  ) {
    await store.deleteDocument?.(documentKey);
    throw new Error('Portable PDF native state did not reach durable browser storage.');
  }
  return {
    checkpointRevision,
    resourceCount: resources.length,
    resourceByteLength,
    entryCount: entries.length,
    record: saved,
  };
}
