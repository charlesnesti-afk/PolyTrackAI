#!/usr/bin/env python3
"""Generate crisp geometric low-poly racing + neural raycast icons for PolyPilot AI."""

import math
import os
from PIL import Image, ImageDraw

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "extension", "icons")
os.makedirs(OUT_DIR, exist_ok=True)


def render_icon(size: int) -> Image.Image:
    scale = 4
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Rounded squircle background (#111620 off-black slate, 1px subtle border)
    pad = max(2, int(s * 0.04))
    radius = int(s * 0.22)
    draw.rounded_rectangle([pad, pad, s - pad - 1, s - pad - 1], radius=radius, fill=(17, 22, 32, 255), outline=(52, 65, 86, 255), width=max(2, s // 32))

    # Perspective road trapezoid
    cx = s * 0.5
    top_y = s * 0.24
    bot_y = s * 0.86
    road_poly = [
        (cx - s * 0.11, top_y),
        (cx + s * 0.11, top_y),
        (cx + s * 0.36, bot_y),
        (cx - s * 0.36, bot_y),
    ]
    draw.polygon(road_poly, fill=(28, 36, 50, 255))

    # Signal-green LIDAR / vision raycasts fanning out from car nose
    origin = (cx, s * 0.68)
    for deg, col in [(-34, (34, 197, 94, 130)), (-16, (34, 197, 94, 190)), (0, (34, 197, 94, 255)), (16, (34, 197, 94, 190)), (34, (34, 197, 94, 130))]:
        rad = math.radians(deg - 90)
        length = s * (0.46 if deg == 0 else (0.41 if abs(deg) == 16 else 0.34))
        ex = origin[0] + math.cos(rad) * length
        ey = origin[1] + math.sin(rad) * length
        draw.line([origin, (ex, ey)], fill=col, width=max(2, s // 26))
        r_dot = max(2, s // 28)
        draw.ellipse([ex - r_dot, ey - r_dot, ex + r_dot, ey + r_dot], fill=(34, 197, 94, 255))

    # Low-poly wedge race car silhouette
    car_poly = [
        (cx, s * 0.52),
        (cx + s * 0.15, s * 0.77),
        (cx + s * 0.11, s * 0.83),
        (cx - s * 0.11, s * 0.83),
        (cx - s * 0.15, s * 0.77),
    ]
    draw.polygon(car_poly, fill=(237, 241, 247, 255))
    cockpit = [
        (cx, s * 0.59),
        (cx + s * 0.075, s * 0.73),
        (cx - s * 0.075, s * 0.73),
    ]
    draw.polygon(cockpit, fill=(17, 22, 32, 255))

    return img.resize((size, size), Image.Resampling.LANCZOS)


for sz in (16, 32, 48, 128):
    out_path = os.path.join(OUT_DIR, f"icon{sz}.png")
    render_icon(sz).save(out_path, "PNG")
    print(f"Generated {out_path}")
