/* ------------------------------------------------------------------ *
 *  Inversia — label image registry (Phase 9, main-thread)
 *
 *  MapLibre's `symbol` text rendering needs a GLYPH SERVER (font PBFs), which a
 *  self-contained, offline-bakeable world has no business depending on. So instead
 *  of `text-field`, we render each place name to a small canvas ONCE and register
 *  it as a map IMAGE; the label symbol layers then reference it through
 *  `icon-image: ["get", "labelImg"]`. This reuses the exact pattern the city-dot
 *  markers already use (src/world.js), keeps everything in the bundle, and still
 *  gets MapLibre's collision + per-zoom thinning for free (icon-allow-overlap:false
 *  + symbol-sort-key) — bigger places win label space, just like real maps.
 *
 *  Each image is keyed `lbl:<role>:<text>`, so identical labels share one image and
 *  re-registering is a no-op. `gc()` drops images no longer referenced after a
 *  regeneration, keeping the texture atlas bounded across reseeds.
 *
 *  Labels are drawn dark with a strong light HALO so one fixed colour reads over
 *  both the dark relief terrain and the pale paper of the flat presets — the preset
 *  switcher then only toggles visibility/opacity, never re-renders the text.
 * ------------------------------------------------------------------ */

// Per-role typography. Country names are spaced small-caps (atlas convention),
// water features italic-blue, cities a plain upright label.
const ROLE = {
  country: { upper: true, letterSpacing: 1.5, size: 13, weight: 700, color: "#3a2f22", halo: "rgba(248,245,238,0.92)" },
  city:    { upper: false, letterSpacing: 0,  size: 12, weight: 600, color: "#241d15", halo: "rgba(248,245,238,0.94)" },
  river:   { upper: false, letterSpacing: 0,  size: 11, weight: 500, italic: true, color: "#1d5b83", halo: "rgba(240,247,250,0.92)" },
  lake:    { upper: false, letterSpacing: 0,  size: 11, weight: 500, italic: true, color: "#1d5b83", halo: "rgba(240,247,250,0.92)" },
};

const DPR = 2;          // supersample, registered at pixelRatio 2 → crisp labels
const FONT_STACK = "system-ui, -apple-system, 'Segoe UI', sans-serif";

function fontFor(o) {
  return `${o.italic ? "italic " : ""}${o.weight} ${o.size}px ${FONT_STACK}`;
}

// total advance of `text` at letter-spacing `ls` under the ctx's current font.
function spacedWidth(ctx, text, ls) {
  let w = 0;
  for (const ch of text) w += ctx.measureText(ch).width + ls;
  return Math.max(0, w - ls);
}

// draw `text` char-by-char so letter-spacing applies (canvas has no native ls in
// all engines); stroke pass first for the halo, then fill.
function drawSpaced(ctx, text, x, y, ls, stroke) {
  let cx = x;
  for (const ch of text) {
    if (stroke) ctx.strokeText(ch, cx, y);
    else ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + ls;
  }
}

// Render one label to an ImageData the map can ingest. Sized tight to the text
// plus a little padding for the halo.
function renderLabel(text, o) {
  const t = o.upper ? text.toUpperCase() : text;
  const font = fontFor(o);

  const meas = document.createElement("canvas").getContext("2d");
  meas.font = font;
  const ls = o.letterSpacing || 0;
  const padX = 5, padY = 4;
  const wCss = Math.ceil(spacedWidth(meas, t, ls)) + padX * 2;
  const hCss = o.size + padY * 2;

  const cv = document.createElement("canvas");
  cv.width = Math.max(2, wCss * DPR);
  cv.height = Math.max(2, hCss * DPR);
  const ctx = cv.getContext("2d");
  ctx.scale(DPR, DPR);
  ctx.font = font;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.lineJoin = "round";
  ctx.miterLimit = 2;

  const y = hCss / 2;
  ctx.strokeStyle = o.halo;
  ctx.lineWidth = 3.5;
  drawSpaced(ctx, t, padX, y, ls, true);
  ctx.fillStyle = o.color;
  drawSpaced(ctx, t, padX, y, ls, false);

  return ctx.getImageData(0, 0, cv.width, cv.height);
}

/**
 * Build a label-image registry bound to a map.
 *
 *   const labels = createLabelRegistry(map);
 *   const id = labels.ensure("Verdania", "country");   // registers if new
 *   feature.properties.labelImg = id;                  // layer reads it
 *   labels.gc(neededIdSet);                            // drop the unreferenced
 *
 * @param {import("maplibre-gl").Map} map
 */
export function createLabelRegistry(map) {
  const known = new Set(); // image ids we've registered

  function ensure(text, role) {
    const o = ROLE[role] || ROLE.city;
    const id = `lbl:${role}:${text}`;
    if (!known.has(id)) {
      if (!map.hasImage(id)) map.addImage(id, renderLabel(text, o), { pixelRatio: DPR });
      known.add(id);
    }
    return id;
  }

  // Drop every registered image not in `neededIds`, so the atlas doesn't grow
  // unbounded as seeds/params change and rename the whole world.
  function gc(neededIds) {
    for (const id of [...known]) {
      if (neededIds.has(id)) continue;
      if (map.hasImage(id)) map.removeImage(id);
      known.delete(id);
    }
  }

  return { ensure, gc };
}
