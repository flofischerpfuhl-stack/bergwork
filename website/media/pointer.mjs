// A visible pointer for headless screen recordings: Chromium draws none, so an overlay follows the real pointer
// events, and `glide` moves the mouse in small steps the way a hand would.

/** Init script: an arrow that tracks mousemove and dips on mousedown. Runs in the page. */
export function cursorOverlay() {
  const install = () => {
    const arrow = document.createElement('div');
    arrow.setAttribute('aria-hidden', 'true');
    arrow.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;'
      + 'transform:translate(-100px,-100px);transition:scale 80ms;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))';
    arrow.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 2l15 11-6.5 1.2L16 21l-3 1.4-3.6-6.9L4 20z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    document.documentElement.append(arrow);
    addEventListener('mousemove', (event) => { arrow.style.transform = `translate(${event.clientX - 3}px, ${event.clientY - 2}px)`; }, true);
    addEventListener('mousedown', () => { arrow.style.scale = '0.85'; }, true);
    addEventListener('mouseup', () => { arrow.style.scale = '1'; }, true);
  };
  if (document.documentElement) install(); else addEventListener('DOMContentLoaded', install);
}

let last = { x: 960, y: 540 };

/** Moves the mouse to the centre of a locator (or a point) over ~0.6 s. */
export async function glide(page, target, steps = 30) {
  const box = typeof target.boundingBox === 'function' ? await target.boundingBox() : null;
  const point = box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : target;
  await page.mouse.move(last.x, last.y);
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    await page.mouse.move(last.x + (point.x - last.x) * ease, last.y + (point.y - last.y) * ease);
    await page.waitForTimeout(16);
  }
  last = point;
  await page.waitForTimeout(150);
}
