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

import { decodeHash, encodeHash } from "./world/recipe.js";
import { createPanel } from "./world/panel.js";
import { createTerrainLayer } from "./world/terrain-layer.js";
import {
  STYLE_PRESETS, DEFAULT_STYLE, applyStyle, readStyleId, persistStyle,
  createStylePicker, normalizeStyle,
} from "./world/styles.js";
import { loadWorldStat, landFraction } from "./terrain.js";

// ---- recipe (single source of truth) ------------------------------------
// Seed it straight from the URL hash so a shared link restores the same world.
const recipe = decodeHash(location.hash);

// ---- active map style (a VIEW preference, NOT part of the recipe) --------
// Resolved from the URL first (shared links pin world + style), then the last
// local choice. It rides alongside the world in the hash and survives reseeds.
let currentStyle = readStyleId(location.hash);

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

let featTimer = 0;
let featReqId = 0;       // newest request issued
let featAckId = 0;       // newest response applied (drop anything older / stale)
let lastSig = "";        // params last sent — skip regen when nothing relevant changed

// Only the water line, inversion, lake-size floor and river threshold change the
// geometry. Relief, seed, future-phase knobs etc. leave the features untouched, so
// we fingerprint just those and skip the worker round-trip when they haven't moved.
function featureSig() {
  return `${recipe.world.water}|${recipe.world.invert ? 1 : 0}|${recipe.lakes.minSize}|${recipe.rivers.threshold}`;
}

function requestFeatures() {
  const sig = featureSig();
  if (sig === lastSig) return;
  lastSig = sig;
  worker.postMessage({
    type: "generate",
    id: ++featReqId,
    water: recipe.world.water,
    invert: recipe.world.invert,
    minSize: recipe.lakes.minSize,
    threshold: recipe.rivers.threshold,
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
  map.getSource("coast")?.setData(msg.coast);
  map.getSource("land")?.setData(msg.land);
  map.getSource("lakes")?.setData(msg.lakes);
  map.getSource("rivers")?.setData(msg.rivers);
};

// Coast stroke + lake fill, styled to read as one world. The terrain shader
// already paints below-water areas as sea, so the lake fill is a distinct,
// slightly brighter tint laid over it — that contrast is what separates an
// enclosed lake from the world ocean. Coast width grows with zoom so the line
// stays hairline on the globe and reads at regional zoom.
function addFeatureLayers() {
  map.addSource("land", { type: "geojson", data: emptyFC() });
  map.addSource("lakes", { type: "geojson", data: emptyFC() });
  map.addSource("coast", { type: "geojson", data: emptyFC() });
  map.addSource("rivers", { type: "geojson", data: emptyFC() });

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

  // Style switches are an INSTANT snap (no cross-fade): zero out the paint
  // transitions on every property a preset touches so swapping Relief↔Political↔
  // Minimal re-presents the world immediately rather than dissolving through it.
  const snap = { duration: 0 };
  for (const [layer, prop] of [
    ["land-fill", "fill-color-transition"], ["land-fill", "fill-opacity-transition"],
    ["lakes-fill", "fill-color-transition"], ["lakes-fill", "fill-opacity-transition"],
    ["lakes-line", "line-color-transition"], ["lakes-line", "line-opacity-transition"],
    ["coast-line", "line-color-transition"], ["coast-line", "line-opacity-transition"],
    ["rivers-line", "line-color-transition"], ["rivers-line", "line-opacity-transition"],
    ["bg", "background-color-transition"],
  ]) {
    try { map.setPaintProperty(layer, prop, snap); } catch { /* ignore */ }
  }
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
  applyStyle(map, terrain.id, currentStyle);
  applyBackground();
  persistStyle(currentStyle);
  picker.setActive(currentStyle);
  syncHash();
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
  applyStyle(map, terrain.id, currentStyle); // present in the resolved style from the start
  applyBackground();
  requestFeatures();      // first generation (bypasses the settle debounce)
});
loadWorldStat().then(refreshStats);
syncHash();

// expose for quick console poking during development
if (import.meta.env?.DEV) Object.assign(window, { map, recipe });
