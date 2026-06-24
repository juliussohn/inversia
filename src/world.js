/* ------------------------------------------------------------------ *
 *  Inversia — procedural world platform (MapLibre shell, Phase 1)
 *
 *  This is the NEW entry point that the migration grows into. It mounts a
 *  MapLibre GL map (mercator) on a placeholder basemap and binds the world
 *  recipe to: (1) an auto-generated Tweakpane panel and (2) the URL hash, so
 *  edits round-trip through a shared link. No terrain or generated features
 *  yet — those land in later phases. The legacy app (src/app.js) is untouched.
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

// ---- placeholder basemap -------------------------------------------------
// A minimal valid style: a solid background, no tiles/terrain yet. Its colour
// is derived from the recipe so panel edits are visibly wired end-to-end until
// the real terrain layer (Phase 2) takes over.
function baseStyle() {
  return {
    version: 8,
    sources: {},
    layers: [
      { id: "bg", type: "background", paint: { "background-color": backgroundFor(recipe) } },
    ],
  };
}

// Inverted worlds read cooler/deeper; water level nudges the tone lighter as it
// rises. Purely a placeholder cue so Phase 1 has something to look at.
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
  // Phase 2 is mercator-only; rotation/pitch would break the terrain layer's
  // visible-bounds math (and globe is Phase 3), so lock the camera flat.
  dragRotate: false,
  pitchWithRotate: false,
  maxPitch: 0,
  attributionControl: false,
});
map.touchZoomRotate.disableRotation();
map.addControl(new maplibregl.NavigationControl({ visualizePitch: false, showCompass: false }), "bottom-right");
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
