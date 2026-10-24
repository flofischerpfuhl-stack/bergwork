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

// Short takes play muted while they are on screen. The button pauses and resumes; under reduced motion they wait for it.
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const videos = [...document.querySelectorAll('[data-in-view-video]')];
for (const video of videos) {
  const toggle = video.parentElement.querySelector('[data-video-toggle]');
  if (!toggle) continue;
  toggle.hidden = false;
  const show = () => {
    const paused = video.paused;
    toggle.dataset.state = paused ? 'paused' : 'playing';
    toggle.setAttribute('aria-label', paused ? 'Play the recording' : 'Pause the recording');
  };
  video.addEventListener('play', show);
  video.addEventListener('pause', show);
  toggle.addEventListener('click', () => {
    if (video.paused) { video.dataset.userPaused = ''; video.play().catch(() => {}); }
    else { video.dataset.userPaused = 'true'; video.pause(); }
  });
  show();
}
if (videos.length && 'IntersectionObserver' in window) {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const video = entry.target;
      if (entry.isIntersecting && !reducedMotion.matches && video.dataset.userPaused !== 'true') video.play().catch(() => {});
      else if (!entry.isIntersecting) video.pause();
    }
  }, { threshold: 0.5 });
  for (const video of videos) observer.observe(video);
}
