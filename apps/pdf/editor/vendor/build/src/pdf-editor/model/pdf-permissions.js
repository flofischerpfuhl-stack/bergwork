// AES-256 permission flags of the Security panel mapped to qpdf's per-bit
// switches (ISO 32000 user access permissions, table 22). Each checkbox owns
// its own bits, so leaving one unchecked never clears another permission:
//   noPrint    -> bits 3 and 12 (print, high-quality print)
//   noEdit     -> bits 4 and 11 (modify contents, assemble pages)
//   noCopy     -> bit 5 (copy text and graphics; bit 10 accessibility stays on)
//   noAnnotate -> bit 6 (add or modify annotations; bit 9 form filling stays on)

// Nothing is restricted until the user asks for it.
export const DEFAULT_PDF_RESTRICT_FLAGS = Object.freeze({
  noPrint: false,
  noEdit: false,
  noCopy: false,
  noAnnotate: false,
});

export function restrictPdfPermissionArgs(flags = {}) {
  return [
    `--print=${flags.noPrint ? 'none' : 'full'}`,
    `--modify-other=${flags.noEdit ? 'n' : 'y'}`,
    `--assemble=${flags.noEdit ? 'n' : 'y'}`,
    `--extract=${flags.noCopy ? 'n' : 'y'}`,
    `--annotate=${flags.noAnnotate ? 'n' : 'y'}`,
    '--form=y',
    '--accessibility=y',
  ];
}

// "/Encrypt" in the trailer (or the xref stream dictionary, which is never
// compressed) is the only way a PDF declares encryption. A plain byte scan
// keeps the qpdf engine unloaded for the vast majority of files; a hit is
// confirmed with qpdf.
const ENCRYPT_KEY = [0x2f, 0x45, 0x6e, 0x63, 0x72, 0x79, 0x70, 0x74];

export function pdfBytesMayBeEncrypted(bytes) {
  if (!(bytes instanceof Uint8Array)) return false;
  const last = bytes.length - ENCRYPT_KEY.length;
  for (let index = bytes.indexOf(ENCRYPT_KEY[0]); index >= 0 && index <= last;
    index = bytes.indexOf(ENCRYPT_KEY[0], index + 1)) {
    let match = true;
    for (let offset = 1; offset < ENCRYPT_KEY.length; offset += 1) {
      if (bytes[index + offset] !== ENCRYPT_KEY[offset]) { match = false; break; }
    }
    if (match) return true;
  }
  return false;
}

// qpdf's capability names (pdfstudio getInfo().encryption.permissions) in the
// order the notice lists them.
const PERMISSION_LABELS = Object.freeze([
  ['print', 'printing'],
  ['modify', 'changing content'],
  ['assemble', 'changing pages'],
  ['extract', 'copying text and images'],
  ['annotate', 'adding comments'],
  ['fillForms', 'filling in forms'],
]);

export function restrictedPdfPermissionLabels(permissions) {
  if (!permissions || typeof permissions !== 'object') return [];
  return PERMISSION_LABELS.filter(([key]) => permissions[key] === false).map(([, label]) => label);
}

function joinLabels(labels) {
  if (labels.length < 2) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
}

/**
 * The calm notice for a document whose protection was removed when it was
 * opened. `protection.kind` is 'permissions' (an owner password only: the
 * file opened without a password) or 'password' (unlocked with its password).
 * Returns null when nothing was removed.
 */
export function pdfProtectionRemovedNotice(protection) {
  if (!protection?.kind) return null;
  if (protection.kind === 'password') {
    return {
      title: 'Saved copies have no password',
      text: 'This PDF was opened with its password. Save writes a copy without it; '
        + 'to protect the copy again, use Security.',
    };
  }
  const restricted = joinLabels(restrictedPdfPermissionLabels(protection.permissions));
  if (!restricted) {
    return {
      title: 'This PDF was encrypted',
      text: 'It opens without a password, so berg:work PDF edits a decrypted copy. '
        + 'Save writes it without encryption; to protect it again, use Security.',
    };
  }
  return {
    title: 'This PDF had usage restrictions',
    text: `It opens without a password but restricted ${restricted}. berg:work PDF edits an unrestricted copy, `
      + 'so Save writes it without these restrictions; to restrict it again, use Security.',
  };
}
