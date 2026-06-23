# Inversia 🌍↔️🌊

An interactive 3D globe of **Inversia** — Earth turned inside-out.

Every point on Earth has an elevation: mountains rise kilometres above the sea,
and the ocean floor drops just as far below it. Inversia **flips that height
field upside-down** — the deep ocean basins and trenches become towering new
continents, while today's land sinks into a new world ocean. A mid-ocean ridge
becomes a mountain range; the Mariana Trench becomes the highest peak on the
planet.

The globe is rendered live in a WebGL shader from a real **topography +
bathymetry** dataset, so you can:

- **Toggle** between the real Earth and its inverse.
- **Drag the water level** up and down (−8000 m … +6000 m) to flood or drain
  the planet and watch coastlines redraw in real time.
- See the **land / ocean split** update as you go (Real Earth at sea level reads
  ~29 % land, exactly as it should).
- **Exaggerate the relief**, spin, zoom and orbit.

## Run it

```bash
npm install
npm run dev      # open the printed http://localhost:5173 URL
```

Build a static, deployable site:

```bash
npm run build    # → dist/  (drop it on any static host / GitHub Pages)
npm run preview  # serve the production build locally
```

## How it works

- **Data** — `data/earth_relief_01d.txt` is the GMT global 1° *earth relief*
  grid (real topography **and** bathymetry, in metres), derived from NOAA/GEBCO
  and in the public domain.
- **Baking** — `scripts/bake_heightmap.py` auto-detects the grid orientation by
  scoring it against known landmarks, smoothly upsamples it, and packs the
  elevation into a 16-bit heightmap (`public/heightmap.png`, R = high byte,
  G = low byte) plus `public/heightmap.json` metadata. Re-run with `npm run bake`
  (needs Python + `pillow numpy`).
- **Rendering** — `src/main.js` decodes the heightmap into a half-float texture
  and renders a displaced sphere. The fragment shader colours each point from
  its elevation relative to the current water level (hypsometric tints for land,
  depth-graded blues for sea), with hillshading, a water specular and an
  atmospheric rim. **Inversion is simply reflecting the elevation around the
  water line** (`elev → −elev`), done per-pixel in the shader.

## Controls

| Control | What it does |
| --- | --- |
| **World** button | Switch between *Inversia* and the *Real Earth* |
| **Water level** | Raise/lower the global sea level (metres) |
| **Relief exaggeration** | Vertical-exaggeration factor for the terrain |
| Drag / scroll | Orbit and zoom the globe |
| **Auto-spin / Reset view** | Toggle rotation, recentre the camera |

## Credits

- Elevation: [GMT](https://www.generic-mapping-tools.org/) `earth_relief`
  (NOAA / GEBCO, public domain).
- Rendering: [three.js](https://threejs.org/).

MIT licensed.
