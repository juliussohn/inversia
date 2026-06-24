# Inversia 🌍↔️🌊

**Inversia** is Earth turned inside-out. Every point has an elevation: mountains
rise kilometres above the sea, and the ocean floor drops just as far below it.
Inversia **flips that height field upside-down** — the deep ocean basins and
trenches become towering new continents, while today's land sinks into a new
world ocean. A mid-ocean ridge becomes a mountain range; the Mariana Trench
becomes the highest peak on the planet.

It renders live in a WebGL shader from real **topography + bathymetry** data, as
**one map**: zoom out to the inverted planet as a 3D globe, zoom in and the same
world flattens into a deep-zoom streaming map — no handoff, one renderer.

You can **toggle** between the real Earth and its inverse, **drag the water
level** (−8000 m … +6000 m) to flood or drain the planet with coastlines
redrawing in real time, adjust **relief shading**, and watch the **land / ocean
split** update (Real Earth at sea level reads ~29 % land, exactly as it should).

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

Inversia is built on **[MapLibre GL JS](https://maplibre.org/) v5** with globe
projection. A single page (`index.html` → `src/world.js`) mounts the map and
draws the terrain as a MapLibre **custom layer**:

- **Terrain** (`src/world/terrain-layer.js`, shared core in `src/terrain.js`)
  streams **Terrarium** elevation tiles (real topography + bathymetry, public
  domain) from [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/).
  The shared fragment shader decodes each tile's elevation
  (`R*256 + G + B/256 − 32768` m), optionally inverts it, floods below the water
  level, and colours it hypsometrically with hillshading. Water level, inversion
  and relief are shader uniforms, so they update instantly with no re-fetching.
- **One renderer, two presentations.** The custom layer projects every tile
  through MapLibre's own `projectTile`, so it follows MapLibre's globe⇄mercator
  camera for free. Zoomed out it draws the whole sphere (tessellated so it curves
  cleanly, back hemisphere auto-clipped); zoomed in it walks only the visible
  tiles at full detail. Tiles stream with LOD + ancestor fallback.
- **World recipe** (`src/world/recipe.js`) is one typed config object (seed,
  world, and placeholder groups for countries/cities/rivers/lakes) that drives an
  auto-generated [Tweakpane](https://tweakpane.github.io/) panel and round-trips
  through the URL hash, so any state is a shareable link.

This is the foundation of a **procedural world platform** — generated coastlines,
rivers, countries, cities and names land in later phases as MapLibre GeoJSON
layers on top of this terrain (see `docs/world-plan.md`).

## Controls

| Control | What it does |
| --- | --- |
| **Invert (Inversia)** | Switch between *Inversia* and the *Real Earth* |
| **Water level** | Raise/lower the global sea level (metres) |
| **Relief** | Hillshade / vertical-exaggeration strength |
| **Seed** + feature groups | Parameters for the procedural layers (work in progress) |
| Drag / scroll | Spin the globe and zoom from globe down into the map |

## Credits

- Elevation: [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)
  (Terrarium, Mapzen/NOAA/GEBCO, public domain), streamed live.
- Rendering: [MapLibre GL JS](https://maplibre.org/).

MIT licensed.
