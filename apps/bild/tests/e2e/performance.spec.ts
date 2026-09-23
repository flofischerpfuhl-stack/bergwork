import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { mountForTest } from './helpers';

/**
 * Measured (not asserted) canvas performance on this machine's GPU, following STACK.md targets:
 * desktop 4096×4096 with 10 raster layers, pan/zoom p95 frame ≤ 33 ms after warm-up, brush
 * feedback ≤ 50 ms. Results go to artifacts/performance/browser.json with the renderer string.
 * The project `perf-gpu` launches Chromium on the real GPU; under SwiftShader numbers are software.
 */
test('canvas pan, zoom and brush feedback on 4096² × 10 layers', async ({ page }, info) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await mountForTest(page);
  const result = await page.evaluate(async () => {
    const w = window as any;
    const load = (p: string): Promise<any> => import(/* @vite-ignore */ p);
    const { Raster } = await load('/src/core/raster.ts');
    const { newLayer } = await load('/src/core/document.ts');
    const { makeTransform } = await load('/src/core/geometry.ts');
    const handle = w.__handle;
    await handle.newProject({ name: 'Perf', width: 4096, height: 4096 });
    const size = 4096;
    const modes = ['normal', 'multiply', 'screen', 'overlay', 'normal', 'darken', 'lighten', 'normal', 'difference', 'normal'];
    const layers = [];
    for (let i = 0; i < 10; i++) {
      const data = new Uint8Array(size * size * 4);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const o = (y * size + x) * 4;
          data[o] = (x * (i + 1)) & 255; data[o + 1] = (y * (i + 2)) & 255; data[o + 2] = ((x ^ y) * (i + 3)) & 255;
          data[o + 3] = i === 0 ? 255 : 160 + ((x + y + i * 37) & 63);
        }
      }
      layers.push(newLayer({ id: `P${i}`, name: `Layer ${i}`, raster: Raster.fromPixels(size, size, 4, data),
        transform: makeTransform({ x: 0, y: 0 }, { width: size, height: size }), blendMode: modes[i] }));
    }
    const editor = w.__editorForTests;
    const session = editor.session;
    session.replaceDocument({ ...session.document, layers });
    session.notify('document');
    const view = editor.canvasView;
    for (let i = 0; i < 5; i++) view.renderNow(); // upload and warm-up
    const p95 = (values: number[]) => { const s = [...values].sort((a, b) => a - b); return s[Math.floor(s.length * 0.95)]!; };
    const median = (values: number[]) => { const s = [...values].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };
    const measure = (frames: number, step: (i: number) => void) => {
      const times: number[] = [];
      for (let i = 0; i < frames; i++) { step(i); times.push(view.renderNow()); }
      return { p95: p95(times), median: median(times), max: Math.max(...times) };
    };
    session.fit();
    const pan = measure(90, (i) => { session.viewport.translate(i % 30 < 15 ? 7 : -7, 3 * Math.sin(i / 5)); });
    const zoom = measure(90, (i) => {
      const center = session.viewport.center;
      session.viewport.setZoom(session.viewport.zoom * (i % 30 < 15 ? 1.04 : 1 / 1.04), center, session.document);
    });
    session.viewport.setZoom(2, session.viewport.center, session.document);
    const zoomed = measure(60, (i) => { session.viewport.translate(i % 20 < 10 ? 11 : -11, 0); });
    session.fit();
    // Brush feedback: time from a pointer sample to the frame showing it, 300 px soft brush. The
    // upstream 100-megapixel document budget forbids painting in the 167 Mpx scene above, so the
    // brush runs with five of the layers (84 Mpx).
    session.replaceDocument({ ...session.document, layers: layers.slice(0, 5) });
    session.notify('document');
    view.renderNow();
    const brush = await load('/src/core/brush/index.ts');
    session.selectLayer('P4');
    session.selectTool('brush');
    brush.setBrushSettings(session, { ...brush.getBrushSettings(session), diameter: 300, hardness: 0 });
    const feedback: number[] = [], cpu: number[] = [], render: number[] = [];
    brush.beginBrushStroke(session, { x: 500, y: 500 });
    for (let i = 1; i <= 60; i++) {
      const t0 = performance.now();
      brush.extendBrushStroke(session, { x: 500 + i * 40, y: 500 + i * 30 });
      const t1 = performance.now();
      view.renderNow();
      const t2 = performance.now();
      feedback.push(t2 - t0); cpu.push(t1 - t0); render.push(t2 - t1);
    }
    brush.finishBrushStroke(session);
    const gl = view.gpu.gl as WebGL2RenderingContext;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const memory = (performance as any).memory;
    return {
      renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
      floatTargets: view.gpu.floatTargets,
      panMs: pan, zoomMs: zoom, panAt200PercentMs: zoomed,
      brushFeedbackMs: { p95: p95(feedback), median: median(feedback), max: Math.max(...feedback) },
      brushEngineMs: { p95: p95(cpu), median: median(cpu) },
      brushRenderMs: { p95: p95(render), median: median(render) },
      jsHeapUsedMB: memory ? Math.round(memory.usedJSHeapSize / 1048576) : null,
      estimatedGpuTextureMB: Math.round(10 * 4096 * 4096 * 4 * 4 / 3 / 1048576),
      notes: 'Pan/zoom scene built directly (167 Mpx exceeds the upstream 100 Mpx import budget); brush measured with 5 layers (84 Mpx).',
    };
  });
  const out = path.resolve('artifacts/performance');
  fs.mkdirSync(out, { recursive: true });
  const record = { project: info.project.name, date: new Date().toISOString(), targets: { panZoomP95Ms: 33, brushFeedbackMs: 50 }, ...result };
  fs.writeFileSync(path.join(out, `browser-${info.project.name}.json`), JSON.stringify(record, null, 2));
  console.log(JSON.stringify(record, null, 2));
  expect(result.panMs.p95).toBeGreaterThan(0);
});
