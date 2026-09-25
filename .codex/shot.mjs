import { chromium } from '/home/oem/Dokumente/003_Projekte/17_fernwork/node_modules/playwright/index.mjs';
const out = '/home/oem/Dokumente/003_Projekte/21_bergwork/website/.check-out';
const b = await chromium.launch();
for (const w of [1440, 768, 360]) {
  const p = await b.newPage({ viewport: { width: w, height: w === 1440 ? 900 : w === 768 ? 1024 : 780 } });
  await p.goto('http://127.0.0.1:8731/index.html'); await p.evaluate(() => document.fonts.ready);
  await p.screenshot({ path: `${out}/hero-${w}.png` });
  await p.screenshot({ path: `${out}/site-${w}.png`, fullPage: true });
  const ov = await p.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  console.log(w, 'overflow', ov);
}
await b.close();
{
  const b2 = await chromium.launch();
  const p = await b2.newPage({ viewport: { width: 360, height: 780 } });
  await p.goto('http://127.0.0.1:8731/index.html'); await p.evaluate(() => document.fonts.ready);
  console.log(await p.evaluate(() => [...document.querySelectorAll('body *')].filter(e => e.scrollWidth > e.clientWidth + 0 && getComputedStyle(e).overflowX !== 'hidden').slice(0, 12).map(e => e.tagName + '.' + e.className + ' ' + e.scrollWidth + '/' + e.clientWidth)));
  await b2.close();
}
