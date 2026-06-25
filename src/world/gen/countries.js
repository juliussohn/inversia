/* ------------------------------------------------------------------ *
 *  Inversia — countries: organic growth with natural borders (Phase 6)
 *
 *  The explicit realism upgrade over the old equal-Voronoi partition. Countries
 *  are GROWN, not sliced: capitals are seeded on habitable ground and territory
 *  spreads outward by least-cost flooding, where the cost is high to cross the
 *  very features that make good real borders — mountain ridges, rivers, and the
 *  sea. Two growth fronts meeting at a ridge stall there, so the border SETTLES
 *  on the ridge; the same happens along rivers and coasts. The result is uneven,
 *  organic territories whose edges trace the terrain instead of cutting across it.
 *
 *  THE PIPELINE (all over the same global field that made coasts and rivers):
 *
 *    1. LANDMASSES. Flood-fill the land into connected components so growth and
 *       the short-sea-crossing rule can reason about "same island vs. across water".
 *
 *    2. HABITABILITY. Score every land cell by how livable it is — low slope,
 *       close to the coast, close to a major river. Capitals favour these spots,
 *       exactly where real settlement concentrates.
 *
 *    3. CAPITALS. Allocated PER LANDMASS, not globally — this is what makes big
 *       continents host big states and water-surrounded masses fragment. Each
 *       landmass above a min-area floor is guaranteed one capital (sovereignty);
 *       the rest of the recipe's `count` budget is shared out as EXTRAS by
 *       area^areaSkew (sub-linear, so a 100× bigger mass gets only ~10× the
 *       capitals → ~10× bigger countries on average). Within each mass, capitals
 *       are dart-thrown by habitability with an in-mass min-spacing reject. `count`
 *       is a FLOOR: if there are more eligible masses than the budget, every one
 *       still keeps its single capital. Each capital also gets a random "ambition"
 *       weight that scales how cheaply it expands → uneven sizes WITHIN a mass.
 *
 *    4. GROWTH. One multi-source Dijkstra from all capitals at once. Step cost =
 *       distance × a terrain penalty (ridges + rivers cost more to cross) ÷ the
 *       owner's ambition. Water may be crossed but only for a few cells and at a
 *       steep cost (archipelago states, never transoceanic empires). There is NO
 *       cost cutoff: fronts run until they meet, so masses fill completely and no
 *       land is left ownerless. Whoever reaches a cell first (cheapest) owns it;
 *       fronts meeting on ridges/rivers/coasts draw the border. A final orphan pass
 *       floods ownership across open water (ignoring the strait cap) so any island
 *       too remote for growth to reach still inherits the nearest capital — every
 *       land cell ends up owned, so there is no WILDERNESS.
 *
 *    5. VECTORIZE. Per country, trace only its POLITICAL borders — the cell edges
 *       where it abuts a DIFFERENT owner on land (a neighbouring state). Edges
 *       facing the SEA are skipped, so the coast carries no
 *       border line: real political maps don't ink a boundary along the shore, and
 *       drawing one here just doubled the coastline stroke. A shared frontier
 *       between two states traces the identical corner path from both sides, so it
 *       reads as one stroke. An island nation with no land neighbour emits nothing
 *       — its extent is its coast, which the border layer no longer draws. Stable
 *       per-country ids; the antimeridian seam column is skipped as elsewhere.
 *
 *  COORDINATES match coast.js / hydro.js exactly: cell (x,y) centres at
 *  lon = -180 + (x+0.5)/W*360, lat = 90 - (y+0.5)/H*180; the grid wraps in x and
 *  clamps in y. As in the coast layer the antimeridian seam cell is skipped when
 *  contouring (a hairline mid-Pacific gap), while flood-fill and growth DO wrap.
 * ------------------------------------------------------------------ */

// A major river counts as a border-worthy river once its drained area clears this
// (km²). Independent of the recipe's display threshold so borders follow trunk
// rivers regardless of how thin the user has styled the visible network.
const RIVER_BORDER_KM2 = 60000;

// How far (grid cells) territory may reach across open water in one crossing.
// Caps even a cheap-sea world to straits, never oceans (≈8 cells ≈ a narrow sea
// at this ~0.18° field), so archipelago states form but transoceanic ones cannot.
const SEA_SPAN_MAX = 8;

// Smallest landmass that earns its own capital → its own country. Measured in
// REAL area (cos-latitude-weighted cells, so a polar sliver of many tiny cells
// doesn't qualify on raw count). Doubles as the sovereignty floor: a mass this
// big or bigger is always a state (a recognizable island, not a mid-ocean reef);
// anything smaller is folded into the nearest capital by the orphan pass.
// ~a dozen equatorial cells at this ~0.18° field.
const MIN_AREA = 12;

// Slope (metres of relief to the steepest neighbour) that saturates the ridge
// penalty — beyond this a crossing is "as mountainous as it gets".
const SLOPE_SCALE = 900;

// ---- a small, growable binary min-heap (priority: float, payload: int) -----
// Dijkstra re-pushes a cell whenever it finds a cheaper path (lazy decrease-key),
// so the heap can hold more than N entries; it grows on demand.
class MinHeap {
  constructor(capacity = 1024) {
    this.prio = new Float64Array(capacity);
    this.item = new Int32Array(capacity);
    this.size = 0;
  }
  _grow() {
    const p = new Float64Array(this.prio.length * 2);
    const it = new Int32Array(this.item.length * 2);
    p.set(this.prio); it.set(this.item);
    this.prio = p; this.item = it;
  }
  push(prio, item) {
    if (this.size >= this.prio.length) this._grow();
    let i = this.size++;
    this.prio[i] = prio; this.item[i] = item;
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (this.prio[par] <= this.prio[i]) break;
      this._swap(i, par); i = par;
    }
  }
  pop() {
    const top = this.item[0];
    const n = --this.size;
    this.prio[0] = this.prio[n]; this.item[0] = this.item[n];
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < n && this.prio[l] < this.prio[m]) m = l;
      if (r < n && this.prio[r] < this.prio[m]) m = r;
      if (m === i) break;
      this._swap(i, m); i = m;
    }
    return top;
  }
  _swap(a, b) {
    const tp = this.prio[a]; this.prio[a] = this.prio[b]; this.prio[b] = tp;
    const ti = this.item[a]; this.item[a] = this.item[b]; this.item[b] = ti;
  }
}

// ---- deterministic RNG ----------------------------------------------------
// mulberry32: same seed → same world (capitals, ambitions). The whole point of a
// recipe seed is reproducibility, so all randomness flows through this.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- trace the global land-border network (interior edges only) ------------
// Emit a segment on every cell edge whose two sides are DIFFERENT-owned LAND —
// always state-vs-state now that every land cell is owned. Sea edges are skipped, so the coast
// carries no line. Endpoints are grid CORNERS, and each edge is visited once, so
// a shared frontier is a single chain (no doubled stroke). The antimeridian wrap
// column is skipped, leaving the same hairline mid-Pacific gap as the coast layer.
function traceBorders(owner, isLand, W, H) {
  const idx = (x, y) => y * W + x;
  const vmap = new Map();
  const vlon = [], vlat = [];
  // Corner (i,j) is a grid-line intersection: i in [0..W], j in [0..H].
  const corner = (i, j) => {
    const key = j * (W + 1) + i;
    let v = vmap.get(key);
    if (v === undefined) {
      v = vlon.length;
      vlon.push(-180 + (i / W) * 360);
      vlat.push(90 - (j / H) * 180);
      vmap.set(key, v);
    }
    return v;
  };
  const sa = [], sb = [];
  const seg = (a, b) => { sa.push(a); sb.push(b); };
  const differ = (a, b) => isLand[a] === 1 && isLand[b] === 1 && owner[a] !== owner[b];

  // vertical edges between (x,y)|(x+1,y) → a vertical border segment
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W - 1; x++)
      if (differ(idx(x, y), idx(x + 1, y))) seg(corner(x + 1, y), corner(x + 1, y + 1));
  // horizontal edges between (x,y)|(x,y+1) → a horizontal border segment
  for (let y = 0; y < H - 1; y++)
    for (let x = 0; x < W; x++)
      if (differ(idx(x, y), idx(x, y + 1))) seg(corner(x, y + 1), corner(x + 1, y + 1));

  return stitch(sa, sb, vlon, vlat);
}

// ---- polyline simplification + smoothing -----------------------------------
// Douglas–Peucker: drop vertices within `tol` of the chord, turning the corner
// staircase into straight runs at any angle. Endpoints are kept (junctions stay
// pinned). Closed rings are split at the vertex farthest from the start so both
// halves simplify as open chains and the loop closes cleanly.
function simplifyChain(pts, tol, closed) {
  if (closed) {
    let r = pts;
    if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r = r.slice(0, -1);
    if (r.length < 4) return pts;
    let fi = 1, fd = -1;
    for (let i = 1; i < r.length; i++) {
      const dx = r[i][0] - r[0][0], dy = r[i][1] - r[0][1];
      const d = dx * dx + dy * dy;
      if (d > fd) { fd = d; fi = i; }
    }
    const a = dpOpen(r.slice(0, fi + 1), tol);
    const b = dpOpen(r.slice(fi).concat([r[0]]), tol);
    const out = a.slice(0, -1).concat(b.slice(0, -1));
    out.push(out[0]);
    out.closed = true;
    return out;
  }
  const out = dpOpen(pts, tol);
  out.closed = false;
  return out;
}

function dpOpen(pts, tol) {
  const n = pts.length;
  if (n < 3) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const tol2 = tol * tol;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    let md = -1, mi = -1;
    for (let i = lo + 1; i < hi; i++) {
      const d = segDist2(pts[i], pts[lo], pts[hi]);
      if (d > md) { md = d; mi = i; }
    }
    if (md > tol2 && mi > 0) { keep[mi] = 1; stack.push([lo, mi], [mi, hi]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

// squared distance from p to segment a–b (lon/lat treated as a plane; fine at the
// per-cell tolerances we simplify to)
function segDist2(p, a, b) {
  const ax = a[0], ay = a[1];
  let dx = b[0] - ax, dy = b[1] - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p[0] - ax) * dx + (p[1] - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = p[0] - (ax + t * dx), ey = p[1] - (ay + t * dy);
  return ex * ex + ey * ey;
}

// Chaikin corner-cutting (one pass): rounds the remaining angles so a border
// curves instead of kinking. Open chains keep their endpoints (so junctions stay
// joined); closed rings cut cyclically.
function smoothChain(pts, closed) {
  const n = pts.length;
  if (n < 3) return pts;
  const out = [];
  if (!closed) out.push(pts[0]);
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
    out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
  }
  if (!closed) out.push(pts[n - 1]);
  else out.push(out[0]);
  return out;
}

// Stitch undirected segments into rings (degree-2 interior vertices). Open chains
// (touching a pole or the skipped seam) are walked first from their endpoints.
function stitch(sa, sb, vlon, vlat) {
  const nv = vlon.length;
  const adj = Array.from({ length: nv }, () => []);
  for (let i = 0; i < sa.length; i++) { adj[sa[i]].push(i); adj[sb[i]].push(i); }
  const used = new Uint8Array(sa.length);
  const other = (seg, v) => (sa[seg] === v ? sb[seg] : sa[seg]);

  function walk(startSeg, startV) {
    const ids = [startV];
    let v = startV, seg = startSeg;
    while (seg !== -1 && !used[seg]) {
      used[seg] = 1;
      v = other(seg, v); ids.push(v);
      seg = -1;
      for (const s of adj[v]) if (!used[s]) { seg = s; break; }
    }
    const ring = new Array(ids.length);
    for (let i = 0; i < ids.length; i++) ring[i] = [vlon[ids[i]], vlat[ids[i]]];
    ring.closed = ids[0] === ids[ids.length - 1];
    return ring;
  }

  const rings = [];
  for (let v = 0; v < nv; v++) if (adj[v].length === 1 && !used[adj[v][0]]) rings.push(walk(adj[v][0], v));
  for (let i = 0; i < sa.length; i++) if (!used[i]) rings.push(walk(i, sa[i]));
  return rings;
}

// ---- the pass -------------------------------------------------------------

/**
 * Grow countries over the global field and vectorize them to GeoJSON.
 *
 * @param {{elev: Float32Array, W: number, H: number}} field
 * @param {{W:number,H:number,recv:Int32Array,acc:Float64Array}} flow  hydrology
 *        (used for the river-border affinity); pass null to skip river borders.
 * @param {{water:number, invert:boolean, seed:number, count:number,
 *          areaSkew:number, ambition:number, seaCross:number,
 *          ridge:number, river:number}} opts
 * @returns {{countries: object, owner: Int32Array, isLand: Uint8Array,
 *            stats: {countries:number}}}  `owner`/`isLand` feed the city pass
 *          (Phase 7): each city reads its allegiance straight off the territory it
 *          falls on, so it never disagrees with the borders drawn here.
 */
export function computeCountries(field, flow, opts) {
  const { elev, W, H } = field;
  const N = W * H;
  const { water, invert, seed, count } = opts;
  const level = water;

  // eff = the surface the shader thresholds. Land where eff > level.
  const eff = new Float32Array(N);
  if (invert) for (let i = 0; i < N; i++) eff[i] = -elev[i];
  else eff.set(elev);
  const isLand = new Uint8Array(N);
  let landCount = 0;
  for (let i = 0; i < N; i++) if (eff[i] > level) { isLand[i] = 1; landCount++; }
  if (!landCount) return { countries: emptyFC(), owner: new Int32Array(N).fill(-1), isLand, stats: { countries: 0 } };

  // --- per-cell terrain inputs ---------------------------------------------
  // slope: steepest relief to an 8-neighbour, normalised → the ridge penalty.
  // riverMask: trunk-river cells (border affinity + a habitability draw).
  const slopeN = new Float32Array(N); // 0..1
  const riverMask = new Uint8Array(N);
  if (flow && flow.acc) for (let i = 0; i < N; i++) if (isLand[i] && flow.acc[i] >= RIVER_BORDER_KM2) riverMask[i] = 1;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = y * W + x;
      if (!isLand[c]) continue;
      const h = eff[c];
      let mx = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy; if (ny < 0 || ny >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = (x + dx + W) % W;
          const d = Math.abs(h - eff[ny * W + nx]);
          if (d > mx) mx = d;
        }
      }
      slopeN[c] = Math.min(1, mx / SLOPE_SCALE);
    }
  }

  // --- landmasses (connected land components, x wraps) ---------------------
  const landId = new Int32Array(N).fill(-1);
  {
    const stack = [];
    let next = 0;
    for (let s = 0; s < N; s++) {
      if (!isLand[s] || landId[s] !== -1) continue;
      const id = next++;
      landId[s] = id; stack.push(s);
      while (stack.length) {
        const c = stack.pop();
        const x = c % W, y = (c / W) | 0;
        const nbr = [
          y > 0 ? c - W : -1,
          y < H - 1 ? c + W : -1,
          x === 0 ? c + W - 1 : c - 1,
          x === W - 1 ? c - W + 1 : c + 1,
        ];
        for (const n of nbr) if (n >= 0 && isLand[n] && landId[n] === -1) { landId[n] = id; stack.push(n); }
      }
    }
  }

  // --- distance (in cells) to the nearest water and to the nearest river ----
  // Multi-source BFS over the land for the habitability draw toward coasts/rivers.
  const distWater = bfsDistance(N, W, H, (c) => !isLand[c], (c) => isLand[c]);
  const distRiver = bfsDistance(N, W, H, (c) => riverMask[c] === 1, (c) => isLand[c]);

  // --- habitability --------------------------------------------------------
  // Livable where it's flat, near the sea, and near fresh water. Kept strictly
  // positive on all land so even an inland desert can still host a capital.
  const habit = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (!isLand[i]) continue;
    const flat = 1 / (1 + slopeN[i] * 4);
    const coast = Math.exp(-distWater[i] / 6);
    const river = distRiver[i] === Infinity ? 0 : Math.exp(-distRiver[i] / 5);
    habit[i] = 0.15 + flat * (0.5 + 0.9 * coast + 0.7 * river);
  }

  // --- allocate + place capitals (per landmass) ----------------------------
  // Capitals are budgeted PER landmass: every mass ≥ MIN_AREA is guaranteed one,
  // and the rest of `count` is shared out by area^areaSkew so big continents end
  // up with proportionally FEWER (hence larger) states while small masses stay
  // dense. See allocateCapitals.
  const rand = mulberry32((seed >>> 0) ^ 0x9e3779b9);
  const areaSkew = clampRange(opts.areaSkew, 0.3, 1);
  const { caps, capSpread } = allocateCapitals({ N, W, H, isLand, landId, habit, count, areaSkew, rand });
  const nCaps = caps.length;
  if (!nCaps) return { countries: emptyFC(), owner: new Int32Array(N).fill(-1), isLand, stats: { countries: 0 } };

  // ambition: the recipe's "size spread" sets the magnitude, but each capital's
  // share is scaled by `capSpread` — its landmass's variance budget. Small masses
  // get ~0 (even partition; the few states there come out similar-sized), big
  // masses get the full spread (a real MIX of large and small states, not just
  // uniformly-large ones). The cross-mass gradient still comes from area^areaSkew.
  const spread = clamp01(opts.ambition);
  const ambition = new Float64Array(nCaps);
  for (let i = 0; i < nCaps; i++) ambition[i] = Math.exp((rand() - 0.5) * spread * 2.5 * capSpread[i]);

  // --- grow territory (multi-source least-cost flood, no cutoff) -----------
  // Fronts run until they meet — no wilderness — then a final orphan pass folds
  // any unreached speck into the nearest capital so every land cell is owned.
  const owner = growTerritory({
    N, W, H, isLand, slopeN, riverMask, caps, ambition,
    ridgeW: clamp01(opts.ridge) * 6,
    riverW: clamp01(opts.river) * 9,
    seaCost: 5 + clamp01(opts.seaCross) * 45,
  });
  fillOrphans({ N, W, H, isLand, owner });

  // --- vectorize: one global border network -------------------------------
  // Trace every land edge between two DIFFERENT owners once, globally (not per
  // country), so each shared frontier is a single chain — drawn once, never the
  // faintly-doubled stroke you get from outlining each territory separately. The
  // raw chains run along cell corners (pure horizontal/vertical steps), so we
  // simplify them: Douglas–Peucker collapses the stair-steps into any-angle
  // straight runs, then one Chaikin pass rounds the remaining corners so borders
  // flow naturally instead of reading as pixellated right angles.
  const cell = 360 / W;                  // grid cell width in degrees
  const chains = traceBorders(owner, isLand, W, H)
    .map((r) => smoothChain(simplifyChain(r, cell * 0.8, r.closed), r.closed))
    .filter((c) => c.length >= 2);

  // claimed = countries that won land (the stat). Counted even for an all-coast
  // island that contributes no border line, so the HUD count stays truthful.
  let claimed = 0;
  {
    const seen = new Uint8Array(nCaps);
    for (let c = 0; c < N; c++) {
      const o = owner[c];
      if (o >= 0 && isLand[c] && !seen[o]) { seen[o] = 1; claimed++; }
    }
  }

  const features = chains.length
    ? [{ type: "Feature", properties: {}, geometry: { type: "MultiLineString", coordinates: chains } }]
    : [];

  return {
    countries: { type: "FeatureCollection", features },
    owner,
    isLand,
    stats: { countries: claimed },
  };
}

// ---- helpers --------------------------------------------------------------
const emptyFC = () => ({ type: "FeatureCollection", features: [] });
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clampRange = (v, lo, hi) => (!Number.isFinite(v) ? lo : v < lo ? lo : v > hi ? hi : v);

// Multi-source BFS in cell steps. `isSource(c)` seeds distance 0; expansion is
// confined to cells where `passable(c)` holds. Returns Float64 distances (cells),
// Infinity where unreached. x wraps, y clamps — same topology as the floods.
function bfsDistance(N, W, H, isSource, passable) {
  const dist = new Float64Array(N).fill(Infinity);
  const q = new Int32Array(N);
  let head = 0, tail = 0;
  for (let c = 0; c < N; c++) if (isSource(c)) { dist[c] = 0; q[tail++] = c; }
  while (head < tail) {
    const c = q[head++];
    const x = c % W, y = (c / W) | 0;
    const d = dist[c] + 1;
    const nbr = [
      y > 0 ? c - W : -1,
      y < H - 1 ? c + W : -1,
      x === 0 ? c + W - 1 : c - 1,
      x === W - 1 ? c - W + 1 : c + 1,
    ];
    for (const n of nbr) {
      if (n < 0 || dist[n] !== Infinity || !passable(n)) continue;
      dist[n] = d; q[tail++] = n;
    }
  }
  return dist;
}

// Allocate capitals PER landmass, then place them within each mass.
//
// Quota: every landmass ≥ MIN_AREA is "eligible" and guaranteed one capital
// (sovereignty). The leftover budget (count − #eligible, if positive) is shared
// out as EXTRAS by area^areaSkew using the largest-remainder method, so size
// scales sub-linearly with area — a big continent gets proportionally fewer
// capitals (bigger states) and small masses stay dense (more, smaller states).
// `count` is a FLOOR: if there are more eligible masses than the budget, each
// still keeps its single capital and the realized total simply exceeds `count`.
// Sub-MIN_AREA specks get nothing here; the orphan pass folds them into a
// neighbour. All areas and spacings are cos-latitude-weighted so the converging
// polar grid doesn't over-allocate. Returns { caps, capSpread } — capital cell
// indices (index = owner id) and each capital's size-graded variance budget.
function allocateCapitals({ N, W, H, isLand, landId, habit, count, areaSkew, rand }) {
  let nLand = 0;
  for (let c = 0; c < N; c++) if (landId[c] + 1 > nLand) nLand = landId[c] + 1;
  if (!nLand) return { caps: [], capSpread: [] };

  // cos(latitude) per row — real area and east–west distance shrink toward the
  // poles, where the grid's longitude cells converge. Reckoning area + spacing in
  // these REAL units (not raw cells) stops the poles from collecting a crowd of
  // capitals and shredding into slivers. Floored so the pole rows aren't exactly 0.
  const cw = new Float64Array(H);
  for (let y = 0; y < H; y++) {
    const lat = (90 - ((y + 0.5) / H) * 180) * (Math.PI / 180);
    cw[y] = Math.max(0.05, Math.cos(lat));
  }

  // real (weighted) area per landmass
  const area = new Float64Array(nLand);
  for (let c = 0; c < N; c++) if (isLand[c]) area[landId[c]] += cw[(c / W) | 0];

  // eligible masses, largest first (so the best-effort floor favours big land)
  const eligible = [];
  for (let m = 0; m < nLand; m++) if (area[m] >= MIN_AREA) eligible.push(m);
  if (!eligible.length) return { caps: [], capSpread: [] };
  eligible.sort((a, b) => area[b] - area[a]);

  // baseline one capital each, then distribute the extras by area^areaSkew
  const quota = new Int32Array(nLand);
  for (const m of eligible) quota[m] = 1;
  let extras = count - eligible.length;
  if (extras > 0) {
    const w = eligible.map((m) => Math.pow(area[m], areaSkew));
    let wsum = 0; for (const x of w) wsum += x;
    const frac = [];
    let used = 0;
    for (let i = 0; i < eligible.length; i++) {
      const exact = (extras * w[i]) / wsum;
      const fl = Math.floor(exact);
      quota[eligible[i]] += fl; used += fl;
      frac.push([exact - fl, i]);
    }
    frac.sort((a, b) => b[0] - a[0]);            // largest-remainder gets the rest
    for (let k = 0, rem = extras - used; k < rem && k < frac.length; k++) quota[eligible[frac[k][1]]] += 1;
  }

  // gather each eligible mass's cells once, then dart-throw within it
  const cellsByMass = new Map();
  for (const m of eligible) cellsByMass.set(m, []);
  for (let c = 0; c < N; c++) if (isLand[c] && quota[landId[c]] > 0) cellsByMass.get(landId[c]).push(c);

  const caps = [], capSpread = [];
  for (const m of eligible) {
    // variance budget grows with the mass's capital count: a 1–2-state mass stays
    // even (≈0), a crowded continent gets the full spread (≈1) → small countries
    // appear ALONGSIDE big ones on big land, while small masses partition evenly.
    const spreadScale = Math.min(1, Math.max(0, (quota[m] - 2) / 8));
    placeInMass({ cells: cellsByMass.get(m), q: quota[m], area: area[m], W, cw, habit, rand, caps, capSpread, spreadScale });
  }
  return { caps, capSpread };
}

// Place up to `q` capitals inside one landmass: habitability dart-throw with an
// in-mass min spacing (≈ the real radius implied by sharing the mass among q).
// Spacing is checked in REAL distance (longitude scaled by cos-lat) so capitals
// spread evenly on the ground, not in distorted grid cells. Always emits at least
// one capital (the sovereignty guarantee) even if spacing or habitability would
// otherwise starve a tight little island. Tags each capital with `spreadScale`.
function placeInMass({ cells, q, area, W, cw, habit, rand, caps, capSpread, spreadScale }) {
  if (!cells || !cells.length || q <= 0) return;
  let hmax = 0; for (const c of cells) if (habit[c] > hmax) hmax = habit[c];
  if (hmax <= 0) hmax = 1;

  const spacing = Math.max(1.5, Math.sqrt(area / q) * 0.62);
  const sp2 = spacing * spacing;
  const wHalf = W / 2;
  const px = [], py = [], pcw = [];               // grid coords + row cos of placed caps
  const picked = [];
  const maxAttempts = q * 4000 + 200;

  for (let a = 0; a < maxAttempts && picked.length < q; a++) {
    const c = cells[(rand() * cells.length) | 0];
    if (rand() > habit[c] / hmax) continue;       // habitability rejection
    const x = c % W, y = (c / W) | 0;
    let ok = true;
    for (let k = 0; k < px.length; k++) {
      let dx = Math.abs(x - px[k]); if (dx > wHalf) dx = W - dx; // longitude wraps
      const dxr = dx * 0.5 * (cw[y] + pcw[k]);     // east–west distance compressed by cos-lat
      const dy = y - py[k];
      if (dxr * dxr + dy * dy < sp2) { ok = false; break; }
    }
    if (!ok) continue;
    picked.push(c); px.push(x); py.push(y); pcw.push(cw[y]);
  }

  // guarantee the sovereignty capital: fall back to the most habitable cell
  if (!picked.length) {
    let best = cells[0], bh = -1;
    for (const c of cells) if (habit[c] > bh) { bh = habit[c]; best = c; }
    picked.push(best);
  }
  for (const c of picked) { caps.push(c); capSpread.push(spreadScale); }
}

// Orphan pass — guarantee zero wilderness. Growth can't cross more than
// SEA_SPAN_MAX cells of open water, so an island farther out than that (and below
// MIN_AREA, hence no capital of its own) is left unowned. Flood ownership outward
// from every already-owned land cell across ALL cells (water passable, sea cap
// ignored) so each such speck inherits the nearest capital's allegiance. Water is
// only a conduit here; its ownership is stripped again at the end.
function fillOrphans({ N, W, H, isLand, owner }) {
  const q = new Int32Array(N);
  const seen = new Uint8Array(N);
  let head = 0, tail = 0;
  for (let c = 0; c < N; c++) if (owner[c] >= 0) { q[tail++] = c; seen[c] = 1; }
  if (!tail) return;                              // no capitals at all

  while (head < tail) {
    const c = q[head++];
    const o = owner[c];
    const x = c % W, y = (c / W) | 0;
    const nbr = [
      y > 0 ? c - W : -1,
      y < H - 1 ? c + W : -1,
      x === 0 ? c + W - 1 : c - 1,
      x === W - 1 ? c - W + 1 : c + 1,
    ];
    for (const n of nbr) {
      if (n < 0 || seen[n]) continue;
      seen[n] = 1;
      if (owner[n] < 0) owner[n] = o;             // inherit nearest owner
      q[tail++] = n;
    }
  }
  for (let c = 0; c < N; c++) if (!isLand[c]) owner[c] = -1; // territory is land only
}

// Multi-source Dijkstra. Every capital starts at cost 0 owning its cell; the
// cheapest front to reach a cell claims it. Step cost rewards staying on one
// side of ridges/rivers and on land, divided by the owner's ambition so bolder
// states spread further. Crossing water is allowed for up to SEA_SPAN_MAX cells
// at `seaCost` each. There is no cost cutoff: fronts run until they meet, so all
// reachable land is claimed (any unreachable speck is handled by fillOrphans).
function growTerritory({ N, W, H, isLand, slopeN, riverMask, caps, ambition, ridgeW, riverW, seaCost }) {
  const dist = new Float64Array(N).fill(Infinity);
  const owner = new Int32Array(N).fill(-1);
  const srun = new Int16Array(N); // consecutive sea cells on the best path here
  const heap = new MinHeap(caps.length * 8 + 64);

  for (let i = 0; i < caps.length; i++) {
    const c = caps[i];
    dist[c] = 0; owner[c] = i; srun[c] = 0;
    heap.push(0, c);
  }

  while (heap.size) {
    const c = heap.pop();
    const dc = dist[c];
    const o = owner[c];
    const x = c % W, y = (c / W) | 0;
    const onLand = isLand[c] === 1;
    const amb = ambition[o];
    const water = !onLand;
    const wrun = srun[c];

    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy; if (ny < 0 || ny >= H) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = (x + dx + W) % W;
        const n = ny * W + nx;
        const base = dx && dy ? Math.SQRT2 : 1;
        const nLand = isLand[n] === 1;

        let step, nrun;
        if (nLand) {
          // onto land: distance × terrain penalty (ridges + rivers raise it)
          const pen = 1 + ridgeW * slopeN[n] + riverW * (riverMask[n] ? 1 : 0);
          step = base * pen; nrun = 0;
        } else {
          // onto water: only as a short, expensive strait crossing
          nrun = (water ? wrun : 0) + 1;
          if (nrun > SEA_SPAN_MAX) continue;
          step = base * seaCost;
        }

        const nd = dc + step / amb;
        if (nd >= dist[n]) continue;
        dist[n] = nd; owner[n] = o; srun[n] = nrun;
        heap.push(nd, n);
      }
    }
  }

  // Water cells were only bridges; territory is land. Drop any water ownership so
  // the vectorizer (land-only membership) doesn't try to outline the sea.
  for (let c = 0; c < N; c++) if (!isLand[c]) owner[c] = -1;
  return owner;
}
