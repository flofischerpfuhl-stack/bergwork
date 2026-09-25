if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}

const ua = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent;
const detectedOs = /win/i.test(ua) ? 'windows' : /mac/i.test(ua) ? 'macos' : /linux|x11/i.test(ua) ? 'linux' : '';
if (detectedOs) document.documentElement.dataset.os = detectedOs;

for (const button of document.querySelectorAll('[data-copy]')) {
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy || '');
      button.textContent = 'Copied';
      window.setTimeout(() => { button.textContent = 'Copy'; }, 1600);
    } catch {
      button.textContent = 'Select the digest';
    }
  });
}

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const videos = [...document.querySelectorAll('[data-in-view-video]')];
if (videos.length && 'IntersectionObserver' in window) {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting && !reducedMotion.matches) entry.target.play().catch(() => {});
      else entry.target.pause();
    }
  }, { threshold: 0.6 });
  for (const video of videos) observer.observe(video);
}
