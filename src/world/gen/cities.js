/* ------------------------------------------------------------------ *
 *  Inversia — cities: ranked settlements on habitable ground (Phase 7)
 *
 *  The populated layer, placed over the same global field that produced coasts,
 *  rivers and countries. Cities are not scattered at random: every land cell is
 *  scored for how good a SITE it is — flat ground, low elevation, close to the
 *  coast, close to a river, and best of all at a river CONFLUENCE (where real
 *  cities concentrate) — and settlements are then placed greedily from the best
 *  sites down, each one keeping a Poisson-disk minimum spacing from the cities
 *  already placed. Placing best-first means the very first city is the single
 *  most habitable spot on the planet, so placement order IS the population rank.
 *
 *  THE PIPELINE (over the cached field + hydrology + country ownership):
 *
 *    1. SUITABILITY. Score each land cell: a flatness term, a moderate-elevation
 *       term, and additive draws toward coast / river / confluence. Strictly
 *       positive on all land so even a dry interior can still host a frontier town.
 *
 *    2. PLACEMENT. Counting-sort the land cells by score (no comparator over ~2M
 *       cells), then walk them best-first. A spatial hash enforces a minimum
 *       spacing (the recipe's `spacing`); we stop once `density` worth of cities
 *       are placed or the spacing floor exhausts the candidates — whichever first.
 *
 *    3. RANK + TIERS. Score order is the rank (1 = biggest). EVERY country that
 *       holds territory gets a CAPITAL — its best placed city if it has one, or a
 *       forced seat on its single best owned cell if the budget-limited, coast-
 *       biased placement skipped it (so small/landlocked countries are never left
 *       capital-less). Capitals are ranked ahead of all others, so collision never
 *       culls them; the remaining cities split into metropolis / city / town by
 *       rank fraction. Cities on wilderness (owner -1) are frontier towns with no
 *       country and never capitals.
 *
 *  Each city carries { rank, tier, capital, country, score } so the symbol layer
 *  can size it and let big cities win label space under collision; names are
 *  Phase 9 (the rank/tier stand in for now). Owning country is read straight from
 *  the growth `owner` array so a city's allegiance always matches its territory.
 *
 *  COORDINATES match coast.js / hydro.js / countries.js exactly: cell (x,y) sits
 *  at lon = -180 + (x+0.5)/W*360, lat = 90 - (y+0.5)/H*180; the grid wraps in x
 *  (longitude) and clamps in y (poles). Cities are points, so unlike the line
 *  layers there is no antimeridian seam to split.
 * ------------------------------------------------------------------ */

import { clamp01, emptyFC, bfsDistance } from "./grid.js";

// Slope (metres of relief to the steepest neighbour) that saturates the flatness
// penalty — matches countries.js so "mountainous" means the same thing here.
const SLOPE_SCALE = 900;

// A river cell, for the city draw, is one draining at least this (km²). Lower than
// the country border's trunk threshold so even modest rivers pull settlement, the
// way real towns cluster along ordinary rivers, not only the continental trunks.
const RIVER_CITY_KM2 = 25000;

// Counting-sort resolution: cells are bucketed into this many score bands and
// walked band-high→low. 2048 bands make the within-band ordering invisible while
// keeping placement O(N) instead of an O(N log N) comparator sort over ~2M cells.
const SCORE_BANDS = 2048;

/**
 * Place ranked cities over the global field.
 *
 * @param {{elev: Float32Array, W: number, H: number}} field
 * @param {{W:number,H:number,recv:Int32Array,acc:Float64Array}|null} flow  hydrology
 *        (river + confluence draws); pass null to score on terrain/coast alone.
 * @param {{owner: Int32Array, isLand: Uint8Array}} country  from computeCountries
 *        (owner ≥0 = a country's territory, -1 = sea or wilderness).
 * @param {{water:number, invert:boolean, density:number, spacing:number}} opts
 * @returns {{cities: object, stats: {cities:number}}}
 */
export function computeCities(field, flow, country, opts) {
  const { elev, W, H } = field;
  const N = W * H;
  const { water, invert, density, spacing } = opts;
  const level = water;

  // Resolve the 0..1 placement knobs onto the suitability weights; 0.5 reproduces
  // the hand-tuned baseline, and a missing value (old world) also falls back to 0.5.
  const norm = (v) => (Number.isFinite(v) ? clamp01(v) : 0.5);
  const coastW = 1.6 * norm(opts.coastPull);                       // 0.5 → 0.8 (draw toward the sea)
  const riverW = 1.4 * norm(opts.riverPull);                       // 0.5 → 0.7 (draw toward rivers)
  const lowDecay = 1800 * Math.pow(4, 0.5 - norm(opts.lowland));   // 0.5 → 1800 m; higher = mountains repel harder
  const bigShare = norm(opts.bigCityShare);
  const metroCut = 0.12 * bigShare;                                // 0.5 → 0.06 (top fraction that are metropolises)
  const cityCut = 0.60 * bigShare;                                 // 0.5 → 0.30 (fraction that are at least cities)

  // Prefer the ownership-derived land mask (identical thresholding to the growth
  // pass) so cities never land a pixel off the territory they're assigned to.
  const isLand = country?.isLand ?? deriveLand(elev, N, invert, level);
  const owner = country?.owner ?? null;

  // eff = the surface the shader thresholds; height = metres above the water line.
  const eff = new Float32Array(N);
  if (invert) for (let i = 0; i < N; i++) eff[i] = -elev[i];
  else eff.set(elev);

  let landCount = 0;
  for (let i = 0; i < N; i++) if (isLand[i]) landCount++;
  if (!landCount) return { cities: emptyFC(), stats: { cities: 0 } };

  // --- per-cell terrain inputs ---------------------------------------------
  // slope: steepest relief to an 8-neighbour, normalised → flatness draw.
  const slopeN = new Float32Array(N);
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

  // river + confluence masks from the hydrology flow field. A confluence is a
  // river cell that two or more river tributaries drain into — the prime city site.
  const riverMask = new Uint8Array(N);
  const confMask = new Uint8Array(N);
  if (flow && flow.acc && flow.recv) {
    const { acc, recv } = flow;
    for (let i = 0; i < N; i++) if (isLand[i] && acc[i] >= RIVER_CITY_KM2) riverMask[i] = 1;
    const indeg = new Int32Array(N);
    for (let i = 0; i < N; i++) {
      if (!riverMask[i]) continue;
      const r = recv[i];
      if (r >= 0 && riverMask[r]) indeg[r]++;
    }
    for (let i = 0; i < N; i++) if (riverMask[i] && indeg[i] >= 2) confMask[i] = 1;
  }

  // distance (in cells) to the nearest sea, river, and confluence, for the draws.
  const distWater = bfsDistance(N, W, H, (c) => !isLand[c], (c) => isLand[c]);
  const distRiver = bfsDistance(N, W, H, (c) => riverMask[c] === 1, (c) => isLand[c]);
  const distConf = bfsDistance(N, W, H, (c) => confMask[c] === 1, (c) => isLand[c]);

  // --- suitability ---------------------------------------------------------
  // Livable where it's flat and low, with additive draws toward the sea, rivers,
  // and especially confluences. Kept strictly positive on land so the spacing
  // floor — not a zero score — is what ever stops a town from forming.
  const score = new Float32Array(N);
  let smax = 0;
  for (let i = 0; i < N; i++) {
    if (!isLand[i]) continue;
    const flat = 1 / (1 + slopeN[i] * 4);
    const hkm = Math.max(0, eff[i] - level);
    const lowland = Math.exp(-hkm / lowDecay);       // high ground less habitable
    const coast = Math.exp(-distWater[i] / 6);
    const river = distRiver[i] === Infinity ? 0 : Math.exp(-distRiver[i] / 5);
    const conf = distConf[i] === Infinity ? 0 : Math.exp(-distConf[i] / 4);
    const s = (0.1 + flat * (0.35 + coastW * coast + riverW * river + 0.9 * conf)) * (0.45 + 0.55 * lowland);
    score[i] = s;
    if (s > smax) smax = s;
  }
  if (smax <= 0) return { cities: emptyFC(), stats: { cities: 0 } };

  // --- order land cells best-first (counting sort by score band) -----------
  const bandOf = (c) => {
    let b = (score[c] / smax) * SCORE_BANDS | 0;
    if (b >= SCORE_BANDS) b = SCORE_BANDS - 1;
    return b;
  };
  const counts = new Int32Array(SCORE_BANDS + 1);
  for (let c = 0; c < N; c++) if (isLand[c]) counts[bandOf(c)]++;
  let run = 0;
  for (let b = 0; b < SCORE_BANDS; b++) { const t = counts[b]; counts[b] = run; run += t; }
  const ordered = new Int32Array(landCount);
  const cursor = counts.slice();
  for (let c = 0; c < N; c++) if (isLand[c]) ordered[cursor[bandOf(c)]++] = c;
  // `ordered` is ascending by band; walk it from the end for best-first.

  // --- greedy placement with a Poisson-disk spacing floor ------------------
  // spacing knob → minimum separation; density knob → how many we aim to place.
  // Whichever binds first stops us, so the two knobs stay independent: spacing is
  // a hard floor on closeness, density a soft target on count.
  const spacingCells = lerp(6, 30, clamp01(spacing));
  const sp2 = spacingCells * spacingCells;
  const target = Math.round(lerp(40, 700, clamp01(density)));

  const grid = new SpacingGrid(W, H, spacingCells);
  const placed = []; // cell indices, best-first → already in rank order

  for (let i = landCount - 1; i >= 0 && placed.length < target; i--) {
    const c = ordered[i];
    const x = c % W, y = (c / W) | 0;
    if (grid.tooClose(x, y, sp2)) continue;
    grid.add(x, y);
    placed.push(c);
  }

  // --- capitals: every country gets one ------------------------------------
  // The greedy pass is budget-limited and biased to high-suitability ground
  // (coasts, rivers), so a small or landlocked country can end up with no placed
  // city at all. But a country is a political unit no matter how livable it is, so
  // EVERY country that holds territory must have a capital. We collect the final
  // city list as: all the placed cities, plus — for any country the greedy pass
  // skipped entirely — one FORCED capital on that country's single best-scoring
  // owned cell. A country that did get cities has its best placed city promoted.
  const cells = placed.slice();          // greedy cities (best-first by score)
  const capOf = new Map();               // country id → index into `cells` (its capital)

  if (owner) {
    // each country's best PLACED city is its capital (placed is best-first, so the
    // first one we see for a country is its highest-scoring city).
    for (let i = 0; i < cells.length; i++) {
      const o = owner[cells[i]];
      if (o >= 0 && !capOf.has(o)) capOf.set(o, i);
    }
    // best owned cell per country over ALL land — the seat for any country the
    // greedy budget missed. One pass; ties break on lower cell index (stable).
    const bestCell = new Map(), bestScore = new Map();
    for (let c = 0; c < N; c++) {
      const o = owner[c];
      if (o < 0 || !isLand[c]) continue;
      const s = score[c];
      if (!bestScore.has(o) || s > bestScore.get(o)) { bestScore.set(o, s); bestCell.set(o, c); }
    }
    for (const [o, c] of bestCell) {
      if (!capOf.has(o)) { capOf.set(o, cells.length); cells.push(c); } // forced capital
    }
  }

  const m = cells.length;
  if (!m) return { cities: emptyFC(), stats: { cities: 0 } };

  // --- rank + tiers --------------------------------------------------------
  // Order capitals FIRST (by score), then every other city (by score). Lower rank
  // = bigger symbol and higher collision priority, so each capital outranks every
  // town and is never culled — including the low-suitability landlocked seats we
  // just forced in. Non-capitals split into metropolis / city / town by fraction.
  const capSet = new Set(capOf.values());
  const idxs = Array.from({ length: m }, (_, i) => i);
  idxs.sort((a, b) => {
    const ca = capSet.has(a), cb = capSet.has(b);
    if (ca !== cb) return ca ? -1 : 1;          // all capitals ahead of all others
    return score[cells[b]] - score[cells[a]];   // then by descending suitability
  });

  const rank = new Int32Array(m);
  const tier = new Array(m);
  const nNonCap = m - capSet.size;
  let nonCapSeen = 0;
  for (let r = 0; r < m; r++) {
    const i = idxs[r];
    rank[i] = r + 1;
    if (capSet.has(i)) { tier[i] = "capital"; continue; }
    const frac = nNonCap ? nonCapSeen / nNonCap : 0;
    tier[i] = frac < metroCut ? "metropolis" : frac < cityCut ? "city" : "town";
    nonCapSeen++;
  }

  const toLon = (x) => -180 + ((x + 0.5) / W) * 360;
  const toLat = (y) => 90 - ((y + 0.5) / H) * 180;

  const features = new Array(m);
  for (let i = 0; i < m; i++) {
    const c = cells[i];
    const o = owner ? owner[c] : -1;
    features[i] = {
      type: "Feature",
      properties: {
        rank: rank[i],
        tier: tier[i],
        capital: tier[i] === "capital",
        country: o >= 0 ? o : -1,
        score: Math.round(score[c] * 1000),
      },
      geometry: { type: "Point", coordinates: [toLon(c % W), toLat((c / W) | 0)] },
    };
  }

  return { cities: { type: "FeatureCollection", features }, stats: { cities: m } };
}

// ---- helpers --------------------------------------------------------------
const lerp = (a, b, t) => a + (b - a) * t;

function deriveLand(elev, N, invert, level) {
  const isLand = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    const e = invert ? -elev[i] : elev[i];
    if (e > level) isLand[i] = 1;
  }
  return isLand;
}

// Spatial hash over (x,y) cells bucketed at the spacing radius, so a rejection
// test only checks the 3×3 neighbouring buckets instead of every placed city.
// Longitude wraps: the bucket column index and the x-distance both fold at W.
class SpacingGrid {
  constructor(W, H, radius) {
    this.W = W; this.H = H;
    this.cell = Math.max(1, radius);
    this.gw = Math.max(1, Math.ceil(W / this.cell));
    this.gh = Math.max(1, Math.ceil(H / this.cell));
    this.buckets = new Map(); // gy*gw+gx → [x, y, x, y, …]
  }
  _key(gx, gy) { return gy * this.gw + gx; }
  add(x, y) {
    const gx = (x / this.cell) | 0, gy = (y / this.cell) | 0;
    const k = this._key(gx, gy);
    let arr = this.buckets.get(k);
    if (!arr) { arr = []; this.buckets.set(k, arr); }
    arr.push(x, y);
  }
  tooClose(x, y, sp2) {
    const gx = (x / this.cell) | 0, gy = (y / this.cell) | 0;
    const { W, gw, gh } = this;
    const wHalf = W / 2;
    for (let dgy = -1; dgy <= 1; dgy++) {
      const ny = gy + dgy;
      if (ny < 0 || ny >= gh) continue;
      for (let dgx = -1; dgx <= 1; dgx++) {
        const nx = ((gx + dgx) % gw + gw) % gw; // bucket column wraps with longitude
        const arr = this.buckets.get(this._key(nx, ny));
        if (!arr) continue;
        for (let i = 0; i < arr.length; i += 2) {
          let ddx = Math.abs(x - arr[i]); if (ddx > wHalf) ddx = W - ddx;
          const ddy = y - arr[i + 1];
          if (ddx * ddx + ddy * ddy < sp2) return true;
        }
      }
    }
    return false;
  }
}
