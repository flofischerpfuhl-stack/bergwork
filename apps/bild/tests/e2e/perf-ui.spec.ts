import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { mountForTest } from './helpers';

type Measurement = {
  frameMs: { median: number; p95: number; max: number };
  snapshot: {
    renders: Record<string, number>;
    sessionNotifications: Record<string, number>;
    workspaceNotifications: number;
    thumbnails: { renders: number; draws: number; previewRequests: number; cacheHits: number; builds: number };
    longTasks: { supported: boolean; count: number; totalMs: number; maxMs: number };
  };
};

test('UI interactions keep renders and thumbnail work bounded', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mountForTest(page);
  const result = await page.evaluate(async () => {
    const runtime = window as any;
    const load = (path: string): Promise<any> => import(/* @vite-ignore */ path);
    const { Raster } = await load('/src/core/raster.ts');
    const { makeTransform } = await load('/src/core/geometry.ts');
    const { newLayer } = await load('/src/core/document.ts');
    const controller = runtime.__editorForTests;
    const session = controller.session;
    await runtime.__handle.newProject({ name: 'UI performance', width: 128, height: 128 });
    const layers = Array.from({ length: 80 }, (_, index) => {
      const pixels = new Uint8Array(64 * 64 * 4);
      for (let at = 0; at < pixels.length; at += 4) {
        pixels[at] = (index * 17) & 255;
        pixels[at + 1] = (index * 29) & 255;
        pixels[at + 2] = (index * 43) & 255;
        pixels[at + 3] = 255;
      }
      return newLayer({ id: `ui-${index}`, name: `UI Layer ${index}`, visible: index === 79, raster: Raster.fromPixels(64, 64, 4, pixels),
        transform: makeTransform({ x: (index % 8) * 4, y: (index % 10) * 3 }, { width: 64, height: 64 }) });
    });
    session.replaceDocument({ ...session.document, layers });
    session.selectLayer('ui-79');
    session.notify('document');
    // The Lite profile installs two eager and eight idle-loaded panel registrations. Keep that
    // one-time module installation outside steady-state interaction samples.
    while (controller.panels.length < 10) await new Promise<void>((resolve) => setTimeout(resolve, 20));
    const settle = async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    };
    await settle();

    const percentile = (values: number[], fraction: number) => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
    };
    const measure = async (steps: number, action: (index: number) => void): Promise<Measurement> => {
      await settle();
      runtime.__editorUiPerformance.start();
      const frames: number[] = [];
      for (let index = 0; index < steps; index++) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => {
          const started = performance.now();
          action(index);
          requestAnimationFrame(() => { frames.push(performance.now() - started); resolve(); });
        }));
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const snapshot = runtime.__editorUiPerformance.snapshot();
      runtime.__editorUiPerformance.stop();
      return { frameMs: { median: percentile(frames, 0.5), p95: percentile(frames, 0.95), max: Math.max(...frames) }, snapshot };
    };

    const pan = await measure(24, (index) => {
      session.viewport.translate(index % 2 ? -5 : 5, 2);
      session.notify('view');
    });

    session.beginOpacityEdit();
    const slider = await measure(20, (index) => {
      session.setLayerOpacity((99 - index) / 100);
    });
    session.finishOpacityEdit();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const brush = await load('/src/core/brush/index.ts');
    session.selectTool('brush');
    brush.setBrushSettings(session, { ...brush.getBrushSettings(session), diameter: 24, hardness: 0.5 });
    brush.beginBrushStroke(session, { x: 40, y: 40 });
    const stroke = await measure(20, (index) => {
      brush.extendBrushStroke(session, { x: 45 + index * 4, y: 45 + index * 3 });
    });
    brush.finishBrushStroke(session);
    await brush.waitForBrushStroke(session);
    await settle();
    const strokePixel = Array.from(session.activeLayer.raster.readRegion(40, 40, 1, 1));

    const toolSwitch = await measure(1, () => {
      document.querySelector<HTMLElement>('[data-testid="tool-move"]')!.click();
    });
    const menuOpen = await measure(1, () => {
      document.querySelector<HTMLElement>('[data-testid="menu-File"]')!.click();
    });
    controller.ui.setState({ openMenu: null });
    const panelSwitch = await measure(2, (index) => {
      document.querySelector<HTMLElement>(index ? '[data-testid="tab-layers"]' : '[data-testid="tab-history"]')!.click();
    });
    const firstTab = controller.workspace.selectedId;
    const secondTab = controller.workspace.addTab(false);
    secondTab.session.createNewProject(128, 128, 'Second UI tab');
    controller.workspace.select(firstTab);
    await settle();
    const tabSwitch = await measure(2, (index) => controller.workspace.select(index ? firstTab : secondTab.id));
    const dialogOpen = await measure(1, () => controller.showDialog({ kind: 'newCanvas' }));
    controller.showDialog(null);

    const gl = controller.canvasView.gpu?.gl as WebGL2RenderingContext | undefined;
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    return {
      renderer: gl ? gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER) : controller.canvasView.rendererKind,
      layerCount: session.document.layers.length,
      activeOpacity: session.activeLayer.opacity,
      strokePixel,
      pan, slider, stroke, toolSwitch, menuOpen, panelSwitch, tabSwitch, dialogOpen,
    };
  });

  console.log(`PERF_UI ${JSON.stringify({ project: testInfo.project.name, ...result })}`);
  if (process.env.PERF_UI_RECORD) fs.writeFileSync(process.env.PERF_UI_RECORD, JSON.stringify({ project: testInfo.project.name, ...result }, null, 2));
  expect(result.layerCount).toBe(80);
  expect(result.activeOpacity).toBeCloseTo(0.8, 5);
  expect(result.strokePixel).not.toEqual([(79 * 17) & 255, (79 * 29) & 255, (79 * 43) & 255, 255]);
  expect(result.pan.snapshot.thumbnails.builds).toBe(0);
  expect(result.pan.snapshot.renders.LayerRow ?? 0).toBe(0);
  expect(result.slider.snapshot.renders.LayerRow ?? 0).toBe(0);
  expect(result.slider.snapshot.renders.CanvasThumbnail ?? 0).toBe(0);
  expect(result.stroke.snapshot.renders.LayerRow ?? 0).toBe(0);
  expect(result.stroke.snapshot.renders.CanvasThumbnail ?? 0).toBe(0);
  expect(result.toolSwitch.snapshot.renders.LayerRow ?? 0).toBe(0);
  expect(result.panelSwitch.snapshot.renders.LayerRow ?? 0).toBe(0);
  expect(result.panelSwitch.snapshot.thumbnails.draws).toBe(0);
});
