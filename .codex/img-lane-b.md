Task: generate two hero background images with your built-in image generation tool.

Working directory: /home/oem/Dokumente/003_Projekte/21_bergwork

Context: berg:work is the sister brand of Himmel:CAD. Its website is lawn.video-style: a full-bleed painted hero with a huge cream wordmark (hard black offset shadow) in the UPPER LEFT, paper stickers in the BOTTOM LEFT and BOTTOM RIGHT corners. The existing hero `website/assets/img/berg-hero.jpg` (look at it first for the style reference) is an anime background painting (Makoto Shinkai / CoMix Wave style: cel-painted rock, snow and timber, clean painterly gradients, luminous, cinematic, high detail). Every new image must match that style exactly, so the set feels like one series.

Global composition rules for every image:
- Landscape 16:9. Keep the upper-left quadrant calm (sky, rock face or shadow with little detail) so a cream wordmark with a black shadow reads there. No important detail in the bottom-left or bottom-right corners.
- Negative: text, letters, signs with writing, watermark, logo, people, animals, vehicles (a mine cart is allowed where stated), lens flare, CGI plastic look, HDR halos, photorealism.

Processing for every image: if the tool caps resolution, generate the largest landscape size and upscale to 2880×1620 with Python Pillow LANCZOS (crop to 16:9 centred if needed). Save `<name>.jpg` at 2880×1620 (JPEG q 88–92, progressive, ≤ 900 kB) and `<name>@1440.jpg` at 1440×810 (≤ 300 kB) in `website/assets/img/`. One generation per image, no iteration loops. Only write files under website/assets/img/. Finish with a short report: file names, sizes, one line per image on how well it fits the brief.

Images:
1. `mine-inside`: view from INSIDE an old mine tunnel looking out through the portal. The tunnel is framed by heavy timber Türstock sets (posts and cap beams, plank lagging), rails with wooden sleepers lead out of the tunnel into the light. Through the opening (centre-right) a sunlit alpine valley with a snowy peak and blue sky with cumulus clouds. The dark timber and rock of the tunnel fill the upper left and edges (dark, low detail, good for a cream wordmark). Warm light spill on the timber near the opening.
2. `mine-winter`: an old mine entrance with timber Türstock framing in deep snow, on the RIGHT half, snow on the cap beam, icicles, rails disappearing under snow, a warm light glowing from a small wooden miners hut next to it. Blue hour winter evening, clear sky gradient from deep blue to pale turquoise at the horizon, snowy peak above.
