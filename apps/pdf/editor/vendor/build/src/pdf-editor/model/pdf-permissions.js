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
