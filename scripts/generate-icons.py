#!/usr/bin/env python3
"""Generate the PWA / app icons for GraphMentor AI.

Why a script instead of committed binaries: the icons are drawn from the same
geometry as ``public/favicon.svg`` (a small prerequisite graph), so they are
reproducible and reviewable rather than opaque PNGs of unknown origin. There is
no stock-art licence to track and no generated/image-model asset involved.

Usage (optional — the PNGs are already in the repository):

    python3 scripts/generate-icons.py

Requires Pillow (``pip install pillow``). Outputs:

    public/icons/icon-192.png          any-purpose 192x192
    public/icons/icon-512.png          any-purpose 512x512
    public/icons/maskable-512.png      512x512, logo inside the 80% safe zone
    public/icons/apple-touch-icon.png  180x180, opaque background
"""

from __future__ import annotations

import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:  # pragma: no cover - developer convenience only
    print("Pillow is required: pip install pillow", file=sys.stderr)
    raise SystemExit(1)

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "icons"

BACKGROUND = (11, 18, 32, 255)  # #0b1220
EDGE = (34, 211, 238, 217)  # #22d3ee at ~85% opacity
NODES = [
    # (x, y, radius, colour) in a 64x64 coordinate space, matching favicon.svg
    (32.0, 20.0, 6.0, (34, 211, 238, 255)),  # cyan   — the goal skill
    (20.0, 44.0, 5.0, (167, 139, 250, 255)),  # violet — a prerequisite
    (46.0, 40.0, 5.0, (52, 211, 153, 255)),  # emerald — a downstream skill
    (18.0, 26.0, 3.5, (251, 191, 36, 255)),  # amber  — an earlier prerequisite
]
EDGES = [
    ((20.0, 44.0), (32.0, 20.0)),
    ((32.0, 20.0), (46.0, 40.0)),
    ((20.0, 44.0), (46.0, 40.0)),
    ((32.0, 20.0), (18.0, 26.0)),
    ((18.0, 26.0), (20.0, 44.0)),
]

SUPERSAMPLE = 4


def render(size: int, *, maskable: bool, opaque: bool) -> Image.Image:
    """Draw the mark at ``size`` px, scaled from the 64x64 design space."""
    canvas = Image.new("RGBA", (size * SUPERSAMPLE, size * SUPERSAMPLE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)

    # Maskable icons must keep their content inside the middle 80% (the platform
    # may crop to a circle), so the artwork is scaled down around the centre.
    inner = size * SUPERSAMPLE * (0.80 if maskable else 1.0)
    scale = inner / 64.0
    offset = (size * SUPERSAMPLE - inner) / 2.0

    def point(x: float, y: float) -> tuple[float, float]:
        return (offset + x * scale, offset + y * scale)

    # Background: rounded square for the normal icons, full bleed for maskable.
    if maskable or opaque:
        radius = 0 if maskable else int(inner * 0.22)
        draw.rounded_rectangle(
            [offset * 0.55, offset * 0.55, size * SUPERSAMPLE - offset * 0.55, size * SUPERSAMPLE - offset * 0.55],
            radius=radius if maskable else int(size * SUPERSAMPLE * 0.22),
            fill=BACKGROUND,
        )
    else:
        draw.rounded_rectangle(
            [0, 0, size * SUPERSAMPLE - 1, size * SUPERSAMPLE - 1],
            radius=int(size * SUPERSAMPLE * 0.22),
            fill=BACKGROUND,
        )

    # Edges first, so the node circles sit on top of them.
    for (x1, y1), (x2, y2) in EDGES:
        draw.line([point(x1, y1), point(x2, y2)], fill=EDGE, width=max(1, int(size * SUPERSAMPLE * 0.039)))

    for x, y, r, colour in NODES:
        cx, cy = point(x, y)
        radius = r * scale
        draw.ellipse([cx - radius, cy - radius, cx + radius, cy + radius], fill=colour)

    return canvas.resize((size, size), Image.LANCZOS)


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    targets = [
        ("icon-192.png", 192, False, False),
        ("icon-512.png", 512, False, False),
        ("maskable-512.png", 512, True, False),
        ("apple-touch-icon.png", 180, False, True),
    ]
    for name, size, maskable, opaque in targets:
        image = render(size, maskable=maskable, opaque=opaque)
        path = OUT / name
        image.save(path, format="PNG", optimize=True)
        print(f"wrote {path.relative_to(ROOT)}  ({size}x{size})")


if __name__ == "__main__":
    main()


