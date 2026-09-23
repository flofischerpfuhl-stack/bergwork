import { describe, expect, it } from 'vitest';
import { Raster } from '../../src/core/raster';
import { EditorSession } from '../../src/core/session';
import { rectangleSelection } from '../../src/core/selectionOps';
import { boxMean, guidedFilter, refineGuidedMask } from '../../src/core/subject/guidedMatte';
import {
  BIREFNET_INPUT_SIZE, countMaskComponents, postprocessBiRefNet, postprocessU2Net, preprocessBiRefNet,
  preprocessU2Net, refineSubjectMask, SUBJECT_INPUT_SIZE,
} from '../../src/core/subject/maskProcessing';
import {
  removeBackground, subjectCommands, subjectRemovalState, type RemoveBackgroundOptions,
} from '../../src/core/subject/commands';
import { SubjectInferenceError, type SubjectInferenceResult } from '../../src/workers/subjectClient';

function rgba(width: number, height: number, color: readonly [number, number, number, number]): Raster {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) pixels.set(color, i * 4);
  return Raster.fromPixels(width, height, 4, pixels);
}

const timing = { downloadMs: 5, modelLoadMs: 10, inferenceMs: 20, refinementMs: 2, modelBytes: 100,
  modelCacheHit: false, estimatedBytes: 1234, backend: 'wasm' as const };

function fakeInference(mask: readonly number[], delay = 0): NonNullable<RemoveBackgroundOptions['inference']> {
  const result = async (): Promise<SubjectInferenceResult> => {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    return { mask: Uint8Array.from(mask), timing, componentCount: 1 };
  };
  return { infer: result, refine: result };
}

describe('GuidedMatte.swift', () => {
  it('GuidedMatte.box replicates edge samples in both running-sum passes', () => {
    const result = boxMean(new Float32Array([0, 0, 1]), 3, 1, 1);
    expect(result[0]).toBe(0);
    expect(result[1]).toBeCloseTo(1 / 3, 6);
    expect(result[2]).toBeCloseTo(2 / 3, 6);
  });

  it('GuidedMatte.filter becomes two box passes when the guide is constant', () => {
    const mask = new Float32Array([0, 0, 1, 1, 1]);
    const result = guidedFilter(mask, new Float32Array(5).fill(0.5), 5, 1, 1);
    const expected = [1 / 9, 1 / 3, 2 / 3, 8 / 9, 1];
    result.forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, 5));
  });

  it('GuidedMatte.refine scales its working copy and returns 8-bit full-size coverage', () => {
    const mask = Uint8Array.from([0, 0, 255, 255, 0, 0, 255, 255]);
    const guide = rgba(4, 2, [128, 128, 128, 255]).toPixels();
    const result = refineGuidedMask(mask, guide, 4, 2, 2, 2);
    expect(result).toHaveLength(8);
    expect(result[0]).toBeLessThan(result[3]!);
    expect(result.every((value) => value >= 0 && value <= 255)).toBe(true);
  });
});

describe('U²-Net processing', () => {
  it('preprocesses to NCHW with upstream max-value and ImageNet normalization', () => {
    const result = preprocessU2Net(Uint8Array.from([255, 128, 0, 255]), 1, 1);
    const plane = SUBJECT_INPUT_SIZE ** 2;
    expect(result).toHaveLength(plane * 3);
    expect(result[0]).toBeCloseTo((1 - 0.485) / 0.229, 5);
    expect(result[plane]).toBeCloseTo((128 / 255 - 0.456) / 0.224, 5);
    expect(result[plane * 2]).toBeCloseTo((0 - 0.406) / 0.225, 5);
  });

  it('min-max normalizes and scales the fused output with pixel-centred bilinear sampling', () => {
    const output = new Float32Array(SUBJECT_INPUT_SIZE ** 2);
    for (let y = 0; y < SUBJECT_INPUT_SIZE; y++) for (let x = 0; x < SUBJECT_INPUT_SIZE; x++) {
      output[y * SUBJECT_INPUT_SIZE + x] = x;
    }
    const result = postprocessU2Net(output, 2, 2);
    expect(Array.from(result.pixels)).toEqual([64, 191, 64, 191]);
    expect(result.dynamicRange).toBe(319);
  });

  it('ports advanced matte contrast after optional edge refinement', () => {
    const source = Uint8Array.from([96, 127, 128, 160]);
    const guide = rgba(4, 1, [128, 128, 128, 255]).toPixels();
    const result = refineSubjectMask(source, guide, 4, 1,
      { quality: 'advanced', refineEdges: 0, matteContrast: 100, shiftEdge: 0 });
    expect(Array.from(result)).toEqual([0, 103, 152, 255]);
  });
});

describe('BiRefNet processing and Vision instance emulation', () => {
  it('preprocesses a 1024² BiRefNet tensor with RGB ImageNet normalization', () => {
    const result = preprocessBiRefNet(Uint8Array.from([255, 128, 0, 255]), 1, 1);
    const plane = BIREFNET_INPUT_SIZE ** 2;
    expect(result).toHaveLength(plane * 3);
    expect(result[0]).toBeCloseTo((1 - 0.485) / 0.229, 5);
    expect(result[plane]).toBeCloseTo((128 / 255 - 0.456) / 0.224, 5);
    expect(result[plane * 2]).toBeCloseTo(-0.406 / 0.225, 5);
  });

  it('applies sigmoid to BiRefNet logits without min-max changing its alpha confidence', () => {
    const output = new Float32Array(BIREFNET_INPUT_SIZE ** 2);
    const result = postprocessBiRefNet(output, 1, 1);
    expect(result.pixels[0]).toBe(128);
    expect(result.dynamicRange).toBe(0);
  });

  it('counts 8-connected final-mask components while retaining every foreground pixel', () => {
    const mask = Uint8Array.from([
      255, 0, 0, 0, 255,
      0, 255, 0, 0, 255,
      0, 0, 255, 0, 0,
    ]);
    const before = mask.slice();
    expect(countMaskComponents(mask, 5, 3)).toBe(2);
    expect(mask).toEqual(before);
  });
});

describe('Remove Background state machine (Filters.swift commitBackgroundMask)', () => {
  it('previews a mask, applies it without changing pixels, and records one named undo step', async () => {
    const session = new EditorSession();
    session.createNewProject(2, 2);
    const id = session.insertRaster(rgba(2, 2, [20, 40, 60, 255]), 'image');
    const source = session.layer(id)!.raster;
    const inference = fakeInference([255, 200, 10, 0]);
    const state = await removeBackground(session, { action: 'begin', inference });
    expect(state.phase).toBe('ready');
    expect(state.componentCount).toBe(1);
    expect(session.maskOverrides.get(id)?.toPixels()).toEqual(Uint8Array.from([255, 200, 10, 0]));
    await removeBackground(session, { action: 'apply' });
    expect(session.layer(id)!.raster).toBe(source);
    expect(session.layer(id)!.mask?.raster.toPixels()).toEqual(Uint8Array.from([255, 200, 10, 0]));
    expect(session.layer(id)!.mask).toMatchObject({ enabled: true, placement: null, linked: true });
    expect(session.isMaskSelected).toBe(true);
    expect(session.history.undoName).toBe('Remove Background');
  });

  it('selects the best model and forwards host model URL overrides and download bytes', async () => {
    const session = new EditorSession();
    session.createNewProject(2, 1);
    session.insertRaster(rgba(2, 1, [20, 40, 60, 255]), 'image');
    let chosen: unknown[] = [];
    const inference: NonNullable<RemoveBackgroundOptions['inference']> = {
      infer: async (...args) => {
        chosen = args;
        args[8]?.({ stage: 'downloading-model', progress: 0.5, downloadedBytes: 50, totalBytes: 100 });
        return { mask: Uint8Array.from([255, 0]), timing, componentCount: 1 };
      },
      refine: async () => ({ mask: Uint8Array.from([255, 0]), timing, componentCount: 1 }),
    };
    const state = await removeBackground(session, {
      model: 'best', modelUrls: { best: 'https://models.example/birefnet.onnx' }, inference,
    });
    expect(chosen[6]).toBe('best');
    expect(chosen[7]).toEqual({ best: 'https://models.example/birefnet.onnx' });
    expect(state).toMatchObject({ model: 'best', downloadedBytes: 50, totalBytes: 100, componentCount: 1 });
  });

  it('multiplies an existing local mask and changes only selected layer pixels', async () => {
    const session = new EditorSession();
    session.createNewProject(4, 1);
    const id = session.insertRaster(rgba(4, 1, [20, 40, 60, 255]), 'image');
    session.setMaskFromRaster(Raster.fromPixels(4, 1, 1, [255, 128, 64, 0]), 'mask', false);
    session.isMaskSelected = false;
    session.document = { ...session.document!, selection: rectangleSelection({ x: 1, y: 0, width: 2, height: 1 }, { width: 4, height: 1 }) };
    await removeBackground(session, { inference: fakeInference([0, 128, 255, 255]) });
    await removeBackground(session, { action: 'apply' });
    expect(session.layer(id)!.mask?.raster.toPixels()).toEqual(Uint8Array.from([255, 64, 64, 0]));
  });

  it('discards a result after Cancel and exposes command enablement', async () => {
    const session = new EditorSession();
    session.createNewProject(1, 1);
    const id = session.insertRaster(rgba(1, 1, [255, 0, 0, 255]), 'image');
    expect(subjectCommands(session).removeBackground.enabled()).toBe(true);
    const pending = removeBackground(session, { inference: fakeInference([255], 5) });
    await removeBackground(session, { action: 'cancel' });
    await pending;
    expect(subjectRemovalState(session).phase).toBe('idle');
    expect(session.maskOverrides.has(id)).toBe(false);
    expect(session.layer(id)!.mask).toBeNull();
  });

  it('surfaces the upstream no-subject message and leaves the document unchanged', async () => {
    const session = new EditorSession();
    session.createNewProject(1, 1);
    const id = session.insertRaster(rgba(1, 1, [0, 0, 0, 255]), 'image');
    const inference: NonNullable<RemoveBackgroundOptions['inference']> = {
      infer: async () => { throw new Error('No foreground subject was detected in this layer. Try an image with a more distinct subject.'); },
      refine: async () => { throw new Error('unused'); },
    };
    const state = await removeBackground(session, { inference });
    expect(state.phase).toBe('error');
    expect(state.error).toContain('No foreground subject was detected');
    expect(session.layer(id)!.mask).toBeNull();
  });

  it('reports resumable model-download failures with the saved byte offset', async () => {
    const session = new EditorSession();
    session.createNewProject(1, 1);
    session.insertRaster(rgba(1, 1, [0, 0, 0, 255]), 'image');
    const inference: NonNullable<RemoveBackgroundOptions['inference']> = {
      infer: async () => { throw new SubjectInferenceError('Retry to resume the download.', {
        downloadedBytes: 4096, totalBytes: 8192, resumable: true,
      }); },
      refine: async () => { throw new Error('unused'); },
    };
    const state = await removeBackground(session, { model: 'best', inference });
    expect(state).toMatchObject({ phase: 'error', downloadedBytes: 4096, totalBytes: 8192,
      downloadResumable: true });
  });
});
