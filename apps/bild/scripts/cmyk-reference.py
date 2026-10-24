#!/usr/bin/env python3
"""Independent RGB->CMYK oracle used by the focused Vitest grid test.

Pillow 10.2.0 links Little CMS 2.14 on the reference machine; the product WASM uses
Little CMS 2.19.1. Inputs and outputs are raw packed 8-bit samples.
"""

import argparse
from pathlib import Path

from PIL import Image, ImageCms


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("profile", type=Path)
    parser.add_argument("rgb", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--intent", choices=("perceptual", "relative-colorimetric"), required=True)
    parser.add_argument("--bpc", action="store_true")
    args = parser.parse_args()

    samples = args.rgb.read_bytes()
    if not samples or len(samples) % 3:
        raise ValueError("RGB input must contain packed three-channel samples")
    intent = (ImageCms.Intent.PERCEPTUAL if args.intent == "perceptual"
              else ImageCms.Intent.RELATIVE_COLORIMETRIC)
    flags = ImageCms.FLAGS["BLACKPOINTCOMPENSATION"] if args.bpc else 0
    transform = ImageCms.buildTransformFromOpenProfiles(
        ImageCms.createProfile("sRGB"), ImageCms.getOpenProfile(str(args.profile)),
        "RGB", "CMYK", renderingIntent=intent, flags=flags)
    source = Image.frombytes("RGB", (len(samples) // 3, 1), samples)
    args.output.write_bytes(ImageCms.applyTransform(source, transform).tobytes())


if __name__ == "__main__":
    main()
