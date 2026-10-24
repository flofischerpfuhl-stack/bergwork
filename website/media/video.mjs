// Turns a Playwright recording into the site's MP4: waiting times (a model loading, a preview rendering) are cut out
// as jump cuts, everything else keeps its real speed. H.264, yuv420p, faststart, plus a PNG poster frame.
import { execFileSync } from 'node:child_process';

/** Marks the stretches to cut, in seconds since the recording started (the page's creation). */
export function cutList() {
  const t0 = Date.now();
  const now = () => (Date.now() - t0) / 1000;
  const cuts = [];
  let from = null;
  return {
    cuts,
    now,
    start() { from = now(); },
    end(keep = 0.4) { if (from !== null) cuts.push([from + keep / 2, now() - keep / 2]); from = null; },
  };
}

export function encode(webm, cuts, mp4, poster, { posterAt = 0.75, maxSeconds = 32 } = {}) {
  const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', webm], { encoding: 'utf8' }));
  const keep = [];
  let at = 0;
  for (const [a, b] of [...cuts].sort((x, y) => x[0] - y[0])) {
    if (b <= a) continue;
    if (a > at) keep.push([at, a]);
    at = Math.max(at, b);
  }
  if (at < duration) keep.push([at, duration]);
  const parts = keep.map(([a, b], i) => `[0:v]trim=start=${a.toFixed(3)}:end=${b.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
  const filter = `${parts.join(';')};${keep.map((_, i) => `[v${i}]`).join('')}concat=n=${keep.length}:v=1:a=0,fps=30[out]`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', webm, '-filter_complex', filter, '-map', '[out]', '-c:v', 'libx264', '-preset', 'slow',
    '-crf', '24', '-maxrate', '2400k', '-bufsize', '4800k', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
  const length = keep.reduce((sum, [a, b]) => sum + b - a, 0);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', (length * posterAt).toFixed(2), '-i', mp4, '-frames:v', '1', poster]);
  if (length > maxSeconds) console.warn(`video: ${mp4} runs ${length.toFixed(1)} s, more than ${maxSeconds} s`);
  return length;
}
