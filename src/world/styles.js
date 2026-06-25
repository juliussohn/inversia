/* ------------------------------------------------------------------ *
 *  Inversia — map style presets (Phase 11)
 *
 *  THREE declarative presentation presets that re-present the SAME world three
 *  ways, applied against ONE persistent MapLibre style (never `setStyle`): the
 *  live terrain custom layer and the GeoJSON sources stay mounted throughout, and
 *  switching only diffs layout/paint via `setLayoutProperty`/`setPaintProperty`.
 *
 *    relief    — today's look: the live hypsometric terrain custom layer is the
 *                map; subtle coast, rivers, lakes painted over it.
 *    political — atlas look: terrain hidden, the ocean is a flat background, the
 *                land polygon (from Phase 4's coast contour) fills warm paper, and
 *                bold country outlines (Phase 6) trace the territories.
 *    minimal   — quiet two-tone: flat land/water, hairline coast, no rivers, no
 *                political boundaries.
 *
 *  (Phase 9 adds place-name labels — country / city / river / lake — as real
 *  MapLibre `text-field` symbols (self-hosted Open Sans glyphs), so each preset now
 *  also tunes label visibility + text-opacity: subtle over the relief, prominent in
 *  the atlas look, major-only in minimal.)
 *
 *  The active style is a VIEW preference, not part of the world recipe: it lives
 *  in the URL (`?…&style=`) and localStorage, so a shared link pins world + style
 *  and reseeding the world keeps the chosen style. The presets apply identically
 *  on the globe and the flat map — same style system either way.
 * ------------------------------------------------------------------ */

export const DEFAULT_STYLE = "relief";
const STORAGE_KEY = "inversia.style";
const VIS_STORAGE_KEY = "inversia.layers";

// ---- per-layer visibility toggles (a VIEW preference) --------------------
// A simple on/off override the user drives from the panel, on top of whatever
// the active style preset wants. Each toggle owns one or more MapLibre layers
// (or the terrain custom layer). A toggle that's OFF force-hides its layers no
// matter what the style says; ON defers to the preset's own visibility. Like the
// style choice this is NOT part of the world recipe — it persists in localStorage
// but stays out of the world hash so a shared link's geometry is unaffected.
export const LAYER_TOGGLES = [
  { key: "terrain", label: "Terrain", terrain: true },
  { key: "land", label: "Land fill", layers: ["land-fill"] },
  { key: "borders", label: "Borders", layers: ["country-border"] },
  { key: "coast", label: "Coastline", layers: ["coast-line"] },
  { key: "rivers", label: "Rivers", layers: ["rivers-line"] },
  { key: "lakes", label: "Lakes", layers: ["lakes-fill", "lakes-line"] },
  { key: "cities", label: "Cities", layers: ["cities-symbol"] },
  { key: "labels", label: "Labels", layers: ["country-label", "cities-label", "rivers-label", "lakes-label", "ocean-label", "continent-label"] },
];

// layerId → toggle key, so applyStyle can look up a layer's owning toggle.
const LAYER_TO_TOGGLE = new Map();
for (const t of LAYER_TOGGLES) for (const id of t.layers ?? []) LAYER_TO_TOGGLE.set(id, t.key);

/** A fresh visibility object with every toggle on. */
export function defaultLayerVisibility() {
  return Object.fromEntries(LAYER_TOGGLES.map((t) => [t.key, true]));
}

// Each preset is a plain bundle: an optional flat `ocean` colour (the background
// layer, which is the whole sea once the terrain is hidden), the terrain custom
// layer's visibility, and per-layer { visibility, paint } for the vector layers.
// `ocean: null` means "derive the backdrop from the recipe" (relief only).
export const STYLE_PRESETS = {
  relief: {
    label: "Relief",
    ocean: null,
    terrain: { visible: true },
    layers: {
      "land-fill": { visibility: "none" },
      // interior country borders only (coastal edges aren't emitted) — subtle so
      // they don't fight the relief. No coastline stroke: the terrain's own
      // land/water colour break reads the shore, the way real relief maps do.
      "country-border": {
        visibility: "visible",
        paint: {
          "line-color": "#1a2a16",
          "line-opacity": 0.55,
          "line-width": ["interpolate", ["linear"], ["zoom"], 0, 0.4, 4, 1.0, 8, 1.8],
        },
      },
      "coast-line": { visibility: "none" },
      "lakes-fill": { visibility: "visible", paint: { "fill-color": "#3aa0c9", "fill-opacity": 0.45 } },
      "lakes-line": { visibility: "visible", paint: { "line-color": "#bfe6f2", "line-opacity": 0.5, "line-width": 0.6 } },
      "rivers-line": { visibility: "visible", paint: { "line-color": "#2b7fb8", "line-opacity": 0.9 } },
      // every city, sized by tier; collision thins them per zoom (see world.js)
      "cities-symbol": { visibility: "visible", paint: { "icon-opacity": 1 } },
      // names ride over the relief; collision keeps them from crowding the terrain
      "country-label": { visibility: "visible", paint: { "text-opacity": 0.9 } },
      "cities-label": { visibility: "visible", paint: { "text-opacity": 1 } },
      "rivers-label": { visibility: "visible", paint: { "text-opacity": 0.85 } },
      "lakes-label": { visibility: "visible", paint: { "text-opacity": 0.85 } },
      "ocean-label": { visibility: "visible", paint: { "text-opacity": 0.72 } },
      "continent-label": { visibility: "visible", paint: { "text-opacity": 0.5 } },
    },
  },

  political: {
    label: "Political",
    ocean: "#aacbe0",
    terrain: { visible: false },
    layers: {
      "land-fill": { visibility: "visible", paint: { "fill-color": "#ece6d6", "fill-opacity": 1 } },
      // atlas look: bold country outlines over the paper land (no fills). Borders
      // are interior-only now, so they trace state-vs-state frontiers but never the
      // shore — the paper-land / blue-sea colour break is the coastline.
      "country-border": {
        visibility: "visible",
        paint: {
          "line-color": "#5b4a36",
          "line-opacity": 0.85,
          "line-width": ["interpolate", ["linear"], ["zoom"], 0, 0.5, 4, 1.4, 8, 2.6],
        },
      },
      "coast-line": { visibility: "none" },
      "lakes-fill": { visibility: "visible", paint: { "fill-color": "#aacbe0", "fill-opacity": 1 } },
      "lakes-line": { visibility: "visible", paint: { "line-color": "#8aa9bd", "line-opacity": 0.6, "line-width": 0.6 } },
      "rivers-line": { visibility: "visible", paint: { "line-color": "#6f9ec2", "line-opacity": 0.85 } },
      // prominent in the atlas look: all tiers, full strength
      "cities-symbol": { visibility: "visible", paint: { "icon-opacity": 1 } },
      // prominent labelling — the atlas reads by its names
      "country-label": { visibility: "visible", paint: { "text-opacity": 1 } },
      "cities-label": { visibility: "visible", paint: { "text-opacity": 1 } },
      "rivers-label": { visibility: "visible", paint: { "text-opacity": 0.95 } },
      "lakes-label": { visibility: "visible", paint: { "text-opacity": 0.95 } },
      "ocean-label": { visibility: "visible", paint: { "text-opacity": 0.85 } },
      "continent-label": { visibility: "visible", paint: { "text-opacity": 0.6 } },
    },
  },

  minimal: {
    label: "Minimal",
    ocean: "#eef2f4",
    terrain: { visible: false },
    layers: {
      "land-fill": { visibility: "visible", paint: { "fill-color": "#d4dade", "fill-opacity": 1 } },
      // quiet two-tone: no political boundaries at all
      "country-border": { visibility: "none" },
      "coast-line": {
        visibility: "visible",
        paint: {
          "line-color": "#b3bcc2",
          "line-opacity": 0.8,
          "line-width": ["interpolate", ["linear"], ["zoom"], 0, 0.3, 8, 0.8],
        },
      },
      "lakes-fill": { visibility: "visible", paint: { "fill-color": "#eef2f4", "fill-opacity": 1 } },
      "lakes-line": { visibility: "none" },
      "rivers-line": { visibility: "none" },
      // quiet: only the major settlements (capitals + metropolises) show through
      "cities-symbol": {
        visibility: "visible",
        paint: { "icon-opacity": ["match", ["get", "tier"], "capital", 1, "metropolis", 0.9, 0] },
      },
      // quiet: country names + only major-city names; no water-feature labels
      "country-label": { visibility: "visible", paint: { "text-opacity": 1 } },
      "cities-label": {
        visibility: "visible",
        paint: { "text-opacity": ["match", ["get", "tier"], "capital", 1, "metropolis", 0.9, 0] },
      },
      "rivers-label": { visibility: "none" },
      "lakes-label": { visibility: "none" },
      // oceans & continents are the map's biggest features — keep them even when quiet
      "ocean-label": { visibility: "visible", paint: { "text-opacity": 0.8 } },
      "continent-label": { visibility: "visible", paint: { "text-opacity": 0.55 } },
    },
  },
};

export const STYLE_IDS = Object.keys(STYLE_PRESETS);

/** Coerce an arbitrary id to a known preset id (falls back to the default). */
export function normalizeStyle(id) {
  return STYLE_PRESETS[id] ? id : DEFAULT_STYLE;
}

function setVisible(map, layerId, visible) {
  if (!map.getLayer(layerId)) return;
  try {
    map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
  } catch { /* layer not ready yet */ }
}

// Every generated vector layer id, derived from the toggle groups (land fill,
// borders, coast, rivers, lakes, cities, labels). The single source of truth for
// "all the layers that sit on top of the terrain".
export const FEATURE_LAYER_IDS = LAYER_TOGGLES.flatMap((t) => t.layers ?? []);

/**
 * Relief-preview override, held while the world is regenerating: show only the
 * live terrain shader (it reads invert/water/relief every frame, so it always
 * reflects the current recipe) and hide every generated vector layer, whose
 * coastlines / rivers / borders are now stale against the in-flight world.
 * Restore the normal presentation by calling `applyStyle` once regeneration lands.
 *
 * @param {import("maplibre-gl").Map} map
 * @param {string} terrainId  id of the terrain custom layer
 */
export function showReliefPreview(map, terrainId) {
  setVisible(map, terrainId, true);
  for (const id of FEATURE_LAYER_IDS) setVisible(map, id, false);
}

/**
 * Apply a preset by DIFFING it onto the one persistent style. Walks the preset
 * and sets visibility + paint for the terrain custom layer and every vector
 * layer. The background (ocean) is owned by the caller so it can blend the
 * recipe-derived backdrop in `relief`; see STYLE_PRESETS[id].ocean.
 *
 * The optional `visibility` map (toggle key → boolean) is the user's per-layer
 * override: a toggle that's OFF force-hides its layers regardless of the preset,
 * while ON defers to the preset's own visibility. Omit it to apply the preset
 * unmodified.
 *
 * @param {import("maplibre-gl").Map} map
 * @param {string} terrainId  id of the terrain custom layer
 * @param {string} styleId
 * @param {Record<string, boolean>} [visibility]  per-toggle on/off overrides
 */
export function applyStyle(map, terrainId, styleId, visibility) {
  const on = (key) => visibility?.[key] !== false; // default ON when unset
  const preset = STYLE_PRESETS[normalizeStyle(styleId)];
  setVisible(map, terrainId, preset.terrain.visible && on("terrain"));
  for (const [layerId, spec] of Object.entries(preset.layers)) {
    if (!map.getLayer(layerId)) continue;
    const toggle = LAYER_TO_TOGGLE.get(layerId);
    setVisible(map, layerId, spec.visibility !== "none" && (!toggle || on(toggle)));
    if (spec.paint) {
      for (const [prop, value] of Object.entries(spec.paint)) {
        try { map.setPaintProperty(layerId, prop, value); } catch { /* ignore */ }
      }
    }
  }
}

// ---- view-preference persistence (URL + localStorage) -------------------
// NOT part of the recipe: the world hash stays world-only, and the style rides
// alongside as a separate `style` param. Resolution order on load is URL first
// (so a shared link wins), then the last local choice, then the default.

export function readStyleId(hash = location.hash) {
  const str = String(hash || "").replace(/^#/, "");
  const fromUrl = new URLSearchParams(str).get("style");
  if (fromUrl && STYLE_PRESETS[fromUrl]) return fromUrl;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && STYLE_PRESETS[stored]) return stored;
  } catch { /* storage blocked */ }
  return DEFAULT_STYLE;
}

export function persistStyle(id) {
  try { localStorage.setItem(STORAGE_KEY, normalizeStyle(id)); } catch { /* ignore */ }
}

/** Read the saved layer-visibility overrides, defaulting any missing toggle to on. */
export function readLayerVisibility() {
  const vis = defaultLayerVisibility();
  try {
    const stored = JSON.parse(localStorage.getItem(VIS_STORAGE_KEY) || "{}");
    for (const t of LAYER_TOGGLES) if (typeof stored[t.key] === "boolean") vis[t.key] = stored[t.key];
  } catch { /* storage blocked / malformed */ }
  return vis;
}

export function persistLayerVisibility(vis) {
  try { localStorage.setItem(VIS_STORAGE_KEY, JSON.stringify(vis)); } catch { /* ignore */ }
}

/**
 * Build the segmented style-picker control. Returns the host element (caller
 * places it) plus a `setActive(id)` to reflect external changes (e.g. a URL load).
 *
 * @param {{ current: string, onSelect: (id: string) => void }} opts
 */
export function createStylePicker({ current, onSelect }) {
  const el = document.createElement("div");
  el.id = "style-switch";
  el.setAttribute("role", "radiogroup");
  el.setAttribute("aria-label", "Map style");

  const buttons = new Map();
  for (const id of STYLE_IDS) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = STYLE_PRESETS[id].label;
    b.dataset.style = id;
    b.setAttribute("role", "radio");
    b.addEventListener("click", () => onSelect(id));
    buttons.set(id, b);
    el.appendChild(b);
  }

  function setActive(id) {
    const active = normalizeStyle(id);
    for (const [bid, b] of buttons) {
      const on = bid === active;
      b.classList.toggle("active", on);
      b.setAttribute("aria-checked", on ? "true" : "false");
    }
  }
  setActive(current);

  return { el, setActive };
}
