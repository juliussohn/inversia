#!/usr/bin/env python3
"""
Bake the Inversia elevation asset.

Input : data/earth_relief_06m_p.grd  -- GMT global 6-arc-minute earth relief
        (real topography AND bathymetry; 1800 rows x 3600 cols ≈ 11 km cells,
        netCDF/int16 metres). Source: GenericMappingTools earth_relief, pixel
        registration (public domain, NOAA/GEBCO derived). Replaces the old 1°
        (earth_relief_01d.txt) source: ~6x finer, so coastlines carry real
        detail (bays, peninsulas, island chains) instead of 1°-blocky outlines.

Output: public/heightmap.png  -- elevation packed into 16 bits across the R and G
        channels of an 8-bit RGBA PNG (R = high byte, G = low byte). Decoded in
        src/world/field.js as:  elev = ((R*256+G)/65535)*(maxElev-minElev)+minElev
        public/heightmap.json -- { minElev, maxElev, width, height }

REGISTRATION (why this version is exact): the .grd carries explicit lon/lat
coordinate arrays, so we orient the grid directly from them — no landmark-based
orientation/roll guessing (that was a 1°-only hack and its coarse tiebreak drifted
coastlines ~2° east). We bake at the source's NATIVE resolution with no resample,
so a baked pixel `o` maps to the cell centre EXACTLY as src/world/gen/coast.js
assumes:  lon = -180 + (o+0.5)/W*360,  lat = 90 - (o+0.5)/H*180  → zero offset.
"""
import json
import os
import numpy as np
from PIL import Image
import netCDF4

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, "data", "earth_relief_06m_p.grd")
OUT_PNG = os.path.join(ROOT, "public", "heightmap.png")
OUT_JSON = os.path.join(ROOT, "public", "heightmap.json")

# (name, lat, lon[-180..180], expected sign: +1 land / -1 ocean) — sanity only.
LANDMARKS = [
    ("Himalaya", 28, 87, +1), ("Andes", -15, -70, +1), ("Sahara", 23, 10, +1),
    ("Siberia", 62, 100, +1), ("Australia", -25, 135, +1), ("N.America", 40, -100, +1),
    ("Amazon", -3, -60, +1), ("Greenland", 72, -40, +1), ("Antarctica", -80, 0, +1),
    ("E.Europe", 52, 30, +1), ("Pacific", 0, -140, -1), ("Mariana", 11, 145, -1),
    ("N.Atlantic", 40, -45, -1), ("S.Pacific", -40, -120, -1), ("Indian", 0, 80, -1),
    ("S.Atlantic", -45, -25, -1), ("Arctic", 88, 0, -1), ("Caribbean", 15, -75, -1),
]


def load_grid():
    """Return (z, W, H) with z oriented north-up / west-left at native resolution.
    Orientation comes from the file's own lon/lat arrays, so it is exact."""
    ds = netCDF4.Dataset(SRC)
    z = np.ma.filled(ds.variables["z"][:], 0).astype(np.float32)  # (nlat, nlon)
    lon = np.asarray(ds.variables["lon"][:], dtype=np.float64)
    lat = np.asarray(ds.variables["lat"][:], dtype=np.float64)

    # North-up (row 0 = +90) and west-left (col 0 = -180), from the coordinates.
    if lat[0] < lat[-1]:            # ascending => south-first => flip vertically
        z = z[::-1]; lat = lat[::-1]
    if lon[0] > lon[-1]:            # descending => flip horizontally
        z = z[:, ::-1]; lon = lon[::-1]

    H, W = z.shape
    # Pixel-registered global grid: col 0 centre sits half a cell east of -180.
    step = 360.0 / W
    assert abs(lon[0] - (-180 + step / 2)) < step, f"unexpected lon origin {lon[0]}"
    assert abs(lat[0] - (90 - step / 2)) < step, f"unexpected lat origin {lat[0]}"
    return z, W, H


def sample(z, W, H, lat, lon):
    """Nearest-cell elevation using the pixel-centre mapping coast.js relies on."""
    c = int(((lon + 180) / 360 * W) % W)
    r = int(np.clip((90 - lat) / 180 * H, 0, H - 1))
    return z[r, c]


def ascii_preview(z, cols=72, rows=24):
    h, w = z.shape
    chars = " .:-=+*#%@"
    out = []
    for ry in range(rows):
        line = []
        for rx in range(cols):
            v = z[int(ry / rows * h), int(rx / cols * w)]
            if v < 0:
                line.append("~" if v < -3000 else ",")
            else:
                idx = min(len(chars) - 1, int(v / 5652 * (len(chars) - 1)))
                line.append(chars[max(1, idx)])
        out.append("".join(line))
    return "\n".join(out)


def main():
    z, W, H = load_grid()

    hits = sum(1 for _, la, lo, s in LANDMARKS if (sample(z, W, H, la, lo) >= 0) == (s > 0))
    print(f"grid {W}x{H} (native, exact registration)  landmark sign hits = {hits}/{len(LANDMARKS)}")
    assert hits >= len(LANDMARKS) - 1, "orientation sanity failed — bad grid?"
    print("land/ocean preview (~ = deep ocean, , = shallow ocean, .:=+*# = land):")
    print(ascii_preview(z))

    minE, maxE = float(z.min()), float(z.max())
    print(f"elev range: {minE:.0f} .. {maxE:.0f} m")

    # Pack to 16-bit across R (high) and G (low). No resample → exact registration.
    norm = np.clip((z - minE) / (maxE - minE), 0, 1)
    u16 = np.round(norm * 65535).astype(np.uint32)
    rgba = np.zeros((H, W, 4), dtype=np.uint8)
    rgba[..., 0] = (u16 >> 8) & 0xFF
    rgba[..., 1] = u16 & 0xFF
    rgba[..., 2] = 0
    rgba[..., 3] = 255

    os.makedirs(os.path.dirname(OUT_PNG), exist_ok=True)
    Image.fromarray(rgba, "RGBA").save(OUT_PNG, optimize=True)
    with open(OUT_JSON, "w") as f:
        json.dump({"minElev": minE, "maxElev": maxE,
                   "width": W, "height": H,
                   "source": "GMT earth_relief_06m (NOAA/GEBCO, public domain)"}, f, indent=2)
    print(f"wrote {OUT_PNG} ({os.path.getsize(OUT_PNG)} bytes) and {OUT_JSON}")


if __name__ == "__main__":
    main()
