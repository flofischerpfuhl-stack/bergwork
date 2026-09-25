import { chromium } from '/home/oem/Dokumente/003_Projekte/17_fernwork/node_modules/playwright/index.mjs';
const out = '/home/oem/Dokumente/003_Projekte/21_bergwork/website/.check-out';
const b = await chromium.launch();
const seen = new Set();
for (const w of [1440, 360]) {
  const p = await b.newPage({ viewport: { width: w, height: w === 1440 ? 900 : 780 } });
  for (const hero of ['mine-dusk', 'mine-day', 'mine-inside', 'mine-winter']) {
    await p.goto('http://127.0.0.1:8731/index.html');
    seen.add(await p.evaluate(() => document.documentElement.dataset.hero));
    await p.evaluate((h) => (document.documentElement.dataset.hero = h), hero);
    await p.evaluate(() => document.fonts.ready);
    await p.waitForTimeout(300);
    await p.screenshot({ path: `${out}/hero-${hero}-${w}.png` });
  }
}
console.log('random picks seen:', [...seen].join(', '));
await b.close();
