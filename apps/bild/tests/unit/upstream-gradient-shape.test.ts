import { describe, expect, it } from 'vitest';
import {
  beginGradient, commitGradient, gradientPreview, pendingGradient, updateGradient,
} from '../../src/core/gradient';
import { beginShape, commitShape, currentShapeDraft, updateShape } from '../../src/core/shape';
import { EditorSession } from '../../src/core/session';

describe('upstream GradientTests and ShapeToolTests', () => {
  it('redraggingReplacesPendingLineWithoutAccumulating', () => {
    const session = new EditorSession(); session.createNewProject(101, 4); session.selectTool('gradient');
    const before = session.document, count = session.history.undoCount;
    expect(beginGradient(session, { x: 0.5, y: 2 })).toBe(true);
    updateGradient(session, { x: 100.5, y: 2 });
    const first = gradientPreview(session)!;
    expect(beginGradient(session, { x: 100.5, y: 2 })).toBe(true);
    updateGradient(session, { x: 0.5, y: 2 });
    const second = gradientPreview(session)!;
    expect(second).not.toBe(first);
    expect(second.pixel(0, 2)[3]).toBeLessThan(first.pixel(0, 2)[3]!);
    expect(session.document).toBe(before);
    expect(session.history.undoCount).toBe(count);
    expect(commitGradient(session)).toBe(true);
    expect(session.history.undoCount).toBe(count + 1);
    expect(pendingGradient(session)).toBeNull();
  });

  it('aClickEscapeOrToolSwitchMakesNoLayer — tool-switch half', () => {
    const session = new EditorSession(); session.createNewProject(100, 80); session.selectTool('shape');
    const before = session.document, count = session.history.undoCount;
    expect(beginShape(session, { x: 20, y: 20 })).toBe(true);
    updateShape(session, { x: 50, y: 50 });
    expect(currentShapeDraft(session)).not.toBeNull();
    session.selectTool('move');
    expect(currentShapeDraft(session)).toBeNull();
    expect(commitShape(session)).toBeNull();
    expect(session.document).toBe(before);
    expect(session.history.undoCount).toBe(count);
  });
});
