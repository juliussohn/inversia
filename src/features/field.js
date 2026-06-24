import { TILE, TILE_URL, wxToLon, wyToLat } from "../terrain.js";

/* ------------------------------------------------------------------ *
 *  Inversia — global elevation field
 *
 *  The shared substrate every procedural feature reads. We fetch a small,
 *  fixed pyramid of Terrarium tiles ONCE, decode them into a single global
 *  elevation grid (metres, row-major in mercator space) and hand it around as
 *  plain typed-array data — no GL, no DOM. Border/city/lake generators all
 *  sample THIS, so every feature is derived from the same world the shader
 *  renders.
 *
 *  Indexing: grid cell (x, y) covers mercator wx = (x+0.5)/N, wy = (y+0.5)/N,
 *  where N = 256 · 2^zoom. Same Terrarium decode as the shader:
 *    e = R*256 + G + B/256 − 32768   (metres)
 * ------------------------------------------------------------------ */

// zoom 1 → 512×512 global grid from 4 tiles: enough ridge detail for
// continental-scale borders, cheap to fetch and fast to grind through.
const FIELD_ZOOM = 1;

let pending = null;

// Fetch one Terrarium tile as a decoded-into-`elev` operation via a scratch
// canvas. Returns a promise that resolves once it's been blitted in.
function drawTileInto(ctx, z, x, y, ox, oy) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => { ctx.drawImage(img, ox, oy); resolve(true); };
    img.onerror = () => resolve(false); // leave that patch at 0 m; partial is fine
    img.src = TILE_URL(z, x, y);
  });
}

// Load the global field once (idempotent). Resolves to a Field object, or null
// if the tiles can't be fetched.
export function loadField(zoom = FIELD_ZOOM) {
  if (pending) return pending;
  pending = (async () => {
    const n = 1 << zoom;              // tiles per axis
    const N = TILE * n;               // grid resolution per axis
    const c = document.createElement("canvas");
    c.width = N; c.height = N;
    const ctx = c.getContext("2d", { willReadFrequently: true });

    const jobs = [];
    for (let ty = 0; ty < n; ty++)
      for (let tx = 0; tx < n; tx++)
        jobs.push(drawTileInto(ctx, zoom, tx, ty, tx * TILE, ty * TILE));
    const ok = await Promise.all(jobs);
    if (!ok.some(Boolean)) return null;

    const px = ctx.getImageData(0, 0, N, N).data;
    const elev = new Float32Array(N * N);
    for (let i = 0; i < elev.length; i++) {
      const p = i * 4;
      elev[i] = px[p] * 256 + px[p + 1] + px[p + 2] / 256 - 32768;
    }
    return makeField(elev, N);
  })();
  return pending;
}

// Wrap a decoded grid with the sampling helpers generators rely on. Pure data +
// closures — safe to hand to a Web Worker later (the grid is transferable).
export function makeField(elev, N) {
  // effective elevation under the inversion: Inversia flips the height field.
  const eff = (i, invert) => (invert ? -elev[i] : elev[i]);

  return {
    N,
    elev,
    idx: (x, y) => y * N + x,
    // horizontal wrap (world is a cylinder), vertical clamp (poles)
    wrapX: (x) => ((x % N) + N) % N,
    effAt: (x, y, invert) => eff(y * N + x, invert),
    // land where the effective elevation rises above the water line
    isLand: (x, y, invert, sea) => eff(y * N + x, invert) - sea > 0,
    // cell centre → geographic
    lon: (x) => wxToLon((x + 0.5) / N),
    lat: (y) => wyToLat((y + 0.5) / N),
  };
}
