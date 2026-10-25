import { access } from 'node:fs/promises';
import path from 'node:path';
import { escapeHtml } from './html.mjs';

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export async function prepareMedia(media, sourceDir, fingerprintAsset, warnings) {
  const prepared = new Map();
  for (const slot of media) {
    const source = path.join(sourceDir, slot.file);
    const posterSource = slot.poster ? path.join(sourceDir, slot.poster) : null;
    if (!(await exists(source)) || (posterSource && !(await exists(posterSource)))) {
      warnings.push(`Missing media slot ${slot.id}: ${slot.file}${slot.poster ? ` + ${slot.poster}` : ''}`);
      continue;
    }

    const file = await fingerprintAsset(source, `media/${slot.file}`);
    const poster = posterSource ? await fingerprintAsset(posterSource, `media/${slot.poster}`) : null;
    let webp = null;
    if (slot.kind === 'image') {
      const candidate = source.replace(/\.[^.]+$/, '.webp');
      if (await exists(candidate)) webp = await fingerprintAsset(candidate, `media/${path.basename(candidate)}`);
    }
    prepared.set(slot.id, { ...slot, file, poster, webp });
  }
  return prepared;
}

/**
 * One screenshot or one short take. Media are made at 2× (media.json gives their pixel size), so they are marked as
 * 2× and never shown larger than they are sharp. Videos play muted in a loop while they are on screen (site.js) and
 * carry their own pause button; with reduced motion they stay on the poster until the button is pressed.
 */
export function renderMedia(slot) {
  if (!slot) return '';
  const caption = slot.caption ? `<figcaption>${escapeHtml(slot.caption)}</figcaption>` : '';
  if (slot.kind === 'video') {
    return `<figure class="media-frame media-frame--video">
      <video muted loop playsinline preload="none" width="${Math.round(slot.width / 2)}" height="${Math.round(slot.height / 2)}" poster="${slot.poster}" data-in-view-video aria-label="${escapeHtml(slot.alt)}">
        <source src="${slot.file}" type="video/mp4" />
      </video>
      <button class="video-toggle" type="button" data-video-toggle aria-label="Pause the recording" hidden><span aria-hidden="true"></span></button>
      ${caption}
    </figure>`;
  }
  return `<figure class="media-frame">
    <picture>${slot.webp ? `<source srcset="${slot.webp} 2x" type="image/webp" />` : ''}<img src="${slot.file}" srcset="${slot.file} 2x" alt="${escapeHtml(slot.alt)}" width="${Math.round(slot.width / 2)}" height="${Math.round(slot.height / 2)}" loading="lazy" decoding="async" /></picture>
    ${caption}
  </figure>`;
}

/** A small picture (or two stacked) next to a short explanation. `body` is trusted HTML from the page module. */
export function featureRow(slots, title, body, { actions = '' } = {}) {
  const list = (Array.isArray(slots) ? slots : [slots]).filter(Boolean);
  if (!list.length) return '';
  return `<article class="feature-row">
    <div class="feature-row-media">${list.map(renderMedia).join('')}</div>
    <div class="feature-row-text">
      <h3>${escapeHtml(title)}</h3>
      ${body}
      ${actions}
    </div>
  </article>`;
}
