import { describe, expect, it, vi } from 'vitest';
import { makeTransform } from '../../src/core/geometry';
import { OBJECT_SELECT_MODELS, resolveObjectSelectModels } from '../../src/core/objectSelect/models';
import { bestPromptMask } from '../../src/core/objectSelect/postprocess';
import { prepareSlimSamImage } from '../../src/core/objectSelect/preprocess';
import { selectObject, type ObjectSelectionInference } from '../../src/core/objectSelect/selection';
import { Raster } from '../../src/core/raster';
import { EditorSession } from '../../src/core/session';
import type { ModelHost } from '../../src/platform/hosts/types';
import {
  OBJECT_SELECT_GPU_BUFFER_BYTES, objectSelectWasmThreadCount, supportsObjectSelectWebGpu,
} from '../../src/workers/objectSelectRuntime';

describe('EfficientSAM object selection', () => {
  it('uses the highest-IoU mask and retains soft antialiasing around the zero-logit boundary', () => {
    const logits = new Float32Array([
      -2, -2, -2, -2,
      -2, 0, 2, -2,
      2, 2, 2, 2,
    ]);
    const result = bestPromptMask(logits, new Float32Array([0.1, 0.9, 0.3]), 2, 2);
    expect(result.score).toBeCloseTo(0.9);
    expect(Array.from(result.mask)).toEqual([0, 128, 255, 0]);
  });

  it('prepares a bounded CHW tensor for a 12-MP source without per-pixel objects', () => {
    const rgba = new Uint8Array(4000 * 3000 * 4);
    rgba.set([255, 128, 0, 255]);
    const result = prepareSlimSamImage(rgba, 4000, 3000);
    expect([result.width, result.height]).toEqual([1024, 768]);
    expect(result.tensor).toHaveLength(3 * 1024 * 1024);
    expect(result.scaleX).toBeCloseTo(1024 / 4000);
    expect(result.scaleY).toBeCloseTo(768 / 3000);
  });

  it('generated-scene acceptance: one positive click installs a mask with IoU >= 0.9', async () => {
    const width = 64, height = 64, rgba = new Uint8Array(width * height * 4), truth = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const inside = (x - 32) ** 2 + (y - 30) ** 2 <= 15 ** 2, p = (y * width + x) * 4;
      rgba.set(inside ? [230, 80, 40, 255] : [25, 70, 130, 255], p); truth[y * width + x] = inside ? 255 : 0;
    }
    const session = new EditorSession(); session.createNewProject(width, height);
    const id = session.insertRaster(Raster.fromPixels(width, height, 4, rgba), 'generated CC0 fixture');
    session.document = { ...session.document!, layers: session.document!.layers.map((layer) => layer.id === id
      ? { ...layer, transform: makeTransform({ x: 0, y: 0 }, { width, height }) } : layer) };
    const inference: ObjectSelectionInference = { async select(_key, _pixels, w, h, prompts) {
      expect(prompts).toEqual([{ kind: 'point', x: 32, y: 30, positive: true }]);
      return { mask: truth.slice(), width: w, height: h, score: 0.99,
        timing: { encoderMs: 1, decoderMs: 1, refinementMs: 1, backend: 'wasm', threads: 2, embeddingCacheHit: false } };
    } };
    await selectObject(session, [{ kind: 'point', x: 32, y: 30, positive: true }], {
      inference, modelUrls: { encoder: 'blob:encoder', decoder: 'blob:decoder' },
    });
    const selected = session.selection!.mask.toPixels(); let intersection = 0, union = 0;
    for (let i = 0; i < truth.length; i++) {
      const a = selected[i]! >= 128, b = truth[i]! >= 128;
      if (a && b) intersection++; if (a || b) union++;
    }
    expect(intersection / union).toBeGreaterThanOrEqual(0.9);
    expect(session.history.undoName).toBe('Object Selection');
  });

  it('enables a physical-core-sized WASM thread pool only under cross-origin isolation', () => {
    expect(objectSelectWasmThreadCount(false, 8)).toBe(1);
    expect([1, 2, 4, 8, 16].map((cores) => objectSelectWasmThreadCount(true, cores))).toEqual([1, 1, 2, 4, 4]);
  });

  it('requires FP16 and enough GPU buffer capacity before selecting WebGPU', () => {
    expect(supportsObjectSelectWebGpu(true, OBJECT_SELECT_GPU_BUFFER_BYTES,
      OBJECT_SELECT_GPU_BUFFER_BYTES)).toBe(true);
    expect(supportsObjectSelectWebGpu(false, 2 ** 32, 2 ** 32)).toBe(false);
    expect(supportsObjectSelectWebGpu(true, 256 * 1024 * 1024, 2 ** 32)).toBe(false);
  });

  it('has pinned manifests and makes no ModelHost request before explicit resolution', async () => {
    const initiated: boolean[] = [];
    const resolveModel: ModelHost['resolveModel'] = vi.fn(async (request) => {
      initiated.push(request.userInitiated); return { bytes: new Uint8Array([1]), cacheHit: false };
    });
    const host: ModelHost = { version: 1, resolveModel };
    expect(resolveModel).not.toHaveBeenCalled();
    expect(OBJECT_SELECT_MODELS.encoder.sha256).toHaveLength(64);
    expect(OBJECT_SELECT_MODELS.decoder.sha256).toHaveLength(64);
    await resolveObjectSelectModels(host);
    expect(resolveModel).toHaveBeenCalledTimes(2);
    expect(initiated).toEqual([true, true]);
  });
});
