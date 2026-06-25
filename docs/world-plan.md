# Inversia → procedural world platform — implementation plan

Goal: turn Inversia from a live inverted-terrain viewer into a procedural world
generator (countries, cities, lakes, rivers, names, manual edits) built on **real
map data** (GeoJSON) and a **real framework** (MapLibre GL JS v5), with everything
driven by a typed parameter "recipe" and a save/bake export.

Each phase below is a **self-contained goal** you can hand to the implement/goal
skill. Phases are ordered **migration-first, then easy-high-impact-first**. Every
phase ends in something runnable and visible; nothing is a throwaway.

The full design rationale (the 14 decisions behind this) is summarized at the
bottom under "Locked decisions."

---

## Phase 1 — MapLibre shell + world-recipe config (easy foundation)

**Why now:** Pure additive, low risk, gets MapLibre on screen and establishes the
config spine every later phase hangs on. No existing behavior removed yet.

**Do:**
- Add deps: `maplibre-gl`, `tweakpane` (control panel), `@turf/turf` +
  `polygon-clipping` (reserved for later geometry ops; install now).
- Mount a MapLibre map in the page (mercator), with a temporary placeholder
  basemap (blank/solid background is fine — no terrain yet).
- Create `src/world/recipe.js`: ONE typed config object (the "world recipe")
  grouped by domain, with sensible defaults:
  - `seed`, `world` (invert, sea/water level, relief exaggeration)
  - placeholder groups for `countries`, `cities`, `rivers`, `lakes` (fill in
    as those phases land).
- Build the recipe ⇄ URL hash codec (replaces `handoff.js`'s hash role) and
  recipe ⇄ JSON.
- Auto-generate a **Tweakpane panel** from the recipe; changing a value updates
  the live `params` and the URL.
- Keep the existing app working in parallel (don't delete `app.js` yet) — run the
  new MapLibre page behind a route/flag or a new `index.html` entry.

**Out of scope:** terrain rendering, any generated features.

**Files:** new `src/world/recipe.js`, new MapLibre entry (e.g. `src/world.js` +
html entry); `vite.config.js`, `package.json`.

**Acceptance:** MapLibre map pans/zooms in the browser; Tweakpane panel shows
seed + water/invert/relief; editing the panel updates the URL hash; reloading the
URL restores the same values.

---

## Phase 2 — Port inverted terrain to a MapLibre custom layer (mercator) — DE-RISK GATE

**Why now:** This is the riskiest assumption in the whole migration (Q14). Prove
it at mercator first, where the existing slippy/tile-decode logic in `map.js`
ports almost directly. Mercator-only is the tractable half of the risk.

**Do:**
- Port the invert / flood / hypsometric-tint / hillshade shader from `map.js`
  into a MapLibre **custom layer** (`type: "custom"`) that draws into MapLibre's
  GL context, synced to its camera.
- Reuse the Terrarium tile streaming + `R*256+G+B/256−32768` decode from
  `map.js`/`terrain.js`.
- Wire water level / invert / relief (from the recipe) as live shader uniforms —
  dragging updates instantly, no re-fetch (parity with today).
- Keep the land/ocean % readout if cheap.

**Out of scope:** globe projection (Phase 3), generated features.

**Files:** new `src/world/terrain-layer.js`; reuse `src/terrain.js`; new path
becomes the default page.

**Acceptance:** the live inverted hypsometric terrain renders in MapLibre at
mercator with visual parity to the current map; water/invert/relief sliders are
live and instant; deep-zoom tile streaming works.

**Escape hatch:** if this can't hit acceptable quality/perf, fall back to "keep
custom renderer for terrain, MapLibre for vector layers only" and revisit Phase 3.

---

## Phase 3 — Globe projection + retire the old renderers (migration cleanup)

**Why now:** High-impact deletion. Completes the "one renderer" migration and
removes ~1500 lines. Satisfying, and stops double-maintenance.

**Do:**
- Enable MapLibre **globe projection**; confirm the terrain custom layer renders
  correctly under the globe projection matrix across the full zoom range
  (globe → mercator morph handled by MapLibre).
- Delete the now-dead custom stack: `src/tileglobe.js`, `src/handoff.js`,
  `src/map.js`, `src/overlay.js`, old `src/app.js`, `globe.html`, and the old
  `index.html` wiring. Fold any still-needed helpers into `src/world/`.
- Single entry point; single renderer.

**Out of scope:** features.

**Files:** delete the above; consolidate entry/html.

**Acceptance:** one page, one renderer; zooming all the way out shows the inverted
globe, zooming in is the same map — no handoff seam; old files gone; build clean.

---

## Phase 4 — Global field + coastlines + lakes as GeoJSON (first real data; fixes both bugs)

**Why now:** First generated map data and the most visible payoff. Marching-squares
coastlines fix **"no borders along water"**; MapLibre's `geojson-vt` per-zoom
simplification fixes **"horizontal lines when zoomed out"** — both by construction.

**Do:**
- `src/world/field.js`: build ONE global **~4096² elevation field** (zoom 4) in a
  **Web Worker**. (Decide at build time: fetch ~256 z4 Terrarium tiles once and
  cache, vs. upsample the GMT 1° grid already shipped — benchmark, pick.)
- `src/world/gen/coast.js`: marching-squares at the water line → closed coastline
  polygons. Flood-fill from the map edge separates the world ocean from enclosed
  basins → **lakes** (emit as polygon holes / separate lake polygons).
- Output standard **GeoJSON FeatureCollections**; add them as MapLibre GeoJSON
  sources + style layers (coastline stroke, lake fill).
- Regenerate on water-level **settle** (debounced) via `source.setData`; keep the
  drag itself shader-only (instant) as today.

**Out of scope:** rivers, countries, cities.

**Files:** new `src/world/field.js`, `src/world/gen/coast.js`,
`src/world/worker.js`; recipe `lakes` group.

**Acceptance:** coastlines and lakes render as crisp vector layers from globe down
to regional zoom; no horizontal-line artifacts when zoomed out; lakes are visibly
distinct from the world ocean; moving the water slider redraws coasts/lakes after
it settles.

---

## Phase 5 — Hydrology: rivers

**Why now:** Rivers are a headline feature and an input to country borders + city
placement, so they come before both.

**Do:**
- `src/world/gen/hydro.js`: priority-flood depression fill → D8 flow directions →
  upstream-area accumulation; threshold accumulation into a branching river
  network that terminates at lakes/sea. Width scales with flow.
- Emit GeoJSON line features (with a `flow`/`strahler` property for width styling).
- Run inside the existing worker pass; cache so it doesn't recompute on every
  unrelated param change.

**Out of scope:** rivers as borders (consumed in Phase 6), names.

**Files:** new `src/world/gen/hydro.js`; recipe `rivers` group (threshold, etc.).

**Acceptance:** realistic dendritic rivers flow downhill to lakes/sea, width grows
with accumulation; regenerate correctly when water level settles.

---

## Phase 6 — Countries (organic growth, natural borders) ✅ SHIPPED

**Why now:** The explicit pain point. Needs coast (Phase 4) + rivers (Phase 5) as
border affinities. The big realism upgrade over today's equal Voronoi.

**Do:**
- `src/world/gen/countries.js`:
  - Find landmasses (connected coastline components).
  - Scatter capitals weighted by habitability (low slope, near coast/river).
  - Grow territory outward with cost that hugs ridges AND rivers AND coasts;
    per-capital "ambition" weight → deliberately **uneven sizes**.
  - Leave **wilderness** beyond a cost cutoff; allow **short sea crossings**
    (archipelago states), no transoceanic empires.
  - Vectorize regions into closed polygons, clip to coastline, subtract lake
    holes. Stable per-country IDs.
- MapLibre fill + border-line layers, colored per country.

**Shipped differently (note for later phases):** countries render as **borders
only, no fills**, and the border layer draws **only interior frontiers** — land
edges between two different owners (state↔state or state↔wilderness). Edges facing
the sea are not drawn: real political maps don't ink a line along the coast, and
doing so doubled the coastline stroke. Borders are built as **one global network
emitted as a single MultiLineString feature** (shared frontiers traced once, then
Douglas–Peucker-simplified + Chaikin-smoothed off the cell grid so they flow at any
angle). Consequence: there are **no per-country features or `capital`/`id`
properties** on the `countries` source anymore — see the Phase 9 note below.

**Out of scope:** capitals-as-cities (Phase 7), names, manual recolor.

**Files:** new `src/world/gen/countries.js`; recipe `countries` group (count,
ambition spread, sea-crossing cost, wilderness cutoff, ridge/river affinity).

**Acceptance:** filled country polygons with varied sizes; borders visibly follow
ridges/rivers/coasts; wilderness stays uncolored; islands within short seas can
share a country; no gaps/overlaps at coasts.

---

## Phase 7 — Cities (ranked tiers + capitals) ✅ SHIPPED

**Why now:** Depends on countries + hydrology + coast. Adds the populated layer and
the first label collision story.

**Do:**
- `src/world/gen/cities.js`: score land cells for habitability (coast/river/
  confluence, low slope, moderate elevation); greedy placement with Poisson-disk
  min spacing; population/rank → tiers (capital / metropolis / city / town).
  Each country's top interior city = capital. Frontier towns allowed in wilderness.
- MapLibre symbol layers with `rank`-driven size + collision priority (big cities
  win label space). Assign each city its owning country (or none).

**Shipped notes:**
- `computeCities` scores every land cell — flatness + moderate-elevation × additive
  coast/river/**confluence** draws (river/confluence masks come from the Phase 5
  flow field) — then places best-first: land cells are **counting-sorted** into
  score bands (O(N), no comparator over ~2M cells) and walked high→low, each new
  city held a **Poisson-disk** minimum distance from the rest via a spatial hash.
  The `spacing` knob is the hard distance floor; `density` is the soft target count;
  whichever binds first stops placement, keeping the two knobs independent.
- Placement order **is** the population rank. Rank fraction → metropolis/city/town;
  then each country's top-ranked owned city is promoted to **capital**. A city's
  owning country is read straight off the growth `owner` grid (so allegiance always
  matches the territory it sits in); cities on wilderness are frontier **towns** with
  `country: -1`, never capitals. To feed this, `computeCountries` now also returns
  its `owner` + `isLand` arrays (cached in the worker so a density/spacing nudge
  reuses the growth and only re-places cities).
- Rendered as a single `cities-symbol` MapLibre **symbol** layer with two generated
  marker icons (plain dot / ringed-dot capital). `icon-allow-overlap:false` enables
  collision and `symbol-sort-key:rank` makes bigger cities win label space — a dense
  region shows only its top cities zoomed out and reveals the rest as you zoom in.
  Tier + zoom drive `icon-size`. Names are Phase 9, so the marker tier/rank stands
  in for now (no text → no glyph server needed yet). The three Phase 11 presets gain
  a `cities-symbol` entry: full in Relief/Political, **major-only** in Minimal
  (capitals + metropolises via a data-driven `icon-opacity`).

**Out of scope:** name strings (Phase 9 — render placeholder/rank for now).

**Files:** new `src/world/gen/cities.js`; recipe `cities` group (density, spacing).

**Acceptance:** ranked city points with sensible spacing; capitals marked; label
collision resolves cleanly across zoom; cities sit on plausible sites (coasts,
river confluences).

---

## Phase 8 — Bake + persistence (save/export) ✅ SHIPPED

**Why now:** Now there's a full world worth freezing. Unlocks shareable/deployable
worlds and is the substrate manual edits (Phase 10) attach to.

**Do:**
- **Recipe save/load** (already URL-encodable from Phase 1) → also JSON download.
- **IndexedDB autosave** of working state (recipe + future overrides) so reloads
  never lose work.
- **"Download world"** = self-contained bundle: `recipe.json` + per-layer GeoJSON
  (coast/countries/lakes/rivers/cities, with properties) + **baked terrain raster
  tiles** (hybrid bake — snapshot the live shader to static tiles).
- A baked world loads as **pure static MapLibre sources** with no generator/worker.

**Shipped notes:**
- `src/world/persist.js` owns the dull plumbing: an **IndexedDB** store (`inversia`
  / `state` / `working`) autosaves `{ recipe, view:{ style, layerVisibility } }`
  (debounced) on every recipe/style/toggle change, plus tiny `downloadFile` /
  `pickFile` helpers. On load a **shared link wins** (any `group.key` in the hash →
  use it); otherwise the last autosave is restored, so a plain reload never loses an
  unshared world. The state object (not just the recipe) is stored so Phase 10's
  `overrides` key drops in without a migration.
- `src/world/bake.js` does the **hybrid terrain bake**: it runs the *same* shared
  `FRAG` shader (src/terrain.js) over streamed Terrarium tiles in an **offscreen
  WebGL2** context, reads pixels back (flipped to north-up), and PNG-encodes a small
  raster pyramid (**z0..z3**, 85 tiles — enough for globe→regional, small enough to
  bake in seconds). `assembleBundle` packs recipe + the live GeoJSON on screen +
  view prefs + the baked pyramid into one JSON file.
- **Loading a bundle freezes the running map** (`enterBakedMode`): the worker is
  `terminate()`d, the live terrain custom layer is swapped for a `raster` source fed
  by a `maplibregl.addProtocol("baked", …)` loader over the bundled PNG data-URLs,
  and every feature source is `setData`'d straight from the bundle. All regen paths
  guard on a `baked` flag, so nothing recomputes; a reload (which drops baked mode)
  returns to the live, editable world.
- UI: a **"Save / Export"** folder in the recipe panel (Download recipe / Load recipe
  or world… / Download world) plus a transient **toast** for bake progress and
  confirmations. One picker handles both recipe JSON and world bundles (auto-detected
  via `format: "inversia-world"`).

**Out of scope:** names (can bake later), editing.

**Files:** new `src/world/persist.js`, `src/world/bake.js`; load path that detects
a baked bundle and skips generation.

**Acceptance:** download a world → reload it from the bundle with no worker running
and identical appearance; autosave survives a refresh; recipe round-trips.

---

## Phase 9 — Naming (deterministic, per-language-family)

**Why now:** Cosmetic but high-delight; data-model slots were reserved from the
start, so this is mostly additive.

**Do:**
- `src/world/names.js`: Markov/syllable grammar seeded from the world seed →
  deterministic names. Assign each region a **language family** so neighbors share
  phonetic style; derive river/lake/city names from their owning region.
- Write `name` onto feature properties; point label layers at them.

**Note — country labels need their own source:** the `countries` source is now a
single borders-only line feature with no per-country properties (see Phase 6 note),
so country names can't be attached to it. Add a dedicated **country label-point
source** (one point per country at a representative interior point — e.g. its
capital from Phase 7, or a pole-of-inaccessibility) and write `name` there. Rivers/
lakes/cities still carry their own per-feature properties for labeling as planned.

**Out of scope:** LLM naming (explicitly not chosen).

**Files:** new `src/world/names.js`; label layer updates.

**Acceptance:** every country/city/river/lake has a stable name; same seed →
same names; neighboring regions feel linguistically related.

---

## Phase 10 — Manual editing (overrides layer)

**Why now:** Last because it depends on stable IDs and a freezeable world.

**Do:**
- Model edits as an **overrides patch keyed by feature ID**, merged on top of
  generated features, stored in the recipe/bundle and IndexedDB.
- First pass: rename/retag anything, add/move/delete cities, recolor/merge/rename
  countries, **pin** a feature so regen won't move it.
- **Freeze-on-first-edit**: snapshot the generated world so IDs stay stable;
  reseeding starts fresh.
- Defer freehand polygon/line drawing (maplibre-gl-draw) to a later pass.

**Files:** new `src/world/edits.js`; merge step in the layer pipeline; UI hooks.

**Acceptance:** rename a country and move a city; reload → edits persist; reseed →
fresh world; edits survive in a downloaded bundle.

---

## Phase 11 — Map style switcher (Relief / Political-Flat / Minimal) ✅ SHIPPED

> **Shipped early (after Phase 5).** Built against the layers that exist today —
> live terrain (Phase 3), land fill + coast + lakes (Phase 4), rivers (Phase 5).
> Country fills (Phase 6) and labels (Phase 9) aren't built yet, so the flat
> presets express their look with the land fill + coastline-as-borders; those
> later phases slot into the same preset objects in `src/world/styles.js` when
> they land. Land fill is derived in `src/world/gen/coast.js` by closing the coast
> contour into filled polygons. Active style is a view preference (URL `style=` +
> `localStorage`), applied by diffing one persistent style — no `setStyle`.

**Why now:** Last because a true preset switcher needs every layer to exist — land
fill (Phase 4), country fills (Phase 6), labels (Phase 9). Placed after the others
exactly as requested; all dependencies are satisfied by Phase 10.

**Do:**
- `src/world/styles.js`: define **3 declarative style-preset objects** (app-level,
  shared across all worlds), each a plain bundle:
  `{ terrain: {mode, params}, layers: { landFill, borders, countryFills, rivers,
  lakes, cities, labels: {visible, color, width, …} } }`.
  - **Relief** (default): live hypsometric terrain custom layer + hillshade, subtle
    borders, rivers/lakes/labels — today's look.
  - **Political / Flat**: terrain layer hidden; base land fill + per-country fills;
    bold borders; prominent labels — atlas look.
  - **Minimal**: two-tone land/water; only major labels; hairline or no borders.
- `applyStyle(map, preset)`: walk the preset and apply via
  `setLayoutProperty`/`setPaintProperty` for vector layers and terrain custom-layer
  uniforms/visibility. **Diff-based** against the current preset; **instant snap**
  (no transition). ONE persistent MapLibre style — never `setStyle()`; the custom
  terrain layer and live GeoJSON sources stay mounted throughout.
- **Always-mounted land-fill layer**: ensure the Phase 4 coastline land polygon is
  added as a fill layer that's just toggled (hidden in Relief, shown in flat styles);
  country fills (Phase 6) paint on top; wilderness shows the base land color.
- **Active style = view preference** (NOT in the world recipe): encode in the URL
  (so a shared link pins world + style) and remember in `localStorage`. Reseeding
  keeps the style; switching style never touches the world.
- **UI:** a small segmented control / dropdown to pick the style; default Relief.
- Applies identically on **globe and flat map** (same style system, same presets).

**Out of scope:** per-style live tweaking / panel overrides; saving custom named
styles (deferred — would be its own phase). Presets are fixed.

**Bake interaction:** style-independent. Baking always snapshots the **relief**
terrain tiles (source of truth) and bundles all vector layers; the active style is
only a recorded view preference, so a baked world can still switch styles.

**Files:** new `src/world/styles.js`; a style-picker control; ensure land-fill layer
exists from Phase 4; small wiring in the map/recipe/URL layer.

**Acceptance:** switching Relief→Political→Minimal instantly re-presents the same
world (terrain hides/shows, fills and borders change, label density changes);
the choice survives reload (URL + localStorage); reseeding the world keeps the
chosen style; both globe and flat map honor the style.

> **Optional earlier slice:** a bare Relief-vs-Flat *terrain* toggle could land right
> after Phase 4 (land fill exists), but full "Political" needs Phases 6 + 9. Kept at
> Phase 11 per request so all three presets ship complete.

---

## Locked decisions (the 14 forks behind this plan)

1. **MapLibre GL JS v5**, full adoption (real GeoJSON + data-driven styling).
2. Terrain = **hybrid**: live custom-layer shader for exploration, bake static
   tiles on export.
3. Features are **terrain-derived** (grid + marching squares), not a game mesh.
4. Generate from **one global ~4096² field**; let MapLibre `geojson-vt` simplify
   per zoom (deep-zoom crispness deliberately deferred).
5. Countries = **organic growth, uneven sizes, natural borders**.
6. **Wilderness allowed + short sea crossings** (no transoceanic empires).
7. Hydrology = **full flow accumulation** (real dendritic rivers; lakes as holes).
8. Cities = **suitability-weighted, ranked tiers, capitals on top**, frontier
   towns allowed.
9. Names = **procedural, deterministic, per-language-family** (designed early,
   built Phase 9).
10. Parameters = **one typed "world recipe" + auto-generated Tweakpane panel**,
    URL-encodable, doubles as save format.
11. Bake = **self-contained bundle + IndexedDB autosave + file export**.
12. Manual edits = **overrides layer keyed by stable ID**; props + cities first,
    freehand geometry later; freeze-on-first-edit.
13. **Retire the custom globe** for MapLibre native globe projection.
14. Build order = **de-risk first** (shell + terrain port), then generation, then
    recipe/bake/naming/editing.
15. **Style switcher (Phase 11)** = full presentation presets (terrain mode + layer
    visibility + paint) as **declarative data**, applied by diffing one persistent
    style (no `setStyle`). Ship **3 fixed presets** (Relief / Political-Flat /
    Minimal), **instant** switch, **active style is a view preference** (URL +
    localStorage, not in the recipe). No per-style tweaking / custom-style saving
    yet. Flat styles rely on an always-mounted land-fill layer from Phase 4.

### Known deferrals (conscious, not surprises)
- **Deep-zoom coastline crispness:** z4 source goes blocky near street-level zoom;
  the live terrain shader carries detail underneath. Crisp deep-zoom coasts would
  need on-demand tiled generation — a separate large effort.
- **Terrain-port risk:** Phase 2 is the go/no-go gate; escape hatch documented there.
- **Build-time choices:** z4 field acquisition (fetch vs upsample); exact boolean-
  ops lib; worker regen cadence.
