Task: generate the hero background image for the berg:work website using your built-in image generation tool, then place it in the repository. Do not create or edit any HTML/CSS/JS.

Working directory: /home/oem/Dokumente/003_Projekte/21_bergwork

Deliverables:
- `website/assets/img/berg-hero.jpg` — landscape 16:9, 2880×1620 px. If the tool caps resolution, generate the largest landscape size available and upscale to 2880 px wide with Python Pillow LANCZOS. JPEG quality 88–92, progressive, target ≤ 900 kB.
- `website/assets/img/berg-hero@1440.jpg` — 1440×810 derivative, ≤ 300 kB (for mobile).
- `website/assets/img/berg-hero-alt.jpg` — the rejected candidate, same processing as the main image, so the owner can swap.

Context: berg:work is the sister brand of Himmel:CAD. The Himmel:CAD site uses a Makoto-Shinkai-style anime summer sky with towering cumulus clouds over green alpine foothills. berg:work must look like the same family, but its subject is the MOUNTAIN ("Berg"). The site is lawn.video-style: a full-bleed painted hero with a huge cream wordmark (hard black offset shadow) top-left and paper stickers bottom-left / bottom-right. The accent colour of the brand is a Soviet-poster red (#D7261E) on cream (#F3F0E6) and ink (#0A0A0A).

Image brief:
- Subject: a single majestic alpine mountain massif (a sharp, glaciated rock peak in the spirit of the Matterhorn / Eiger north face / Zugspitze) in the right half of the frame, at alpenglow shortly after sunset: the upper rock and snow faces glow warm red-orange-pink, the lower slopes and valley already in cool blue shadow.
- Sky: deep evening sky, gradient from deep indigo/ultramarine at the top to a warm peach/apricot band near the horizon; a few thin painterly cirrus streaks lit pink. Maybe one or two first stars in the top-left, very subtle.
- Bottom fifth: dark blue-green conifer ridge and alpine meadow in shadow, a tiny mountain hut with one warm lit window on a ridge (small — a detail, not the subject), light valley haze.
- Composition: keep the upper-left quadrant relatively plain (calm sky, minimal detail) so a large cream wordmark with a black shadow reads there. The bottom-left and bottom-right corners hold stickers, so no important detail there. The peak should rise into the upper right third.
- Style words: anime background art, Makoto Shinkai / CoMix Wave style, cel-painted rock and snow, clean painterly gradients, luminous, cinematic, 8k matte painting, high detail.
- Negative: text, letters, watermark, logo, people, animals, vehicles, cable cars, buildings other than the tiny hut, lens flare artifacts, CGI plastic look, HDR halos, photographic realism.
- Palette anchors: top sky #1B2A5E → #3E4F9A; horizon band #F2B38A / #F7D2B0; alpenglow on the peak #E8674A / #F29A7A; shadowed rock #3A4468; forest #1E3A3A.
- Keep contrast in the mid-tones; no pure white blowouts larger than a few percent of the frame.

Steps:
1. Generate 2 candidates with the image generation tool. Pick the one with the calmer upper-left area and the stronger, more iconic peak on the right.
2. Save the chosen one as `berg-hero.jpg` plus the 1440 derivative, the other as `berg-hero-alt.jpg`. Report dimensions and file sizes (Python Pillow).
3. Print a short report: which tool/model was used, sizes, and one line why the chosen candidate won.

Constraints: only files under website/assets/img/. No other changes. Budget: two generations, no iteration loops.
