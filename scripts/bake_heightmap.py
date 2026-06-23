#!/usr/bin/env python3
"""
Bake the Inversia elevation asset.

Input : data/earth_relief_01d.txt  -- GMT global 1-degree earth relief
        (real topography AND bathymetry, 180 rows x 360 cols, metres).
        Source: GenericMappingTools/gmtserver-admin (public domain, NOAA/GEBCO derived).

Output: public/heightmap.png  -- elevation packed into 16 bits across the R and G
        channels of an 8-bit RGBA PNG (R = high byte, G = low byte). Decoded in the
        WebGL shader as:  elev = ((R*256 + G)/65535) * (maxElev-minElev) + minElev
        public/heightmap.json -- { minElev, maxElev, width, height }

The script auto-detects the grid orientation (row/col flips + longitude roll) by
scoring against a set of known landmarks, so we don't have to guess the file's
conventions.
"""
import json
import os
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, "data", "earth_relief_01d.txt")
OUT_PNG = os.path.join(ROOT, "public", "heightmap.png")
OUT_JSON = os.path.join(ROOT, "public", "heightmap.json")

TARGET_W, TARGET_H = 2048, 1024  # smooth upsample for nice shading on the globe

# (name, lat, lon[-180..180], expected sign: +1 land / -1 ocean)
LANDMARKS = [
    ("Himalaya",      28,   87, +1),
    ("Andes",        -15,  -70, +1),
    ("Sahara",        23,   10, +1),
    ("Siberia",       62,  100, +1),
    ("Australia",    -25,  135, +1),
    ("N.America",     40, -100, +1),
    ("Amazon",        -3,  -60, +1),
    ("Greenland",     72,  -40, +1),
    ("Antarctica",   -80,    0, +1),
    ("E.Europe",      52,   30, +1),
    ("Pacific",        0, -140, -1),
    ("Mariana",       11,  145, -1),
    ("N.Atlantic",    40,  -45, -1),
    ("S.Pacific",    -40, -120, -1),
    ("Indian",         0,   80, -1),
    ("S.Atlantic",   -45,  -25, -1),
    ("Arctic",        88,    0, -1),
    ("Caribbean",     15,  -75, -1),
]


def load_grid():
    rows = []
    with open(SRC) as f:
        for line in f:
            parts = line.split()
            if len(parts) >= 100:
                rows.append([float(x) for x in parts])
    g = np.array(rows, dtype=np.float32)
    assert g.shape == (180, 360), f"unexpected grid shape {g.shape}"
    return g


def sample(grid, lat, lon):
    """Sample assuming grid[0,0] == (lat=+90, lon=-180), north-up, west-left."""
    h, w = grid.shape
    r = int(np.clip((90 - lat) / 180.0 * h, 0, h - 1))
    c = int(((lon + 180) / 360.0 * w) % w)
    return grid[r, c]


def score_orientation(grid):
    hits = 0
    total = 0.0
    for _, lat, lon, sign in LANDMARKS:
        v = sample(grid, lat, lon)
        if (v >= 0) == (sign > 0):
            hits += 1
        total += sign * v  # reward correct sign with magnitude
    return hits, total


def find_orientation(base):
    best = None
    for vflip in (False, True):
        for hflip in (False, True):
            g0 = base.copy()
            if vflip:
                g0 = np.flipud(g0)
            if hflip:
                g0 = np.fliplr(g0)
            for roll in range(360):
                g = np.roll(g0, roll, axis=1)
                hits, total = score_orientation(g)
                key = (hits, total)
                if best is None or key > best[0]:
                    best = (key, (vflip, hflip, roll), g)
    return best


def ascii_preview(grid, cols=72, rows=24):
    h, w = grid.shape
    chars = " .:-=+*#%@"
    out = []
    for ry in range(rows):
        line = []
        for rx in range(cols):
            r = int(ry / rows * h)
            c = int(rx / cols * w)
            v = grid[r, c]
            if v < 0:
                line.append("~" if v < -3000 else ",")
            else:
                idx = min(len(chars) - 1, int(v / 5652 * (len(chars) - 1)))
                line.append(chars[max(1, idx)])
        out.append("".join(line))
    return "\n".join(out)


def main():
    grid = load_grid()
    (hits, total), (vflip, hflip, roll), g = find_orientation(grid)
    print(f"orientation: vflip={vflip} hflip={hflip} roll={roll}  "
          f"landmark sign hits = {hits}/{len(LANDMARKS)}")
    print("land/ocean preview (~ = deep ocean, , = shallow ocean, .:=+*# = land):")
    print(ascii_preview(g))

    minE, maxE = float(g.min()), float(g.max())
    print(f"elev range: {minE:.0f} .. {maxE:.0f} m")

    # Smooth upsample in float space (seamless in longitude via wrap padding).
    pad = 4
    gp = np.concatenate([g[:, -pad:], g, g[:, :pad]], axis=1)
    img = Image.fromarray(gp, mode="F")
    scale = TARGET_W / g.shape[1]
    img = img.resize((TARGET_W + int(2 * pad * scale), TARGET_H), Image.BICUBIC)
    crop = int(pad * scale)
    arr = np.asarray(img)[:, crop:crop + TARGET_W]

    # Pack to 16-bit across R (high) and G (low).
    norm = np.clip((arr - minE) / (maxE - minE), 0, 1)
    u16 = np.round(norm * 65535).astype(np.uint32)
    rgba = np.zeros((TARGET_H, TARGET_W, 4), dtype=np.uint8)
    rgba[..., 0] = (u16 >> 8) & 0xFF
    rgba[..., 1] = u16 & 0xFF
    rgba[..., 2] = 0
    rgba[..., 3] = 255

    os.makedirs(os.path.dirname(OUT_PNG), exist_ok=True)
    Image.fromarray(rgba, "RGBA").save(OUT_PNG, optimize=True)
    with open(OUT_JSON, "w") as f:
        json.dump({"minElev": minE, "maxElev": maxE,
                   "width": TARGET_W, "height": TARGET_H,
                   "source": "GMT earth_relief_01d (NOAA/GEBCO, public domain)"}, f, indent=2)
    print(f"wrote {OUT_PNG} ({os.path.getsize(OUT_PNG)} bytes) and {OUT_JSON}")


if __name__ == "__main__":
    main()
