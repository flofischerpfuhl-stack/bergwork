// The appearance before first paint (same rule as @bergwork/ui applyAppearance), so a light desktop does not flash
// dark; the title bar's appearance menu takes over once the page runs. A file, not inline: the web CSP allows no
// inline scripts.
try {
  const a = JSON.parse(localStorage.getItem('bergwork.appearance') || 'null') || {};
  const light = a.theme === 'light' || (a.theme !== 'dark' && matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  document.documentElement.dataset.corners = a.corners === 'sharp' ? 'sharp' : 'round';
} catch {}
