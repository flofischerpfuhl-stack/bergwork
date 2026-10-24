import { createRichTextDocument } from './rich-text-document.js';

function embeddedStyle(style, resource) {
  return {
    ...style,
    resourceId: resource.resourceId,
    family: resource.family,
    weight: resource.weight,
    style: resource.style,
  };
}

/** Replaces the face of every character while retaining canonical text,
 * paragraph layout, sizes, and colors. This deliberately removes Base14
 * resources from a whole-object embedded-font conversion. */
export function replaceRichTextDocumentWholeFont(document, resource) {
  if (!document || !resource || resource.kind !== 'embedded') {
    throw new TypeError('A canonical rich document and embedded font face are required.');
  }
  const canonical = createRichTextDocument(document);
  const next = createRichTextDocument({
    ...canonical,
    fontResources: [resource],
    defaultCharacterStyle: embeddedStyle(canonical.defaultCharacterStyle, resource),
    runs: canonical.runs.map(run => ({
      start: run.start,
      end: run.end,
      style: embeddedStyle(run.style, resource),
    })),
  });
  return { version: 1, ...next };
}
