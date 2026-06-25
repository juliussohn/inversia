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

import { decodeHash, encodeHash, eachField, fromJSON, toJSON, CLIMATE_FIELDS } from "./world/recipe.js";
import { createPanel } from "./world/panel.js";
import { createTerrainLayer } from "./world/terrain-layer.js";
import { BIOME_PALETTE } from "./world/biome-palette.js";
import {
  STYLE_PRESETS, DEFAULT_STYLE, applyStyle, readStyleId, persistStyle,
  createStylePicker, normalizeStyle,
  readLayerVisibility, persistLayerVisibility, showReliefPreview,
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
// Vite serves /public at BASE_URL ("/" in dev, "/inversia/" on Pages). Glyphs are
// self-hosted (public/fonts/) so labels render with no external glyph server and a
// baked world stays self-contained; MapLibre substitutes {fontstack}/{range}.
const BASE = import.meta.env?.BASE_URL ?? "/";

function baseStyle() {
  return {
    version: 8,
    projection: { type: "globe" },
    glyphs: `${BASE}fonts/{fontstack}/{range}.pbf`,
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

// ---- generation loader ---------------------------------------------------
// A small overlay that narrates what the worker is doing, stage by stage. The
// worker posts a `progress` step before each pass (see worker.js); we map those
// keys to friendly lines. Shown when a request is dispatched, hidden when its
// features land.
const STAGE_LABELS = {
  start: "Generating world…",
  coast: "Tracing coastlines…",
  rivers: "Carving rivers…",
  countries: "Drawing borders…",
  cities: "Founding cities…",
  biome: "Painting climates…",
  naming: "Naming places…",
};
let loaderEl = null;
function loader() {
  if (!loaderEl) {
    loaderEl = document.createElement("div");
    loaderEl.id = "gen-loader";
    loaderEl.innerHTML = '<span class="gen-spinner"></span><span class="gen-text"></span>';
    document.body.appendChild(loaderEl);
  }
  return loaderEl;
}
function showLoader(stage = "start") {
  const el = loader();
  el.querySelector(".gen-text").textContent = STAGE_LABELS[stage] || STAGE_LABELS.start;
  el.classList.add("show");
}
function hideLoader() {
  loaderEl?.classList.remove("show");
}

// ---- relief preview during regeneration ----------------------------------
// Whenever the world is regenerating, every generated layer (coast/rivers/
// borders/cities/labels) is stale, so we drop to the terrain-only relief preview
// — the shader is always live — and hold there until the FRESH features have
// actually rendered, then restore the target style. Revealing on the map's
// `idle` (not the instant `setData` returns) is what stops the previous borders
// flashing back for a frame before the new geometry finishes parsing.
let previewActive = false;
function enterPreview() {
  if (baked || previewActive) return;    // frozen world has no live terrain shader
  previewActive = true;
  showReliefPreview(map, terrain.id);
}
function restorePreview() {
  previewActive = false;
  applyStyle(map, terrain, currentStyle, layerVisibility);
}
// Reveal the refreshed layers only once they've rendered. `setData` parses on a
// worker, so the layer would briefly show its OLD data if we un-hid it right
// away; waiting for `idle` guarantees the new geometry is on screen first. The
// timeout is a safety net in case no repaint is queued and `idle` never fires.
// Both paths bail if a newer regen is already in flight (featAckId !== featReqId)
// — we stay in the preview until that latest one lands instead.
function revealWhenRendered() {
  const finish = () => {
    if (previewActive && featAckId === featReqId) {
      restorePreview();
      hideLoader();
    }
  };
  map.once("idle", finish);
  setTimeout(finish, 800);
}

// The water line, inversion, lake-size floor, river threshold AND the seed +
// country knobs change the geometry; relief and other knobs leave it untouched.
// We fingerprint just the geometry-affecting ones and skip the worker round-trip
// when none of them moved.
function featureSig() {
  const c = recipe.countries;
  const ci = recipe.cities;
  const cl = recipe.climate;
  return [
    recipe.world.water, recipe.world.invert ? 1 : 0,
    recipe.lakes.minSize, recipe.rivers.threshold,
    recipe.seed.seed, c.count, c.areaSkew, c.ambition, c.ridge, c.river, c.seaCross,
    c.minArea, c.seaReach, c.riverBorders,
    ci.density, ci.spacing, ci.coastPull, ci.riverPull, ci.lowland, ci.bigCityShare,
    ...CLIMATE_FIELDS.map((k) => cl[k]),
  ].join("|");
}

function requestFeatures() {
  if (baked) return;              // frozen world — the worker is gone
  const sig = featureSig();
  if (sig === lastSig) return;
  lastSig = sig;
  showLoader();                   // narrated stage-by-stage as the worker reports in
  enterPreview();                 // hold the relief preview until the fresh layers render
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
    minArea: c.minArea,
    seaReach: c.seaReach,
    riverBorders: c.riverBorders,
    density: recipe.cities.density,
    spacing: recipe.cities.spacing,
    coastPull: recipe.cities.coastPull,
    riverPull: recipe.cities.riverPull,
    lowland: recipe.cities.lowland,
    bigCityShare: recipe.cities.bigCityShare,
    ...Object.fromEntries(CLIMATE_FIELDS.map((k) => [k, recipe.climate[k]])),
  });
}

// Debounced so a slider drag fires one regeneration on settle, not per frame.
function scheduleFeatures() {
  clearTimeout(featTimer);
  featTimer = setTimeout(requestFeatures, 250);
}

worker.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === "error") {
    console.warn("[features] worker error:", msg.message);
    hideLoader();
    if (previewActive) restorePreview();   // don't strand the world on the relief preview
    return;
  }
  // Stage narration for the loader — ignore steps from a superseded request.
  if (msg.type === "progress") { if (msg.id >= featReqId) showLoader(msg.stage); return; }
  if (msg.type !== "features") return;
  if (msg.id < featAckId) return;          // a newer response already landed
  featAckId = msg.id;

  const payload = {
    coast: msg.coast, land: msg.land, lakes: msg.lakes, rivers: msg.rivers,
    countries: msg.countries, cities: msg.cities, countryLabels: msg.countryLabels,
    oceanLabels: msg.oceanLabels, continentLabels: msg.continentLabels,
    biomes: msg.biomes,
  };
  applyFeatures(payload);

  // Generation done. If we're holding the relief preview, keep it up until the
  // just-set geometry has actually rendered, then restore the style + drop the
  // loader (see revealWhenRendered). Otherwise just drop the loader.
  if (previewActive) revealWhenRendered();
  else hideLoader();

  // Keep the live GeoJSON around so a bundle can freeze exactly what's on screen,
  // and release anyone awaiting the first generation (e.g. an early bake click).
  lastFeatures = payload;
  while (featureWaiters.length) featureWaiters.shift()(lastFeatures);
};

// Push a full feature payload to the map: setData every source. The label layers
// read names straight off the feature properties via `text-field: ["get","name"]`
// (the worker wrote them), so there's nothing to register here. Shared by the live
// worker path and the baked-bundle load so labels behave identically.
function applyFeatures(p) {
  const empty = emptyFC();
  map.getSource("coast")?.setData(p.coast || empty);
  map.getSource("land")?.setData(p.land || empty);
  map.getSource("biome")?.setData(p.biomes || empty);
  map.getSource("countries")?.setData(p.countries || empty);
  map.getSource("lakes")?.setData(p.lakes || empty);
  map.getSource("rivers")?.setData(p.rivers || empty);
  map.getSource("cities")?.setData(p.cities || empty);
  map.getSource("country-labels")?.setData(p.countryLabels || empty);
  map.getSource("ocean-labels")?.setData(p.oceanLabels || empty);
  map.getSource("continent-labels")?.setData(p.continentLabels || empty);
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
  map.addSource("biome", { type: "geojson", data: emptyFC() });
  map.addSource("countries", { type: "geojson", data: emptyFC() });
  map.addSource("lakes", { type: "geojson", data: emptyFC() });
  map.addSource("coast", { type: "geojson", data: emptyFC() });
  map.addSource("rivers", { type: "geojson", data: emptyFC() });
  map.addSource("cities", { type: "geojson", data: emptyFC() });
  // Phase 9: one label point per country (the borders source has no per-country
  // features to hang a name on — see the Phase 6/9 notes in docs/world-plan.md).
  map.addSource("country-labels", { type: "geojson", data: emptyFC() });
  // Phase 12: one label per drowned continent ("African Ocean"), placed where that
  // continent sits today (now water in the inverted world — see names.js).
  map.addSource("ocean-labels", { type: "geojson", data: emptyFC() });
  // Phase 12: the mirror — one label per risen ocean ("Pacifica"), placed where
  // that ocean lies today (now land in the inverted world).
  map.addSource("continent-labels", { type: "geojson", data: emptyFC() });

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

  // Land-cover zones (the "Natural" style) — crisp flat tints, one fill per biome
  // class, traced into vector polygons by the worker. Sits just above the terrain
  // (which it renders as a neutral relief beneath) and below borders/water/labels.
  // A slight transparency lets the hillshade read through, so the terrain still
  // shows. Hidden in every other style. Ids + colours come from BIOME_PALETTE, the
  // shared contract the worker classifies against (src/world/biome-palette.js).
  map.addLayer({
    id: "biome-fill",
    type: "fill",
    source: "biome",
    layout: { visibility: "none" },
    paint: {
      "fill-color": [
        "match", ["get", "biome"],
        ...BIOME_PALETTE.flatMap(([id, color]) => [id, color]),
        "#cdd3c6", // fallback (tundra) for any unclassified cell
      ],
      "fill-opacity": 0.88,
    },
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
      // One dot image for every settlement; tier only nudges the size. Capitals
      // read just a touch larger than a metropolis — a subtle step, not a jump.
      "icon-image": "city-dot",
      "icon-size": [
        "interpolate", ["linear"], ["zoom"],
        0, ["match", ["get", "tier"], "capital", 0.3, "metropolis", 0.27, "city", 0.24, 0.21],
        4, ["match", ["get", "tier"], "capital", 0.42, "metropolis", 0.38, "city", 0.34, 0.3],
        8, ["match", ["get", "tier"], "capital", 0.58, "metropolis", 0.52, "city", 0.46, 0.4],
      ],
      // Dots always draw (allow-overlap) and don't reserve collision space
      // (ignore-placement) — like a maps app, every city keeps its dot at every
      // zoom; only the name labels (separate layer) collide and thin out. These
      // must be constants: MapLibre rejects feature-property expressions here.
      "icon-allow-overlap": true,
      "icon-ignore-placement": true,
      "icon-padding": 2,
      "symbol-sort-key": ["get", "rank"],
    },
    paint: { "icon-opacity": 1 },
  });

  // Continent names (Phase 12) — the risen oceans, as a faint earthy wash spread
  // across the new land where each ocean lies today. Sits BENEATH the text-label
  // group below so country/city/ocean names always read over it, like the big
  // continent name printed under everything on an atlas. Wide-tracked uppercase,
  // allowed to overlap (a handful, anchoring the map).
  map.addLayer({
    id: "continent-label",
    type: "symbol",
    source: "continent-labels",
    // A globe/continental-view backdrop only: once you've zoomed past the regional
    // threshold it's gone entirely (the opacity fade reaches 0 just before this cut).
    maxzoom: 4,
    layout: {
      "text-field": ["get", "name"],
      "text-font": ["Open Sans Semibold"],
      "text-transform": "uppercase",
      "text-letter-spacing": 0.4,
      "text-size": ["interpolate", ["linear"], ["zoom"], 0, 15, 2.5, 21, 4, 23],
      "text-max-width": 8,
      "text-allow-overlap": true,
      "text-ignore-placement": true,
    },
    paint: {
      "text-color": "#6b5536",
      "text-halo-color": "rgba(245,240,228,0.7)",
      "text-halo-width": 1.6,
      // a backdrop: boldest zoomed out (tier 1), faded fully out before the maxzoom cut.
      "text-opacity": ["interpolate", ["linear"], ["zoom"], 0, 0.6, 2.5, 0.5, 3.6, 0],
    },
  });

  // ---- labels (Phase 9) --------------------------------------------------
  // Real MapLibre `text-field` labels, rendered from self-hosted Open Sans glyphs
  // (public/fonts/, declared as `glyphs` in baseStyle). The worker writes `name`
  // onto each feature, so the layers just read ["get","name"]. Collision is on
  // (`text-allow-overlap:false`) so names never stack; `symbol-sort-key` decides
  // who wins the space (bigger country / higher-ranked city first). Topmost, so
  // names read over every other feature. A dark fill + light halo stays legible on
  // both the relief terrain and the pale flat presets.

  // Country names — small-caps, letter-spaced, at the territorial centroid; the
  // biggest territory wins placement (most-negative sort key = highest priority).
  map.addLayer({
    id: "country-label",
    type: "symbol",
    source: "country-labels",
    layout: {
      "text-field": ["get", "name"],
      "text-font": ["Open Sans Semibold"],
      "text-transform": "uppercase",
      "text-letter-spacing": 0.16,
      "text-size": ["interpolate", ["linear"], ["zoom"], 0, 11, 4, 13, 8, 16],
      "text-max-width": 7,
      "text-allow-overlap": false,
      "text-padding": 4,
      "symbol-sort-key": ["*", -1, ["get", "size"]],
    },
    paint: {
      "text-color": "#3a2f22",
      "text-halo-color": "rgba(248,245,238,0.92)",
      "text-halo-width": 1.6,
      "text-opacity": 0.92,
    },
  });

  // City names — beside the dot (left-anchored + a small right offset), sized by
  // tier, and sharing the dot's rank so the largest cities label first.
  map.addLayer({
    id: "cities-label",
    type: "symbol",
    source: "cities",
    minzoom: 2,
    layout: {
      "text-field": ["get", "name"],
      "text-font": ["Open Sans Regular"],
      // Density-driven detail: every settlement is ELIGIBLE (no hard zoom gate), and
      // collision decides what fits. `symbol-sort-key` (rank; 1 = biggest) places the
      // important cities first, then leftover space backfills with smaller towns — so
      // a quiet region surfaces detail instead of going blank, while a crowded one
      // still thins to its biggest cities. Size only sets the visual weight per tier.
      "text-size": [
        "interpolate", ["linear"], ["zoom"],
        2, ["match", ["get", "tier"], "capital", 12, "metropolis", 10.5, "city", 9.5, 9],
        6, ["match", ["get", "tier"], "capital", 16, "metropolis", 13.5, "city", 12, 11],
      ],
      "text-anchor": "left",
      "text-offset": [0.7, 0],
      "text-allow-overlap": false,
      "text-padding": 2,
      "symbol-sort-key": ["get", "rank"],
    },
    paint: {
      "text-color": "#241d15",
      "text-halo-color": "rgba(248,245,238,0.94)",
      "text-halo-width": 1.4,
    },
  });

  // River names — curved ALONG the channel (`symbol-placement:"line"`), italic
  // blue. A generous symbol-spacing gives short rivers one label and long trunks a
  // few; text-max-angle keeps it off sharp meanders.
  map.addLayer({
    id: "rivers-label",
    type: "symbol",
    source: "rivers",
    minzoom: 2.5,
    layout: {
      "symbol-placement": "line",
      "text-field": ["get", "name"],
      "text-font": ["Open Sans Italic"],
      // Biggest trunks first (sort-key by Strahler order); lesser channels backfill
      // wherever a stretch of channel has room, so named rivers appear as space allows.
      "text-size": ["interpolate", ["linear"], ["zoom"], 2.5, 10, 6, 12],
      "symbol-sort-key": ["-", 0, ["get", "strahler"]],
      "text-letter-spacing": 0.08,
      "symbol-spacing": 500,
      "text-max-angle": 35,
      "text-padding": 3,
    },
    paint: {
      "text-color": "#1d5b83",
      "text-halo-color": "rgba(240,247,250,0.9)",
      "text-halo-width": 1.4,
      "text-opacity": 0.9,
    },
  });

  // Lake names — italic blue at the polygon centroid (default point placement).
  // Continent-scale basins are excluded here: they're named after the land they
  // drowned by the ocean-label layer below, so labelling them twice would clash.
  map.addLayer({
    id: "lakes-label",
    type: "symbol",
    source: "lakes",
    filter: ["<", ["get", "area_km2"], 5000000],
    minzoom: 2,
    layout: {
      "text-field": ["get", "name"],
      "text-font": ["Open Sans Italic"],
      // Bigger basins first (sort-key by area); smaller lakes backfill wherever the
      // map has space rather than being hard-gated by zoom, so a sparse region still
      // names its water instead of showing nothing.
      "text-size": ["interpolate", ["linear"], ["zoom"], 2, 10, 6, 13],
      "symbol-sort-key": ["-", 0, ["get", "area_km2"]],
      "text-allow-overlap": false,
      "text-padding": 2,
    },
    paint: {
      "text-color": "#1d5b83",
      "text-halo-color": "rgba(240,247,250,0.9)",
      "text-halo-width": 1.4,
      "text-opacity": 0.9,
    },
  });

  // Ocean names (Phase 12) — the drowned continents. Big, wide-tracked, uppercase
  // italic over the water, sitting where each continent lies today. Allowed to
  // overlap (there are only a handful and they anchor the whole map) and the
  // topmost label layer so a sea name always reads over the features inside it.
  map.addLayer({
    id: "ocean-label",
    type: "symbol",
    source: "ocean-labels",
    layout: {
      "text-field": ["get", "name"],
      "text-font": ["Open Sans Italic"],
      "text-transform": "uppercase",
      "text-letter-spacing": 0.34,
      "text-size": ["interpolate", ["linear"], ["zoom"], 0, 13, 3, 18, 6, 24],
      "text-max-width": 8,
      "text-allow-overlap": true,
      "text-ignore-placement": true,
    },
    paint: {
      "text-color": "#1a5878",
      "text-halo-color": "rgba(236,246,250,0.85)",
      "text-halo-width": 1.8,
      "text-opacity": ["interpolate", ["linear"], ["zoom"], 0, 0.82, 5, 0.7, 8, 0.5],
    },
  });

  // ---- label priority (Phase 12) -----------------------------------------
  // MapLibre runs ONE global label-collision pass across every symbol layer, and
  // the topmost layer is placed first — so stacking order IS the priority order.
  // Re-stack the text labels into the reading hierarchy the world should have
  // (oceans/continents are the backdrop; they allow-overlap and never collide):
  //   country  >  city  >  lake  >  river,   with ocean names riding on top.
  // moveLayer(id) with no anchor lifts a layer to the top, so calling these from
  // lowest to highest priority leaves them stacked in exactly that order.
  for (const id of ["rivers-label", "lakes-label", "cities-label", "country-label", "ocean-label"]) {
    if (map.getLayer(id)) map.moveLayer(id);
  }

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
    ["country-label", "text-opacity-transition"],
    ["cities-label", "text-opacity-transition"],
    ["rivers-label", "text-opacity-transition"],
    ["lakes-label", "text-opacity-transition"],
    ["ocean-label", "text-opacity-transition"],
    ["continent-label", "text-opacity-transition"],
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
function cityDot(diameter) {
  const s = diameter * 2; // 2× supersample
  const cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const ctx = cv.getContext("2d");
  const cx = s / 2, cy = s / 2;
  const r = s / 2 - 2.5;
  // every settlement — capital included — is the same light disc with a dark
  // outline; capitals just read larger (bigger base image + bigger icon-size).
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = "#fbf7ef"; ctx.fill();
  ctx.lineWidth = s * 0.14; ctx.strokeStyle = "#1a2230"; ctx.stroke();
  return ctx.getImageData(0, 0, s, s);
}

function registerCityIcons() {
  if (!map.hasImage("city-dot")) map.addImage("city-dot", cityDot(18), { pixelRatio: 2 });
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
  // While the relief preview is up (a regen is in flight) don't reveal the stale
  // layers — the pending reveal applies the now-current style once they're fresh.
  if (!previewActive) applyStyle(map, terrain, currentStyle, layerVisibility);
  applyBackground();
  persistStyle(currentStyle);
  picker.setActive(currentStyle);
  syncHash();
  scheduleAutosave();
}

// Re-present the world under the current style with the new layer toggles, and
// remember the choice. Never touches the recipe or the world geometry.
function setLayerVisibility(vis) {
  // Same as setMapStyle: defer to the pending reveal if we're mid-regen so the
  // preview isn't broken by un-hiding stale layers.
  if (!previewActive) applyStyle(map, terrain, currentStyle, vis);
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
  onChange: (_recipe, ev) => {
    // Dragging the water slider should drop to the live relief preview IMMEDIATELY
    // (the terrain shader reacts to the water uniform every frame), rather than
    // waiting for the post-settle regen to enter preview — so the sea visibly
    // rises/falls with no stale layers over it. Other edits enter preview when
    // their regeneration dispatches (see requestFeatures). Idempotent either way.
    if (ev?.target?.key === "water") enterPreview();
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
  applyStyle(map, terrain, currentStyle, layerVisibility);
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
  applyStyle(map, terrain, currentStyle, layerVisibility); // resolved style + toggles from the start
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
