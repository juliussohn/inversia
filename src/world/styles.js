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
 *  (Labels (Phase 9) aren't built yet, so the flat presets express their look with
 *  the layers that DO exist — land fill + country fills + borders + coast. Labels
 *  slot into these same preset objects when that phase lands.)
 *
 *  The active style is a VIEW preference, not part of the world recipe: it lives
 *  in the URL (`?…&style=`) and localStorage, so a shared link pins world + style
 *  and reseeding the world keeps the chosen style. The presets apply identically
 *  on the globe and the flat map — same style system either way.
 * ------------------------------------------------------------------ */

export const DEFAULT_STYLE = "relief";
const STORAGE_KEY = "inversia.style";

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

/**
 * Apply a preset by DIFFING it onto the one persistent style. Walks the preset
 * and sets visibility + paint for the terrain custom layer and every vector
 * layer. The background (ocean) is owned by the caller so it can blend the
 * recipe-derived backdrop in `relief`; see STYLE_PRESETS[id].ocean.
 *
 * @param {import("maplibre-gl").Map} map
 * @param {string} terrainId  id of the terrain custom layer
 * @param {string} styleId
 */
export function applyStyle(map, terrainId, styleId) {
  const preset = STYLE_PRESETS[normalizeStyle(styleId)];
  setVisible(map, terrainId, preset.terrain.visible);
  for (const [layerId, spec] of Object.entries(preset.layers)) {
    if (!map.getLayer(layerId)) continue;
    setVisible(map, layerId, spec.visibility !== "none");
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
