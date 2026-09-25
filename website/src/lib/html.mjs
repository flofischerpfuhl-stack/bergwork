export function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function status(label, tone = 'planned') {
  return `<span class="status status--${escapeHtml(tone)}">${escapeHtml(label)}</span>`;
}

export function bulletList(items, className = 'feature-list') {
  return `<ul class="${escapeHtml(className)}">${items.map((item) => `<li>${item}</li>`).join('')}</ul>`;
}

export function sectionHeading(kicker, title, intro = '') {
  return `<div class="section-heading">
    <p class="kicker">${escapeHtml(kicker)}</p>
    <h2>${escapeHtml(title)}</h2>
    ${intro ? `<p>${escapeHtml(intro)}</p>` : ''}
  </div>`;
}
