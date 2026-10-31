// Finds every control the Inspector and the mini toolbar show for the selection, from the DOM, and works it the way its
// element type is worked. There is no list of controls here, so a new control is tested from the day it appears. A new
// kind of element is reported as `unknown-kind`, which fails the run rather than letting it pass unseen.

// Controls that leave the object: they change the panel, not the document. Everything else is worked.
const NAVIGATION = /^(close (layers|properties)|properties|layers|position units)$/iu;
// Needs a real file or the operating system.
const NOT_DRIVABLE = /upload font file|pick from the screen|pick a colour from the page/iu;

const SURFACES = Object.freeze([
  { id: 'inspector', root: '.oo-pdf-inspector:not(.is-headless)' },
  { id: 'mini', root: '.oo-pdf-mini-toolbar' },
]);

/** Everything operable right now, in reading order. Keys are stable across runs: surface, label and kind. */
export function discoverControls(page) {
  return page.evaluate(surfaces => {
    const labelOf = node => (node.getAttribute('aria-label') || node.title ||
      node.closest('label')?.innerText?.trim() || node.innerText?.trim() || node.getAttribute('name') || '')
      .replace(/\s+/gu, ' ').replace(/[·:].*$/u, '').trim().slice(0, 48);
    const kindOf = node => {
      if (node.tagName === 'TEXTAREA') return 'textarea';
      if (node.tagName === 'SELECT') return 'select';
      if (node.tagName === 'INPUT') {
        if (['checkbox', 'radio'].includes(node.type)) return 'toggle';
        if (node.type === 'range') return 'range';
        if (node.type === 'color') return 'color';
        if (node.type === 'file') return 'file';
        if (['text', 'number', 'search', ''].includes(node.type)) return 'field';
        return 'unknown-kind';
      }
      if (node.getAttribute('role') === 'combobox') return 'combobox';
      if (node.hasAttribute('aria-expanded') && node.getAttribute('aria-controls')) return 'section';
      if (node.getAttribute('aria-haspopup')) return 'menu';
      if (node.tagName === 'BUTTON' || node.getAttribute('role') === 'button') return 'button';
      return 'unknown-kind';
    };
    const found = [];
    const seen = new Map();
    for (const surface of surfaces) {
      const root = document.querySelector(surface.root);
      if (!root) continue;
      for (const node of root.querySelectorAll('button, input, select, textarea, [role=button], [role=switch], [role=combobox], [role=slider], [tabindex="0"]')) {
        const box = node.getBoundingClientRect();
        const hiddenInput = node.tagName === 'INPUT' && node.type !== 'file' && getComputedStyle(node).opacity === '0' && !box.width;
        if ((!box.width || !box.height) && node.type !== 'file' || hiddenInput) continue;
        if (node.closest('[aria-hidden="true"]') || node.closest('.oo-pdf-layer-row')) continue;
        const kind = kindOf(node);
        const label = labelOf(node);
        const base = `${surface.id}:${kind}:${label || 'unnamed'}`;
        const index = seen.get(base) || 0;
        seen.set(base, index + 1);
        node.dataset.matrixKey = index ? `${base}#${index}` : base;
        found.push({
          key: node.dataset.matrixKey,
          surface: surface.id,
          kind,
          label,
          disabled: node.disabled || node.getAttribute('aria-disabled') === 'true',
          pressed: node.getAttribute('aria-pressed'),
          value: 'value' in node ? String(node.value) : '',
        });
      }
    }
    return found;
  }, SURFACES);
}

export const skipReason = control => {
  if (NAVIGATION.test(control.label)) return 'navigation';
  if (control.kind === 'file' || NOT_DRIVABLE.test(control.label)) return 'needs the operating system';
  return null;
};

const locate = (page, key) => page.locator(`[data-matrix-key="${key.replaceAll('"', '\\"')}"]`).first();

const otherOption = page => page.evaluate(() => {
  const options = [...document.querySelectorAll('[role=listbox] [role=option]:not([aria-disabled="true"]):not(:disabled), [role=menu] [role=menuitem]:not(:disabled), [role=menu] button:not(:disabled)')];
  const choice = options.find(option => option.getAttribute('aria-selected') !== 'true') || options[0];
  if (!choice) return null;
  choice.dataset.matrixChoice = '1';
  return choice.innerText.trim().slice(0, 40);
});

/** Works one control. Returns a description of what was done, or null if it could not be reached any more. */
export async function operate(page, control) {
  const node = locate(page, control.key);
  if (!(await node.count())) return null;
  await node.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
  switch (control.kind) {
    case 'toggle':
      await node.click({ timeout: 3000 });
      return 'toggled';
    case 'button':
      await node.click({ timeout: 3000 });
      return 'clicked';
    case 'section':
      // Closes and opens again, so the controls inside it are worked too.
      await node.click({ timeout: 3000 });
      await node.click({ timeout: 3000 });
      return 'folded';
    case 'range': {
      await node.focus();
      for (let step = 0; step < 3; step += 1) await page.keyboard.press(Number(control.value) > 0.5 ? 'ArrowLeft' : 'ArrowRight');
      await page.keyboard.press('Tab');
      return 'stepped';
    }
    case 'color': {
      const next = control.value.toLowerCase() === '#336699' ? '#993366' : '#336699';
      await node.evaluate((input, value) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }, next);
      return `colour ${next}`;
    }
    case 'field': {
      const current = control.value.replace(',', '.').trim();
      const number = Number(current);
      if (current === '' || !Number.isFinite(number)) {
        await node.fill(`${control.value}x`);
      } else {
        await node.fill(String(Math.round((number + (Math.abs(number) >= 4 ? 2 : 0.25)) * 100) / 100));
      }
      await page.keyboard.press('Enter');
      await page.keyboard.press('Tab');
      return 'typed';
    }
    case 'textarea':
      await node.click({ timeout: 3000 });
      await page.keyboard.press('Control+End');
      await page.keyboard.type('m', { delay: 8 });
      await node.evaluate(field => field.blur());
      return 'typed';
    case 'select': {
      const next = await node.evaluate(field => [...field.options].find(option => !option.selected && !option.disabled)?.value ?? null);
      if (next === null) return 'one option';
      await node.selectOption(next);
      return `chose ${next}`;
    }
    case 'combobox':
    case 'menu': {
      await node.click({ timeout: 3000 });
      await page.waitForTimeout(80);
      const label = await otherOption(page);
      if (!label) { await page.keyboard.press('Escape'); return 'empty list'; }
      await page.locator('[data-matrix-choice="1"]').first().click({ timeout: 3000 });
      return `chose ${label}`;
    }
    default:
      throw new Error(`unknown control kind for ${control.key}`);
  }
}
