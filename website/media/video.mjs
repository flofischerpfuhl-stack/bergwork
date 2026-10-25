// Turns a headless session into the site's MP4. Two sources: a Playwright recording (`encode`, 1× only) or frames
// grabbed at 2× (`grabFrames` + `encodeFrames`, sharp). Waiting times (a model
// loading, a preview rendering) are cut out as jump cuts; the rest can be sped up. H.264, yuv420p, faststart, plus a
// poster frame.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Marks the stretches to cut, in seconds since the recording started (the page's creation). */
export function cutList() {
  const t0 = Date.now();
  const now = () => (Date.now() - t0) / 1000;
  const cuts = [];
  let from = null;
  return {
    cuts,
    now,
    t0,
    start() { from = now(); },
    end(keep = 0.4) { if (from !== null) cuts.push([from + keep / 2, now() - keep / 2]); from = null; },
  };
}

function keepRanges(cuts, duration) {
  const keep = [];
  let at = 0;
  for (const [a, b] of [...cuts].sort((x, y) => x[0] - y[0])) {
    if (b <= a) continue;
    if (a > at) keep.push([at, a]);
    at = Math.max(at, b);
  }
  if (at < duration) keep.push([at, duration]);
  return keep;
}

export function encode(webm, cuts, mp4, poster, { posterAt = 0.75, maxSeconds = 32 } = {}) {
  const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', webm], { encoding: 'utf8' }));
  const keep = keepRanges(cuts, duration);
  const parts = keep.map(([a, b], i) => `[0:v]trim=start=${a.toFixed(3)}:end=${b.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
  const filter = `${parts.join(';')};${keep.map((_, i) => `[v${i}]`).join('')}concat=n=${keep.length}:v=1:a=0,fps=30[out]`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', webm, '-filter_complex', filter, '-map', '[out]', '-c:v', 'libx264', '-preset', 'slow',
    '-crf', '24', '-maxrate', '2400k', '-bufsize', '4800k', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4]);
  const length = keep.reduce((sum, [a, b]) => sum + b - a, 0);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', (length * posterAt).toFixed(2), '-i', mp4, '-frames:v', '1', poster]);
  if (length > maxSeconds) console.warn(`video: ${mp4} runs ${length.toFixed(1)} s, more than ${maxSeconds} s`);
  return length;
}

/**
 * Grabs sharp frames of one region (CSS pixels) at the page's 2× scale, as fast as Chromium renders them (about
 * 5 per second for a 600 × 700 region). Run the session slowly and play it back faster (`encodeFrames` speed) for
 * smooth motion. `stop()` resolves to the frame list, each with its timestamp.
 */
export async function grabFrames(page, dir, clip, { scale = 2, quality = 90 } = {}) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const session = await page.context().newCDPSession(page);
  const frames = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      const asked = Date.now();
      const { data } = await session.send('Page.captureScreenshot', { format: 'jpeg', quality, clip: { ...clip, scale } });
      const file = path.join(dir, `${String(frames.length).padStart(5, '0')}.jpg`);
      writeFileSync(file, Buffer.from(data, 'base64'));
      frames.push({ file, at: (asked + Date.now()) / 2 });
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
      await session.detach().catch(() => {});
      return frames;
    },
  };
}

/**
 * Encodes grabbed frames: `cuts` are [from, to] seconds relative to `t0` (Date.now() at the clock's start),
 * `crop` is { x, y, width, height } in device pixels, `speed` > 1 plays faster, `width` scales the output.
 */
export function encodeFrames(frames, { t0, cuts = [], crop, speed = 1, width, mp4, poster, posterAt = 1, maxSeconds = 20 }) {
  if (frames.length < 2) throw new Error('video: no frames');
  const end = frames.at(-1).at + 600;
  const duration = (end - t0) / 1000;
  const keep = keepRanges(cuts, duration);
  // Each kept stretch shows the frame that was on screen at every moment of it, so cuts land on real states.
  const list = [];
  for (const [a, b] of keep) {
    const from = t0 + a * 1000;
    const to = t0 + b * 1000;
    let index = frames.findLastIndex((frame) => frame.at <= from);
    if (index < 0) index = 0;
    let at = from;
    while (at < to) {
      const next = frames[index + 1] && frames[index + 1].at < to ? frames[index + 1].at : to;
      if (next > at) list.push({ file: frames[index].file, seconds: (next - at) / 1000 });
      at = next;
      index += 1;
      if (index >= frames.length) break;
    }
  }
  const concat = path.join(path.dirname(frames[0].file), 'list.txt');
  writeFileSync(concat, `${list.map(({ file, seconds }) => `file '${file}'\nduration ${seconds.toFixed(4)}`).join('\n')}\nfile '${list.at(-1).file}'\n`);
  const filters = [];
  if (crop) filters.push(`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`);
  if (width) filters.push(`scale=${width}:-2:flags=lanczos`);
  filters.push(`setpts=PTS/${speed}`, 'fps=30', 'format=yuv420p');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', concat, '-vf', filters.join(','), '-an', '-c:v', 'libx264',
    '-preset', 'slow', '-crf', '23', '-maxrate', '3000k', '-bufsize', '6000k', '-movflags', '+faststart', mp4]);
  const length = list.reduce((sum, item) => sum + item.seconds, 0) / speed;
  const posterFilters = [crop ? `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}` : null, width ? `scale=${width}:-2:flags=lanczos` : null].filter(Boolean);
  const posterFrame = list[Math.min(list.length - 1, Math.round((list.length - 1) * posterAt))].file;
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', posterFrame, ...(posterFilters.length ? ['-vf', posterFilters.join(',')] : []), '-q:v', '3', poster]);
  if (length > maxSeconds) console.warn(`video: ${mp4} runs ${length.toFixed(1)} s, more than ${maxSeconds} s`);
  return length;
}
