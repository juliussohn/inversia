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
 *  Generated features (coastlines, rivers, countries, cities…) land in later
 *  phases as MapLibre GeoJSON layers on top of this terrain.
 * ------------------------------------------------------------------ */

import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./world.css";

import { decodeHash, encodeHash } from "./world/recipe.js";
import { createPanel } from "./world/panel.js";
import { createTerrainLayer } from "./world/terrain-layer.js";
import { loadWorldStat, landFraction } from "./terrain.js";

// ---- recipe (single source of truth) ------------------------------------
// Seed it straight from the URL hash so a shared link restores the same world.
const recipe = decodeHash(location.hash);

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
  if (map.getLayer("bg")) map.setPaintProperty("bg", "background-color", backgroundFor(recipe));
  // terrain reads the recipe live; just ask MapLibre to repaint with the new uniforms
  if (map.getLayer(terrain.id)) map.triggerRepaint();
  scheduleStats();
}

// ---- recipe → URL hash ---------------------------------------------------
// Keep a deep-link in the address bar; replaceState avoids history spam.
function syncHash() {
  const h = encodeHash(recipe);
  history.replaceState(null, "", h ? `#${h}` : location.pathname + location.search);
}

// ---- auto-generated control panel ----------------------------------------
createPanel({
  container: document.getElementById("panel"),
  recipe,
  onChange: () => {
    applyRecipeToMap();
    syncHash();
  },
});

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
  map.addLayer(terrain); // above the placeholder background
});
loadWorldStat().then(refreshStats);
syncHash();

// expose for quick console poking during development
if (import.meta.env?.DEV) Object.assign(window, { map, recipe });
