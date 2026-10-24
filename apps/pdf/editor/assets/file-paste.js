/**
 * Routes clipboard files into the same paths as file pickers and dropzones.
 *
 * Text paste stays untouched. File paste is also ignored while an editable
 * control has focus so editors keep ownership of their native clipboard flow.
 */

const registeredTargets = new Set();
let installed = false;
let lastActiveTarget = null;

export function installGlobalFilePaste() {
  if (installed) return;
  installed = true;
  document.addEventListener('paste', handlePaste, true);
}

export function registerFilePasteTarget(options) {
  installGlobalFilePaste();
  const target = {
    root: options.root,
    input: options.input || null,
    accept: options.accept || [],
    multiple: options.multiple !== false,
    onFiles: options.onFiles,
    priority: Number(options.priority || 0),
  };
  registeredTargets.add(target);
  if (target.input) target.input.dataset.ooPasteRegistered = 'true';

  const markActive = () => { lastActiveTarget = target; };
  target.root?.addEventListener('pointerenter', markActive);
  target.root?.addEventListener('focusin', markActive);
  target.root?.addEventListener('dragenter', markActive);

  return () => {
    registeredTargets.delete(target);
    if (lastActiveTarget === target) lastActiveTarget = null;
  };
}

function handlePaste(event) {
  const files = clipboardFiles(event);
  if (!files.length || isEditable(event.target)) return;

  const registered = [...registeredTargets]
    .filter((target) => isRelevant(target.root))
    .map((target) => ({ target, files: matchingFiles(files, target.accept) }))
    .filter((entry) => entry.files.length)
    .sort((a, b) => {
      if (a.target === lastActiveTarget) return -1;
      if (b.target === lastActiveTarget) return 1;
      return b.target.priority - a.target.priority;
    });

  if (registered.length) {
    event.preventDefault();
    const { target, files: accepted } = registered[0];
    target.onFiles(target.multiple ? accepted : [accepted[0]]);
    return;
  }

  const inputs = [...document.querySelectorAll('input[type="file"]:not([data-oo-paste-registered])')]
    .filter((input) => isRelevant(input.parentElement))
    .map((input) => ({ input, files: matchingFiles(files, input.accept.split(',').filter(Boolean)) }))
    .filter((entry) => entry.files.length);

  if (inputs.length !== 1) return;
  event.preventDefault();
  const { input, files: accepted } = inputs[0];
  const transfer = new DataTransfer();
  (input.multiple ? accepted : [accepted[0]]).forEach((file) => transfer.items.add(file));
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function clipboardFiles(event) {
  const direct = [...(event.clipboardData?.files || [])];
  if (direct.length) return direct;
  return [...(event.clipboardData?.items || [])]
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter(Boolean);
}

function matchingFiles(files, accept) {
  const rules = accept.map((rule) => String(rule).trim().toLowerCase()).filter(Boolean);
  if (!rules.length) return files;
  return files.filter((file) => rules.some((rule) => accepts(file, rule)));
}

function accepts(file, rule) {
  if (rule.startsWith('.')) return file.name.toLowerCase().endsWith(rule);
  if (rule.endsWith('/*')) return file.type.toLowerCase().startsWith(rule.slice(0, -1));
  return file.type.toLowerCase() === rule;
}

function isRelevant(element) {
  if (!element?.isConnected) return false;
  if (element.closest('[hidden], .hidden')) return false;
  const tab = element.closest('.tab-content');
  if (tab && !tab.classList.contains('active')) return false;
  return true;
}

function isEditable(element) {
  return Boolean(element?.closest?.('textarea, input:not([type="file"]), [contenteditable=""], [contenteditable="true"]'));
}
