/* ------------------------------------------------------------------ *
 *  Inversia — procedural feature generators (pure)
 *
 *  Every generator here is a pure function of (field, params): no GL, no DOM,
 *  no globals. Give it the global elevation field and the current world state
 *  and it returns geometry in GEOGRAPHIC coordinates (lon/lat), so the same
 *  output drives both the flat map and the globe. Keeping these pure means the
 *  whole batch can be lifted into a Web Worker untouched when it needs to.
 *
 *  Geometry kinds the overlay knows how to draw:
 *    { kind: "segments", data: Float32Array[lon1,lat1,lon2,lat2, …] }
 *    { kind: "points",   data: [{lon,lat,…}] }            (cities, later)
 *    { kind: "polygons", data: [[[lon,lat], …], …] }      (lakes, later)
 *
 *  Borders use a terrain-aware Voronoi: scatter "capital" seeds on land, then
 *  grow regions outward with a cost that PENALISES crossing steep terrain, so
 *  the seams between regions settle onto ridgelines instead of cutting straight
 *  across them. The boundaries between regions are the state borders.
 * ------------------------------------------------------------------ */

// ---- deterministic RNG (so a given world always yields the same map) ----
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ *
 *  Seeds — the "capitals". Stable while you raise/lower the sea (so states
 *  don't teleport as coastlines move); a fresh set per inversion, since the
 *  inverted world is a genuinely different set of continents. A jittered grid
 *  keeps them roughly evenly spread but irregular.
 * ------------------------------------------------------------------ */
export function generateSeeds(field, { invert, sea, count = 64, seed = 1337 } = {}) {
  const { N } = field;
  const rng = mulberry32(seed ^ (invert ? 0x9e3779b9 : 0));
  // grid fine enough to offer `count` cells; we keep only those landing on land
  const g = Math.max(2, Math.round(Math.sqrt(count) * 1.6));
  const seeds = [];
  for (let gy = 0; gy < g && seeds.length < count; gy++) {
    for (let gx = 0; gx < g && seeds.length < count; gx++) {
      // jitter within the cell, then nudge to the nearest land if we missed
      const fx = (gx + 0.15 + 0.7 * rng()) / g;
      const fy = (gy + 0.15 + 0.7 * rng()) / g;
      let x = Math.min(N - 1, Math.floor(fx * N));
      let y = Math.min(N - 1, Math.floor(fy * N));
      const hit = nearestLand(field, x, y, invert, sea, Math.floor(N / g));
      if (hit) seeds.push({ x: hit.x, y: hit.y });
    }
  }
  return seeds;
}

// Spiral out from (x,y) to the closest land cell within `radius`; null if none.
function nearestLand(field, x, y, invert, sea, radius) {
  if (field.isLand(x, y, invert, sea)) return { x, y };
  const { N, wrapX } = field;
  for (let r = 1; r <= radius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= N) continue;
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue; // ring only
        const xx = wrapX(x + dx);
        if (field.isLand(xx, yy, invert, sea)) return { x: xx, y: yy };
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 *  Borders — terrain-aware Voronoi.
 * ------------------------------------------------------------------ */
export function generateBorders(field, params, seeds) {
  const { N, elev, wrapX } = field;
  const { invert, sea } = params;
  const RIDGE_COST = params.ridgeCost ?? 0.04; // how strongly borders hug ridges (m⁻¹)

  if (!seeds || !seeds.length) return { kind: "segments", data: new Float32Array(0) };

  // ---- multi-source weighted growth (Dijkstra over the land graph) ----
  // owner[i] = which seed claims cell i; dist[i] = accumulated cost to reach it.
  const owner = new Int16Array(N * N).fill(-1);
  const dist = new Float32Array(N * N).fill(Infinity);
  const land = new Uint8Array(N * N);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++)
      land[y * N + x] = field.isLand(x, y, invert, sea) ? 1 : 0;

  const heap = new MinHeap();
  seeds.forEach((s, si) => {
    const i = s.y * N + s.x;
    if (!land[i]) return;
    owner[i] = si; dist[i] = 0;
    heap.push(0, i);
  });

  const eff = (i) => (invert ? -elev[i] : elev[i]);
  while (heap.size) {
    const i = heap.pop();
    const d = dist[i];
    if (d === Infinity) continue;
    const x = i % N, y = (i / N) | 0, o = owner[i], ei = eff(i);
    // 4-neighbourhood, wrapping in x
    for (let k = 0; k < 4; k++) {
      const nx = k === 0 ? wrapX(x - 1) : k === 1 ? wrapX(x + 1) : x;
      const ny = k === 2 ? y - 1 : k === 3 ? y + 1 : y;
      if (ny < 0 || ny >= N) continue;
      const j = ny * N + nx;
      if (!land[j]) continue;
      // step cost: 1 base + penalty for the elevation wall between the cells.
      const step = 1 + RIDGE_COST * Math.abs(eff(j) - ei);
      const nd = d + step;
      if (nd < dist[j]) { dist[j] = nd; owner[j] = o; heap.push(nd, j); }
    }
  }

  // ---- trace the seams between different owners into lon/lat segments ----
  // For each land cell, compare with its right and bottom land neighbour; when
  // the owners differ, emit the shared edge as a short segment.
  const segs = [];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      if (!land[i] || owner[i] < 0) continue;
      // right edge (vertical line at x+1)
      const rx = wrapX(x + 1), ri = y * N + rx;
      if (land[ri] && owner[ri] >= 0 && owner[ri] !== owner[i]) {
        pushSeg(segs, field, x + 1, y, x + 1, y + 1);
      }
      // bottom edge (horizontal line at y+1)
      if (y + 1 < N) {
        const bi = (y + 1) * N + x;
        if (land[bi] && owner[bi] >= 0 && owner[bi] !== owner[i]) {
          pushSeg(segs, field, x, y + 1, x + 1, y + 1);
        }
      }
    }
  }
  return { kind: "segments", data: Float32Array.from(segs) };
}

// Append one grid-space edge (in cell-corner units) as a lon/lat segment.
function pushSeg(out, field, x1, y1, x2, y2) {
  const { N } = field;
  const lon = (gx) => gx / N * 360 - 180;
  const lat = (gy) => {
    const wy = gy / N;
    return (Math.atan(Math.sinh(Math.PI * (1 - 2 * wy))) * 180) / Math.PI;
  };
  out.push(lon(x1), lat(y1), lon(x2), lat(y2));
}

/* ------------------------------------------------------------------ *
 *  Tiny binary min-heap keyed by cost (avoids an O(V²) scan in Dijkstra).
 * ------------------------------------------------------------------ */
class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.v.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = v.length; k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]]; i = p;
    }
  }
  pop() {
    const k = this.k, v = this.v, top = v[0], n = v.length - 1;
    k[0] = k[n]; v[0] = v[n]; k.pop(); v.pop();
    let i = 0;
    while (true) {
      const l = 2 * i + 1, r = l + 1; let m = i;
      if (l < v.length && k[l] < k[m]) m = l;
      if (r < v.length && k[r] < k[m]) m = r;
      if (m === i) break;
      [k[m], k[i]] = [k[i], k[m]]; [v[m], v[i]] = [v[i], v[m]]; i = m;
    }
    return top;
  }
}
