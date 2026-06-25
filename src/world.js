/* ------------------------------------------------------------------ *
 *  Inversia — procedural world platform (MapLibre entry point)
 *
 *  The single entry point and single renderer. It mounts a MapLibre GL map
 *  under globe projection, draws the live inverted terrain as a custom layer
 *  (src/world/terrain-layer.js), and binds the world recipe to: (1) an
 *  auto-generated Tweakpane panel and (2) the URL hash, so edits round-trip
 *  through a shared link. Zooming out shows the inverted globe; zooming in is
 *  the same world flattening into a deep-zoom map — one renderer, no seam.
 *
 *  Phase 4 adds the first GENERATED features: coastlines and lakes, computed in
 *  a Web Worker (src/world/worker.js) from one global elevation field and added
 *  as MapLibre GeoJSON layers on top of the terrain. Dragging the water slider
 *  stays shader-only and instant; the vectors regenerate once the drag settles.
 *  Rivers, countries and cities land in later phases over the same field.
 * ------------------------------------------------------------------ */

import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./world.css";

import { decodeHash, encodeHash, eachField, fromJSON, toJSON } from "./world/recipe.js";
import { createPanel } from "./world/panel.js";
import { createTerrainLayer } from "./world/terrain-layer.js";
import { createLabelRegistry } from "./world/labels.js";
import {
  STYLE_PRESETS, DEFAULT_STYLE, applyStyle, readStyleId, persistStyle,
  createStylePicker, normalizeStyle,
  readLayerVisibility, persistLayerVisibility,
} from "./world/styles.js";
import { loadWorldStat, landFraction } from "./terrain.js";
import { loadState, saveState, downloadFile, pickFile } from "./world/persist.js";
import { bakeTerrain, assembleBundle, isBundle, bakedProtocolLoader, BUNDLE_FORMAT } from "./world/bake.js";

// ---- recipe (single source of truth) ------------------------------------
// Seed it straight from the URL hash so a shared link restores the same world.
const recipe = decodeHash(location.hash);

// ---- active map style (a VIEW preference, NOT part of the recipe) --------
// Resolved from the URL first (shared links pin world + style), then the last
// local choice. It rides alongside the world in the hash and survives reseeds.
let currentStyle = readStyleId(location.hash);

// ---- per-layer visibility (also a VIEW preference) ----------------------
// User show/hide toggles layered on top of the active style. Persisted in
// localStorage, kept out of the world hash. Composes with the style switcher:
// every applyStyle pass honours these overrides.
const layerVisibility = readLayerVisibility();

// ---- base style ----------------------------------------------------------
// A minimal valid style under globe projection: just a solid background sphere
// that the terrain custom layer draws on top of. The background still shows
// through where the terrain can't — behind the globe and in the tiny polar gap
// beyond Web-Mercator's ~±85° limit — so its colour is derived from the recipe
// to stay in keeping with the world.
function baseStyle() {
  return {
    version: 8,
    projection: { type: "globe" },
    sources: {},
    layers: [
      { id: "bg", type: "background", paint: { "background-color": backgroundFor(recipe) } },
    ],
  };
}

// Inverted worlds read cooler/deeper; water level nudges the tone lighter as it
// rises — a quiet backdrop tone behind and beyond the globe.
function backgroundFor(r) {
  const inv = r.world.invert;
  const t = (r.world.water + 8000) / 14000; // 0..1 across the slider range
  const base = inv ? [13, 27, 42] : [20, 38, 28];
  const lift = Math.round(40 * t);
  const [a, b, c] = base.map((ch) => Math.min(255, ch + lift));
  return `rgb(${a}, ${b}, ${c})`;
}

// The background layer IS the whole sea in the flat presets (terrain hidden), so
// its colour is style-dependent: a flat ocean tint when the preset declares one,
// otherwise the recipe-derived backdrop that `relief` shows behind the globe.
function applyBackground() {
  if (!map.getLayer("bg")) return;
  const ocean = STYLE_PRESETS[normalizeStyle(currentStyle)].ocean;
  map.setPaintProperty("bg", "background-color", ocean ?? backgroundFor(recipe));
}

const map = new maplibregl.Map({
  container: "map",
  style: baseStyle(),
  center: [0, 20],
  zoom: 2,
  // Phase 3: the style declares globe projection. The terrain custom layer
  // projects through MapLibre's own `projectTile`, so it follows the
  // globe⇄mercator morph for free — panning spins the planet, zooming in
  // flattens it into the map with no handoff seam.
  attributionControl: false,
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true, showCompass: true }), "bottom-right");
map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");

// The live inverted terrain renderer. It reads invert/water/relief straight off
// the recipe each frame, so panel edits show instantly — we only nudge a repaint.
const terrain = createTerrainLayer(recipe);

// Phase 9: place names render as canvas-drawn icon images (no glyph server), so
// the label layers stay self-contained and bake cleanly. The registry caches one
// image per distinct label and drops the unreferenced ones after each regen.
const labels = createLabelRegistry(map);

function applyRecipeToMap() {
  applyBackground();
  // terrain reads the recipe live; just ask MapLibre to repaint with the new uniforms
  if (map.getLayer(terrain.id)) map.triggerRepaint();
  scheduleStats();
  scheduleFeatures();
}

// ---- generated features: coastlines + lakes (Phase 4) -------------------
// Computed off-thread from one global elevation field. The worker decodes the
// field once and re-runs the coast/lake pass whenever the water line, inversion
// or lake-size floor settles — the drag itself never touches it (shader-only).
const worker = new Worker(new URL("./world/worker.js", import.meta.url), { type: "module" });
const emptyFC = () => ({ type: "FeatureCollection", features: [] });

// Phase 8: once a baked bundle is loaded the world is frozen — the worker is gone
// and the static sources own the geometry, so every regen path becomes a no-op.
let baked = false;
// The most recent feature payload from the worker, kept so "Download world" can
// bundle the exact GeoJSON on screen without re-asking the worker.
let lastFeatures = null;
const featureWaiters = []; // resolvers awaiting the first/next generation

let featTimer = 0;
let featReqId = 0;       // newest request issued
let featAckId = 0;       // newest response applied (drop anything older / stale)
let lastSig = "";        // params last sent — skip regen when nothing relevant changed

// The water line, inversion, lake-size floor, river threshold AND the seed +
// country knobs change the geometry; relief and other knobs leave it untouched.
// We fingerprint just the geometry-affecting ones and skip the worker round-trip
// when none of them moved.
function featureSig() {
  const c = recipe.countries;
  const ci = recipe.cities;
  return [
    recipe.world.water, recipe.world.invert ? 1 : 0,
    recipe.lakes.minSize, recipe.rivers.threshold,
    recipe.seed.seed, c.count, c.areaSkew, c.ambition, c.ridge, c.river, c.seaCross,
    ci.density, ci.spacing,
  ].join("|");
}

function requestFeatures() {
  if (baked) return;              // frozen world — the worker is gone
  const sig = featureSig();
  if (sig === lastSig) return;
  lastSig = sig;
  const c = recipe.countries;
  worker.postMessage({
    type: "generate",
    id: ++featReqId,
    water: recipe.world.water,
    invert: recipe.world.invert,
    minSize: recipe.lakes.minSize,
    threshold: recipe.rivers.threshold,
    seed: recipe.seed.seed,
    count: c.count,
    areaSkew: c.areaSkew,
    ambition: c.ambition,
    ridge: c.ridge,
    river: c.river,
    seaCross: c.seaCross,
    density: recipe.cities.density,
    spacing: recipe.cities.spacing,
  });
}

// Debounced so a slider drag fires one regeneration on settle, not per frame.
function scheduleFeatures() {
  clearTimeout(featTimer);
  featTimer = setTimeout(requestFeatures, 250);
}

worker.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === "error") { console.warn("[features] worker error:", msg.message); return; }
  if (msg.type !== "features") return;
  if (msg.id < featAckId) return;          // a newer response already landed
  featAckId = msg.id;

  const payload = {
    coast: msg.coast, land: msg.land, lakes: msg.lakes, rivers: msg.rivers,
    countries: msg.countries, cities: msg.cities, countryLabels: msg.countryLabels,
  };
  applyFeatures(payload);

  // Keep the live GeoJSON around so a bundle can freeze exactly what's on screen,
  // and release anyone awaiting the first generation (e.g. an early bake click).
  lastFeatures = payload;
  while (featureWaiters.length) featureWaiters.shift()(lastFeatures);
};

// Register a label image per named feature in `fc`, stamp the image id onto each
// feature's `labelImg` (what the symbol layer reads), and return the ids used so
// the caller can garbage-collect the rest. Features with no `name` are skipped.
function labelFC(fc, role, sink) {
  for (const f of fc?.features ?? []) {
    const nm = f.properties?.name;
    if (!nm) continue;
    const id = labels.ensure(nm, role);
    (f.properties ??= {}).labelImg = id;
    sink.add(id);
  }
}

// Push a full feature payload to the map: name → image for every label layer,
// drop the now-unreferenced label images, then setData every source. Shared by
// the live worker path and the baked-bundle load so labels behave identically.
function applyFeatures(p) {
  const need = new Set();
  labelFC(p.countryLabels, "country", need);
  labelFC(p.cities, "city", need);
  labelFC(p.rivers, "river", need);
  labelFC(p.lakes, "lake", need);
  labels.gc(need);

  const empty = emptyFC();
  map.getSource("coast")?.setData(p.coast || empty);
  map.getSource("land")?.setData(p.land || empty);
  map.getSource("countries")?.setData(p.countries || empty);
  map.getSource("lakes")?.setData(p.lakes || empty);
  map.getSource("rivers")?.setData(p.rivers || empty);
  map.getSource("cities")?.setData(p.cities || empty);
  map.getSource("country-labels")?.setData(p.countryLabels || empty);
}

// Resolve with the current feature payload, awaiting the first generation if it
// hasn't landed yet. Used by the bundle export so it never ships empty layers.
function ensureFeatures() {
  if (lastFeatures) return Promise.resolve(lastFeatures);
  requestFeatures();
  return new Promise((resolve) => featureWaiters.push(resolve));
}

// Coast stroke + lake fill, styled to read as one world. The terrain shader
// already paints below-water areas as sea, so the lake fill is a distinct,
// slightly brighter tint laid over it — that contrast is what separates an
// enclosed lake from the world ocean. Coast width grows with zoom so the line
// stays hairline on the globe and reads at regional zoom.
function addFeatureLayers() {
  map.addSource("land", { type: "geojson", data: emptyFC() });
  map.addSource("countries", { type: "geojson", data: emptyFC() });
  map.addSource("lakes", { type: "geojson", data: emptyFC() });
  map.addSource("coast", { type: "geojson", data: emptyFC() });
  map.addSource("rivers", { type: "geojson", data: emptyFC() });
  map.addSource("cities", { type: "geojson", data: emptyFC() });
  // Phase 9: one label point per country (the borders source has no per-country
  // features to hang a name on — see the Phase 6/9 notes in docs/world-plan.md).
  map.addSource("country-labels", { type: "geojson", data: emptyFC() });

  // Always-mounted land fill — hidden in Relief (the terrain shader paints the
  // land), shown in the flat presets where it IS the land. Sits just above the
  // terrain so the flat ocean (background) shows through everywhere it isn't.
  map.addLayer({
    id: "land-fill",
    type: "fill",
    source: "land",
    layout: { visibility: "none" },
    paint: { "fill-color": "#ece6d6", "fill-opacity": 1 },
  });

  // Country territories (Phase 6) — drawn as outlines only, no fill. The border
  // traces each country's edge; every land cell belongs to some country (no
  // wilderness), so a line appears only between two states. Sits above the land
  // fill and below the lakes/coast/rivers so water
  // features and the coastline always read on top. Width + opacity are the per-
  // style levers (subtle over the terrain in Relief, bold in Political, hidden in
  // Minimal — see styles.js).
  map.addLayer({
    id: "country-border",
    type: "line",
    source: "countries",
    layout: { "line-join": "round" },
    paint: {
      "line-color": "#5b4a36",
      "line-opacity": 0.8,
      "line-width": ["interpolate", ["linear"], ["zoom"], 0, 0.5, 4, 1.3, 8, 2.4],
    },
  });

  map.addLayer({
    id: "lakes-fill",
    type: "fill",
    source: "lakes",
    paint: { "fill-color": "#3aa0c9", "fill-opacity": 0.45 },
  });
  map.addLayer({
    id: "lakes-line",
    type: "line",
    source: "lakes",
    paint: { "line-color": "#bfe6f2", "line-width": 0.6, "line-opacity": 0.5 },
  });
  map.addLayer({
    id: "coast-line",
    type: "line",
    source: "coast",
    paint: {
      "line-color": "#0b1a26",
      "line-opacity": 0.85,
      "line-width": ["interpolate", ["linear"], ["zoom"], 0, 0.4, 4, 0.9, 8, 1.6],
    },
  });

  // Rivers sit on top of the land, painted over the coast. Width grows with the
  // Strahler order so trickling headwaters stay hairline while continental trunks
  // read boldly; the per-feature order also feeds the zoom interpolation so the
  // whole network thickens together as you zoom in. Round caps/joins keep the
  // dendritic branching smooth where segments meet at confluences.
  map.addLayer({
    id: "rivers-line",
    type: "line",
    source: "rivers",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "#2b7fb8",
      "line-opacity": 0.9,
      "line-width": [
        "interpolate", ["linear"], ["zoom"],
        0, ["*", ["get", "strahler"], 0.18],
        4, ["*", ["get", "strahler"], 0.7],
        8, ["*", ["get", "strahler"], 1.7],
      ],
    },
  });

  // Cities (Phase 7) — the populated layer, topmost so settlements read over every
  // other feature. Two generated marker images: a plain dot for ordinary cities and
  // a ringed dot for capitals. `icon-allow-overlap:false` turns on MapLibre's label
  // collision, and `symbol-sort-key:rank` (1 = biggest) makes the larger cities win
  // that space — so a dense region shows only its top cities zoomed out and reveals
  // the rest as you zoom in. Size steps up per tier and per zoom. Names are Phase 9;
  // until then the marker tier/rank stands in (no text → no glyphs needed yet).
  registerCityIcons();
  map.addLayer({
    id: "cities-symbol",
    type: "symbol",
    source: "cities",
    layout: {
      "icon-image": ["match", ["get", "tier"], "capital", "city-capital", "city-dot"],
      "icon-size": [
        "interpolate", ["linear"], ["zoom"],
        0, ["match", ["get", "tier"], "capital", 0.55, "metropolis", 0.45, "city", 0.32, 0.22],
        4, ["match", ["get", "tier"], "capital", 0.85, "metropolis", 0.65, "city", 0.46, 0.32],
        8, ["match", ["get", "tier"], "capital", 1.25, "metropolis", 0.95, "city", 0.7, 0.5],
      ],
      "icon-allow-overlap": false,
      "icon-ignore-placement": false,
      "icon-padding": 2,
      "symbol-sort-key": ["get", "rank"],
    },
    paint: { "icon-opacity": 1 },
  });

  // ---- labels (Phase 9) --------------------------------------------------
  // Text is pre-rendered to icon images (src/world/labels.js) — no glyph server —
  // and referenced per feature via `icon-image: ["get","labelImg"]`. Every label
  // layer keeps collision on (`icon-allow-overlap:false`) so labels never stack;
  // `symbol-sort-key` decides who wins the space (bigger country / higher-ranked
  // city first). These sit topmost so names read over every other feature.

  // Country names — at each country's territorial centroid; the biggest territory
  // wins placement (most-negative sort key = highest priority).
  map.addLayer({
    id: "country-label",
    type: "symbol",
    source: "country-labels",
    layout: {
      "icon-image": ["get", "labelImg"],
      "icon-allow-overlap": false,
      "icon-ignore-placement": false,
      "icon-padding": 4,
      "symbol-sort-key": ["*", -1, ["get", "size"]],
    },
    paint: { "icon-opacity": 0.92 },
  });

  // City names — sit just to the right of the dot (anchor left + offset), and
  // inherit the dot's rank so the largest cities label first under collision.
  map.addLayer({
    id: "cities-label",
    type: "symbol",
    source: "cities",
    layout: {
      "icon-image": ["get", "labelImg"],
      "icon-anchor": "left",
      "icon-offset": [11, 0],
      "icon-allow-overlap": false,
      "icon-padding": 2,
      "symbol-sort-key": ["get", "rank"],
    },
    paint: { "icon-opacity": 1 },
  });

  // River names — a single point label near the channel's middle (point placement
  // on the line geometry). Curved line-following text wants glyphs, deferred.
  map.addLayer({
    id: "rivers-label",
    type: "symbol",
    source: "rivers",
    layout: {
      "icon-image": ["get", "labelImg"],
      "symbol-placement": "point",
      "icon-allow-overlap": false,
      "icon-padding": 2,
    },
    paint: { "icon-opacity": 0.9 },
  });

  // Lake names — at the polygon centroid.
  map.addLayer({
    id: "lakes-label",
    type: "symbol",
    source: "lakes",
    layout: {
      "icon-image": ["get", "labelImg"],
      "icon-allow-overlap": false,
      "icon-padding": 2,
    },
    paint: { "icon-opacity": 0.9 },
  });

  // Style switches are an INSTANT snap (no cross-fade): zero out the paint
  // transitions on every property a preset touches so swapping Relief↔Political↔
  // Minimal re-presents the world immediately rather than dissolving through it.
  const snap = { duration: 0 };
  for (const [layer, prop] of [
    ["land-fill", "fill-color-transition"], ["land-fill", "fill-opacity-transition"],
    ["country-border", "line-color-transition"], ["country-border", "line-opacity-transition"],
    ["lakes-fill", "fill-color-transition"], ["lakes-fill", "fill-opacity-transition"],
    ["lakes-line", "line-color-transition"], ["lakes-line", "line-opacity-transition"],
    ["coast-line", "line-color-transition"], ["coast-line", "line-opacity-transition"],
    ["rivers-line", "line-color-transition"], ["rivers-line", "line-opacity-transition"],
    ["cities-symbol", "icon-opacity-transition"],
    ["country-label", "icon-opacity-transition"],
    ["cities-label", "icon-opacity-transition"],
    ["rivers-label", "icon-opacity-transition"],
    ["lakes-label", "icon-opacity-transition"],
    ["bg", "background-color-transition"],
  ]) {
    try { map.setPaintProperty(layer, prop, snap); } catch { /* ignore */ }
  }
}

// ---- city marker icons ---------------------------------------------------
// Drawn once into an offscreen canvas and registered with the map. Plain RGBA
// (not SDF) — a light fill with a dark outline reads over both the relief terrain
// and the flat paper land. Rendered at 2× and added with pixelRatio 2 so the
// markers stay crisp; `icon-size` scales them per tier/zoom.
function cityDot(diameter, ring) {
  const s = diameter * 2; // 2× supersample
  const cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const ctx = cv.getContext("2d");
  const cx = s / 2, cy = s / 2;
  const r = s / 2 - 2.5;
  if (ring) {
    // capital: a dark outer ring around a light disc, with a small dark centre
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = "#7a1f1f"; ctx.fill();
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.62, 0, Math.PI * 2);
    ctx.fillStyle = "#fbf7ef"; ctx.fill();
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.28, 0, Math.PI * 2);
    ctx.fillStyle = "#7a1f1f"; ctx.fill();
  } else {
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = "#fbf7ef"; ctx.fill();
    ctx.lineWidth = s * 0.14; ctx.strokeStyle = "#1a2230"; ctx.stroke();
  }
  return ctx.getImageData(0, 0, s, s);
}

function registerCityIcons() {
  if (!map.hasImage("city-dot")) map.addImage("city-dot", cityDot(18, false), { pixelRatio: 2 });
  if (!map.hasImage("city-capital")) map.addImage("city-capital", cityDot(22, true), { pixelRatio: 2 });
}

// ---- recipe → URL hash ---------------------------------------------------
// Keep a deep-link in the address bar; replaceState avoids history spam. The
// active style rides alongside the world params as a separate `style` key (only
// when it differs from the default), so the link pins both world AND look.
function syncHash() {
  const p = new URLSearchParams(encodeHash(recipe));
  if (normalizeStyle(currentStyle) !== DEFAULT_STYLE) p.set("style", currentStyle);
  const h = p.toString();
  history.replaceState(null, "", h ? `#${h}` : location.pathname + location.search);
}

// ---- map style switching -------------------------------------------------
// Diff the chosen preset onto the one persistent style — never `setStyle`, so the
// terrain layer and live sources stay mounted. Switching style never touches the
// world; it only re-presents it, persists the choice, and refreshes the link.
function setMapStyle(id) {
  currentStyle = normalizeStyle(id);
  applyStyle(map, terrain.id, currentStyle, layerVisibility);
  applyBackground();
  persistStyle(currentStyle);
  picker.setActive(currentStyle);
  syncHash();
  scheduleAutosave();
}

// Re-present the world under the current style with the new layer toggles, and
// remember the choice. Never touches the recipe or the world geometry.
function setLayerVisibility(vis) {
  applyStyle(map, terrain.id, currentStyle, vis);
  persistLayerVisibility(vis);
  scheduleAutosave();
}

// ---- autosave (IndexedDB) ------------------------------------------------
// Snapshot the working state — recipe + view preferences — so a plain reload
// restores exactly what was on screen even without the URL hash. Debounced in
// persist.js; we pass a fresh object each time so it's a stable snapshot.
function scheduleAutosave() {
  saveState({
    recipe: JSON.parse(JSON.stringify(recipe)),
    view: { style: currentStyle, layerVisibility },
  });
}

// ---- auto-generated control panel ----------------------------------------
const panel = createPanel({
  container: document.getElementById("panel"),
  recipe,
  onChange: () => {
    applyRecipeToMap();
    syncHash();
    scheduleAutosave();
  },
  view: { visibility: layerVisibility, onChange: setLayerVisibility },
});

// ---- save / export (Phase 8) ---------------------------------------------
// Bolted onto the recipe pane as a plain folder of buttons: recipe JSON in/out,
// and the self-contained "Download world" bundle (recipe + GeoJSON + baked terrain).
const io = panel.pane.addFolder({ title: "Save / Export", expanded: false });
io.addButton({ title: "Download recipe (.json)" }).on("click", downloadRecipe);
io.addButton({ title: "Load recipe / world…" }).on("click", loadFromFile);
io.addButton({ title: "Download world (bake)" }).on("click", downloadWorld);

// Copy a loaded recipe INTO the live object in place (every module holds the same
// reference). We launder through fromJSON so an old/hand-edited file can't smuggle
// in out-of-range or wrong-typed values.
function assignRecipe(src) {
  const clean = fromJSON(src);
  for (const { group, key } of eachField()) (recipe[group] ??= {})[key] = clean[group][key];
}

// Download just the recipe — the small, shareable save format (also the URL hash).
function downloadRecipe() {
  downloadFile(`inversia-recipe-${recipe.seed.seed}.json`, toJSON(recipe));
  toast("Recipe downloaded ✓");
}

// One picker for both: a full world bundle switches into baked (frozen) mode; any
// other JSON is treated as a recipe and applied live.
async function loadFromFile() {
  const file = await pickFile();
  if (!file) return;
  let parsed;
  try { parsed = JSON.parse(await file.text()); }
  catch { toast("Not a valid JSON file"); return; }

  if (isBundle(parsed)) { enterBakedMode(parsed); return; }

  assignRecipe(parsed);
  panel.refresh();
  applyRecipeToMap();
  syncHash();
  scheduleAutosave();
  toast("Recipe loaded ✓");
}

// "Download world": freeze the live world into a self-contained bundle — the
// recipe, the exact GeoJSON on screen, the view preferences, and a baked terrain
// raster pyramid (the live shader snapshotted to static tiles). Reloads with no
// worker. The terrain bake is the slow part, so we narrate progress via the toast.
async function downloadWorld() {
  if (baked) { toast("This is already a baked world"); return; }
  toast("Baking terrain…", 0);
  try {
    const layers = await ensureFeatures();
    const terrainBundle = await bakeTerrain(recipe, {
      onProgress: (done, total) => toast(`Baking terrain… ${done}/${total} tiles`, 0),
    });
    const bundle = assembleBundle({
      recipe: fromJSON(recipe),                 // clean deep copy
      view: { style: currentStyle, layerVisibility },
      layers,
      terrain: terrainBundle,
      savedAt: new Date().toISOString(),
    });
    downloadFile(`inversia-world-${recipe.seed.seed}.json`, JSON.stringify(bundle));
    toast("World downloaded ✓");
  } catch (err) {
    console.error("[bake] failed:", err);
    toast("Bake failed — see console");
  }
}

// Switch the running map into a frozen, static world: terminate the worker, swap
// the live terrain custom layer for a baked raster source, and fill every feature
// source straight from the bundle. No generation runs after this — a reload (which
// drops baked mode) returns to the live, editable world.
let bakedRegistered = false;
function enterBakedMode(bundle) {
  baked = true;
  worker.terminate();

  // recipe + view from the bundle, for display and an accurate URL/link.
  assignRecipe(bundle.recipe || {});
  panel.refresh();

  // terrain: drop the custom shader layer, serve the baked PNG pyramid as raster.
  if (map.getLayer(terrain.id)) map.removeLayer(terrain.id);
  if (bakedRegistered) maplibregl.removeProtocol("baked");
  maplibregl.addProtocol("baked", bakedProtocolLoader(bundle.terrain.tiles));
  bakedRegistered = true;
  if (map.getLayer("baked-terrain")) map.removeLayer("baked-terrain");
  if (map.getSource("baked-terrain")) map.removeSource("baked-terrain");
  map.addSource("baked-terrain", {
    type: "raster",
    tiles: ["baked://{z}/{x}/{y}"],
    tileSize: bundle.terrain.tileSize || 256,
    minzoom: bundle.terrain.minzoom ?? 0,
    maxzoom: bundle.terrain.maxzoom ?? 3,
  });
  map.addLayer(
    { id: "baked-terrain", type: "raster", source: "baked-terrain", paint: { "raster-fade-duration": 0 } },
    "land-fill",                                // keep it beneath the vector layers
  );

  // static features straight from the bundle — no worker round-trip. Route through
  // applyFeatures so the label images are re-registered from the bundled `name`
  // properties (a fresh page has an empty registry). Older bundles without a
  // countryLabels layer simply show no country names.
  applyFeatures(bundle.layers);

  // honour the saved view preference (style + toggles), then re-present.
  if (bundle.view?.layerVisibility) Object.assign(layerVisibility, bundle.view.layerVisibility);
  if (bundle.view?.style) currentStyle = normalizeStyle(bundle.view.style);
  applyStyle(map, terrain.id, currentStyle, layerVisibility);
  applyBackground();
  picker.setActive(currentStyle);
  syncHash();
  toast("Baked world loaded — generator stopped. Reload to edit live.", 4000);
}

// ---- transient toast -----------------------------------------------------
// Lightweight status line for the export/import flow (bake progress, confirmations).
// ms = 0 keeps it sticky until the next toast replaces it.
let toastEl = null;
let toastTimer = 0;
function toast(msg, ms = 2400) {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.id = "toast";
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  if (ms) toastTimer = setTimeout(() => toastEl.classList.remove("show"), ms);
}

// ---- map-style picker ----------------------------------------------------
// A small segmented control (Relief / Political / Minimal). It reflects the
// resolved-from-URL choice on load and drives setMapStyle on click.
const picker = createStylePicker({
  current: currentStyle,
  onSelect: setMapStyle,
});
document.body.appendChild(picker.el);

// ---- land / ocean readout ------------------------------------------------
// Cheap global statistic from the decoded z0 world tile. Recomputed on settle
// (debounced) rather than per-drag frame so dragging the water slider stays
// shader-only and instant, matching the legacy app.
const statsEl = document.getElementById("stats");
let statsTimer = 0;
function refreshStats() {
  const lf = landFraction(recipe.world.invert ? 1 : 0, recipe.world.water);
  if (lf == null || !statsEl) return;
  statsEl.textContent = `land ${(lf * 100).toFixed(1)}% · ocean ${((1 - lf) * 100).toFixed(1)}%`;
}
function scheduleStats() {
  clearTimeout(statsTimer);
  statsTimer = setTimeout(refreshStats, 120);
}

// ---- go ------------------------------------------------------------------
map.on("load", () => {
  applyRecipeToMap();
  map.addLayer(terrain);  // above the placeholder background
  addFeatureLayers();     // land + coast + lakes + rivers sit on top of the terrain
  applyStyle(map, terrain.id, currentStyle, layerVisibility); // resolved style + toggles from the start
  applyBackground();
  requestFeatures();      // first generation (bypasses the settle debounce)
});
loadWorldStat().then(refreshStats);
syncHash();

// ---- autosave restore ----------------------------------------------------
// A shared link (recipe in the hash) always wins; otherwise restore the last
// autosaved working state so a plain reload never loses an unshared world.
function hashHasRecipe() {
  const p = new URLSearchParams(location.hash.replace(/^#/, ""));
  for (const { group, key } of eachField()) if (p.has(`${group}.${key}`)) return true;
  return false;
}
if (!hashHasRecipe()) {
  loadState().then((saved) => {
    if (baked || !saved?.recipe || hashHasRecipe()) return;
    assignRecipe(saved.recipe);
    if (saved.view?.layerVisibility) {
      Object.assign(layerVisibility, saved.view.layerVisibility);
      setLayerVisibility(layerVisibility);
    }
    if (saved.view?.style) setMapStyle(saved.view.style);
    panel.refresh();
    applyRecipeToMap();
    syncHash();
  });
}

// expose for quick console poking during development
if (import.meta.env?.DEV) Object.assign(window, { map, recipe });
