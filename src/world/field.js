/* ------------------------------------------------------------------ *
 *  Inversia — the global elevation field (worker-side)
 *
 *  Phase 4 generates its first real map data — coastlines and lakes — from ONE
 *  global elevation field, decoded once and reused for every regeneration. This
 *  module builds that field inside the Web Worker so the main thread never blocks
 *  on the megapixel decode or the marching-squares pass that consumes it.
 *
 *  BUILD-TIME CHOICE (the benchmark the plan asks for):
 *    The repo already ships `public/heightmap.png` — a 2048×1024 16-bit global
 *    field baked from the GMT 1° earth-relief grid (real topography AND
 *    bathymetry; see scripts/bake_heightmap.py). We decode that single asset
 *    rather than streaming ~256 z4 Terrarium tiles, because it is:
 *      • one fetch instead of 256 (and no contention with the live terrain layer
 *        already pulling Terrarium tiles),
 *      • already EQUIRECTANGULAR, so a grid cell maps to lon/lat by a linear
 *        formula — no per-vertex mercator inversion for every contour point,
 *      • full-globe including the poles (Web-Mercator z4 tiles stop at ±85°,
 *        which would clip the inverted Arctic/Antarctic coasts).
 *    The cost is detail: the source is 1° real-content, so deep-zoom coasts go
 *    blocky — exactly the deferral the plan documents ("z4 source goes blocky
 *    near street-level"). The live terrain shader still carries fine detail
 *    underneath.
 *
 *  The PNG packs elevation into 16 bits across R (high byte) and G (low byte),
 *  normalised over [minElev, maxElev] (from heightmap.json). Decode is the
 *  inverse of the bake:  elev = (R*256 + G) / 65535 * (max-min) + min  (metres).
 * ------------------------------------------------------------------ */

// Vite serves /public at BASE_URL ("/" in dev, "/inversia/" on Pages). The worker
// has no document base, so build absolute URLs from the env base.
const BASE = import.meta.env?.BASE_URL ?? "/";

let cached = null; // { elev: Float32Array, W, H, minElev, maxElev }

/**
 * Load + decode the global elevation field once; subsequent calls reuse it.
 * @returns {Promise<{elev: Float32Array, W: number, H: number, minElev: number, maxElev: number}>}
 */
export async function loadField() {
  if (cached) return cached;

  const [meta, bitmap] = await Promise.all([
    fetch(`${BASE}heightmap.json`).then((r) => r.json()),
    fetch(`${BASE}heightmap.png`).then((r) => r.blob()).then((b) => createImageBitmap(b)),
  ]);

  const W = bitmap.width;
  const H = bitmap.height;

  // OffscreenCanvas lets us read pixels without a DOM, so the whole decode stays
  // in the worker. NEAREST isn't a concern here — drawImage at 1:1 is exact.
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const px = ctx.getImageData(0, 0, W, H).data;
  bitmap.close?.();

  const { minElev, maxElev } = meta;
  const span = maxElev - minElev;
  const elev = new Float32Array(W * H);
  for (let i = 0, p = 0; i < elev.length; i++, p += 4) {
    const u16 = px[p] * 256 + px[p + 1]; // R high, G low
    elev[i] = (u16 / 65535) * span + minElev;
  }

  cached = { elev, W, H, minElev, maxElev };
  return cached;
}
