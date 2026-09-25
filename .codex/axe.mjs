import { chromium } from '/home/oem/Dokumente/003_Projekte/17_fernwork/node_modules/playwright/index.mjs';
const b = await chromium.launch();
for (const f of ['index.html', 'impressum.html', 'datenschutz.html']) {
  const p = await b.newPage();
  await p.goto('http://127.0.0.1:8731/' + f);
  await p.addScriptTag({ path: '/home/oem/Dokumente/003_Projekte/10_himmelcad/node_modules/axe-core/axe.min.js' });
  const r = await p.evaluate(async () => (await axe.run()).violations.map(v => v.id + ': ' + v.nodes.map(n => n.target.join(' ') + ' ' + n.any.map(a => a.message).join(';')).slice(0, 3).join(' | ')));
  console.log(f, r.length ? r : 'axe OK');
}
await b.close();
