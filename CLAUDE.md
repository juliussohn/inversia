# CLAUDE.md

Inversia — an inverted-Earth world generator. One MapLibre globe that flattens
into a deep-zoom map; a custom WebGL layer renders real topography/bathymetry
live, and a Web Worker generates vector features (coastlines, rivers, countries,
cities, biomes) over the same elevation field.

User-facing overview, run/build steps, and the data-bake live in [README.md](README.md).
Don't duplicate them here. Quick reference:

```bash
npm run dev      # vite dev server (port 5173, see .claude/launch.json)
npm run build    # → dist/
npm run bake     # regenerate public/heightmap.png from source grids (rare)
```

Plain JS + ES modules (no TypeScript, no test suite). Verify by running the app.

## Architecture

Two threads, one config spine.

- **`src/world.js`** — main-thread entry + orchestrator. Mounts the map, binds
  the recipe to the panel + URL hash, requests generation from the worker, and
  applies feature payloads to GeoJSON sources.
- **`src/world/recipe.js`** — `RECIPE_SCHEMA`, the **single source of truth** for
  every world parameter. The Tweakpane panel, URL-hash codec, and JSON
  save/load all derive from it.
- **`src/world/worker.js`** — runs the generation passes off-thread. Memoizes
  each pass on a signature string so only what actually changed re-runs;
  narrates progress as stages.
- **`src/world/gen/*`** — the passes: `field.js` (loads the baked heightmap),
  `coast.js` (coastlines/lakes + the shared `marchingSquares`), `hydro.js`
  (river flow), `countries.js`, `cities.js`, `biome.js`. `grid.js` holds shared
  primitives (`clamp01`, `emptyFC`, `R_KM`, `bfsDistance`, `stitch`).
- **`src/world/terrain-layer.js`** + **`src/terrain.js`** — the live terrain
  custom layer and its GLSL shader (hypsometric ramp, hillshade, biome relief).
- **`src/world/styles.js`** — the four style presets (Relief / Natural /
  Political / Minimal), `applyStyle`, and layer-visibility toggles.
- Supporting: `names.js` (place naming), `biome-palette.js` (biome ids+colors
  shared by worker and main), `panel.js`, `persist.js`, `bake.js`,
  `geo-regions.js`.

## Invariants (read before editing)

- **Recipe = source of truth.** Add a field to `RECIPE_SCHEMA` and the panel
  control, hash, and JSON codecs all pick it up automatically. Never hand-wire a
  control or hash key.
- **View prefs are NOT in the recipe.** Map style and layer visibility live in a
  separate URL `style=` param + localStorage. Keep the world hash world-only so
  a shared link's geometry is reproducible regardless of how it's viewed.
- **Inversion.** `world.invert` flips the elevation sign (ocean floor → risen
  continents). Every pass computes on the *displayed* surface, so flip the sign
  first, then threshold against the water level.
- **Grid convention** (equirectangular, all passes identical): cell `(x,y)` is at
  `lon = -180 + (x+0.5)/W*360`, `lat = 90 - (y+0.5)/H*180`. Longitude **wraps**,
  latitude **clamps**. The antimeridian seam cell is skipped when contouring
  (a hairline mid-Pacific gap); flood-fills still wrap.
- **Worker-safe imports.** Modules under `gen/` and `recipe.js` run in the worker
  — no DOM/`window`. `recipe.js` is dependency-free and imported by both threads.

## Adding a generation knob

Knobs are `0..1` floats with **0.5 = the hand-tuned baseline**, so existing
worlds stay unchanged. Thread one through, in order:

1. `recipe.js` — add the field to its group in `RECIPE_SCHEMA`.
2. `world.js` — add it to `featureSig()` (so a change triggers regen) and to the
   `requestFeatures()` worker message.
3. `worker.js` — add it to the relevant pass's cache signature and pass it into
   the compute opts.
4. `gen/<pass>.js` — read `opts.<field>` and map it onto the constant; default a
   missing value to 0.5 (old worlds): `Number.isFinite(v) ? clamp01(v) : 0.5`.

Climate knobs are the exception: they're listed once in `CLIMATE_FIELDS`
(recipe.js) and threaded by spreading that list — add the field to the schema
and it flows through automatically.

## Gotchas

- **MapLibre `icon-allow-overlap` / `ignore-placement` are not data-driven** —
  feature expressions are silently rejected and the layer drops. Use constants.
- **Verifying:** the dev server's `window.map` can be a stale/orphaned instance
  for `preview_eval` reads — trust screenshots over polling it. The four styles
  between them exercise every pass (Natural shows biomes; Relief/Political show
  coast, rivers, borders, cities), so cycle them after gen changes.
