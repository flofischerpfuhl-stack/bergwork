Task: generate two hero background images with your built-in image generation tool.

Working directory: /home/oem/Dokumente/003_Projekte/21_bergwork

Context: berg:work is the sister brand of Himmel:CAD. Its website is lawn.video-style: a full-bleed painted hero with a huge cream wordmark (hard black offset shadow) in the UPPER LEFT, paper stickers in the BOTTOM LEFT and BOTTOM RIGHT corners. The existing hero `website/assets/img/berg-hero.jpg` (look at it first for the style reference) is an anime background painting (Makoto Shinkai / CoMix Wave style: cel-painted rock, snow and timber, clean painterly gradients, luminous, cinematic, high detail). Every new image must match that style exactly, so the set feels like one series.

Global composition rules for every image:
- Landscape 16:9. Keep the upper-left quadrant calm (sky, rock face or shadow with little detail) so a cream wordmark with a black shadow reads there. No important detail in the bottom-left or bottom-right corners.
- Negative: text, letters, signs with writing, watermark, logo, people, animals, vehicles (a mine cart is allowed where stated), lens flare, CGI plastic look, HDR halos, photorealism.

Processing for every image: if the tool caps resolution, generate the largest landscape size and upscale to 2880×1620 with Python Pillow LANCZOS (crop to 16:9 centred if needed). Save `<name>.jpg` at 2880×1620 (JPEG q 88–92, progressive, ≤ 900 kB) and `<name>@1440.jpg` at 1440×810 (≤ 300 kB) in `website/assets/img/`. One generation per image, no iteration loops. Only write files under website/assets/img/. Finish with a short report: file names, sizes, one line per image on how well it fits the brief.

Images:
1. `mine-dusk`: an old abandoned alpine mine entrance (German "Stollenmundloch") cut into a steep rock face on the RIGHT half of the frame. The portal is supported by heavy weathered timber framing: classic "Türstock" sets (two slightly inclined wooden posts and a thick cap beam), several sets receding into the dark tunnel, plank lagging above the cap, a few loose rocks. Narrow-gauge rails with wooden sleepers run out of the tunnel towards the viewer, one rusty ore cart stands on them near the portal. An old oil lantern hangs from the cap beam and glows warm. Above the rock face the mountain rises into an alpenglow evening sky (deep indigo top, peach horizon band, pink-lit cirrus), like the existing berg-hero. Foreground: alpine meadow, spruce trees at the edges, scree.
2. `mine-day`: the same kind of mine entrance (timber Türstock sets, rails, ore cart, a small wooden tool shed) on a bright summer day, in the same palette as the Himmel:CAD site: deep cerulean-to-azure sky with towering cumulonimbus clouds rim-lit by the sun, green alpine meadows, grey limestone rock face with the portal on the RIGHT half. Tunnel interior dark but readable.
