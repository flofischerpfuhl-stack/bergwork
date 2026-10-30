// berg:work: the values the text controls offer, in one place, so tests/unit/ui-engine-contract.test.mjs can hold them
// against what the layout and the worker accept. A control must never offer a value the engine refuses.
import { TEXT_BLOCK_ALIGNMENTS, TEXT_BLOCK_OVERFLOW_POLICIES, TEXT_BLOCK_VERTICAL_ALIGNMENTS } from './text-layout.js';

export const TEXT_ALIGNMENT_OFFERS = Object.freeze([
  Object.freeze(['left', 'align-left', 'Align text left']),
  Object.freeze(['center', 'align-center', 'Center text']),
  Object.freeze(['right', 'align-right', 'Align text right']),
  Object.freeze(['justify', 'align-justify', 'Justify text']),
]);

export const TEXT_VERTICAL_OFFERS = Object.freeze([
  Object.freeze({ value: 'top', label: 'Top' }),
  Object.freeze({ value: 'middle', label: 'Middle' }),
  Object.freeze({ value: 'bottom', label: 'Bottom' }),
]);

export const TEXT_OVERFLOW_OFFERS = Object.freeze([
  Object.freeze({ value: 'visible', label: 'Show overflow' }),
  Object.freeze({ value: 'clip', label: 'Clip frame (keep text)' }),
]);

/** The alignment buttons for a worker build. A worker without justified text blocks refuses 'justify', so it has no
 * button; `features` is the open session's `features`. */
export function textBlockAlignmentChoices(features = {}) {
  return TEXT_ALIGNMENT_OFFERS.filter(([value]) => value !== 'justify' || features?.justifiedTextBlocks === true);
}

export const TEXT_ENGINE_VALUES = Object.freeze({
  alignments: TEXT_BLOCK_ALIGNMENTS,
  verticalAlignments: TEXT_BLOCK_VERTICAL_ALIGNMENTS,
  overflowPolicies: TEXT_BLOCK_OVERFLOW_POLICIES,
});
