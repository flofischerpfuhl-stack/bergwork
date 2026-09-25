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

// Product mark on a dark app-icon tile; decorative, the product name always follows as text.
export function productMark(src, size = '') {
  return `<span class="product-mark${size ? ` product-mark--${escapeHtml(size)}` : ''}"><img src="${escapeHtml(src)}" alt="" width="256" height="256" /></span>`;
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
