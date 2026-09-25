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

export function renderMedia(slot) {
  if (!slot) return '';
  const caption = slot.caption ? `<figcaption>${escapeHtml(slot.caption)}</figcaption>` : '';
  if (slot.kind === 'video') {
    return `<figure class="media-frame media-frame--video">
      <video controls muted loop playsinline preload="none" width="${slot.width}" height="${slot.height}" poster="${slot.poster}" data-in-view-video aria-label="${escapeHtml(slot.alt)}">
        <source src="${slot.file}" type="video/mp4" />
      </video>
      ${caption}
    </figure>`;
  }
  return `<figure class="media-frame">
    <picture>${slot.webp ? `<source srcset="${slot.webp}" type="image/webp" />` : ''}<img src="${slot.file}" alt="${escapeHtml(slot.alt)}" width="${slot.width}" height="${slot.height}" loading="lazy" decoding="async" /></picture>
    ${caption}
  </figure>`;
}
