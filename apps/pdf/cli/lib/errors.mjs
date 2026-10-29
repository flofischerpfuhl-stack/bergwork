// Error codes of the CLI and the MCP server, and the exit code each one maps to.
export class CliError extends Error {
  constructor(code, message, details, engineCode) {
    super(message);
    this.code = code;
    if (details !== undefined) this.details = details;
    if (engineCode) this.engineCode = engineCode;
  }
}

/**
 * 0 success · 1 the operation failed (engine error, failed check of the result, timeout) · 2 usage (bad arguments,
 * output exists) · 3 not applied (the engine refused or cannot do it safely, nothing matched, unknown form field) ·
 * 4 input (unreadable, not a PDF, password missing or wrong) · 5 setup (dist/ or Playwright missing).
 */
export const EXIT = Object.freeze({
  ok: 0, failed: 1, usage: 2, notApplied: 3, input: 4, setup: 5,
});

const BY_CODE = {
  'bad-argument': EXIT.usage,
  'output-exists': EXIT.usage,
  refused: EXIT.notApplied,
  unsupported: EXIT.notApplied,
  'no-match': EXIT.notApplied,
  'unknown-field': EXIT.notApplied,
  'input-unreadable': EXIT.input,
  'not-pdf': EXIT.input,
  'password-required': EXIT.input,
  'wrong-password': EXIT.input,
  'setup-missing': EXIT.setup,
};

export const exitCodeFor = (code) => BY_CODE[code] ?? EXIT.failed;

export function errorPayload(error) {
  if (error instanceof CliError) {
    return {
      code: error.code, message: error.message,
      ...(error.engineCode ? { engineCode: error.engineCode } : {}),
      ...(error.details !== undefined ? { details: error.details } : {}),
    };
  }
  return { code: 'internal', message: String(error?.stack || error?.message || error) };
}
