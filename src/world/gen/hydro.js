/* ------------------------------------------------------------------ *
 *  Inversia — hydrology: rivers from the global field (Phase 5)
 *
 *  Turns the same global elevation field that produced coasts and lakes into a
 *  branching river network. Rivers are a headline feature in their own right and
 *  an input to country borders (Phase 6) and city placement (Phase 7), so they
 *  come first — and they are derived, not authored, from the terrain surface.
 *
 *  THE PIPELINE (classic terrain-analysis hydrology):
 *
 *    1. PRIORITY-FLOOD depression fill (Barnes et al. 2014, the +ε variant).
 *       Real and inverted terrain is full of pits the raw grid would trap water
 *       in. We flood inward from the sea/lake shoreline with a min-heap, raising
 *       every land cell to at least its lowest spill point + a tiny epsilon. The
 *       result is a surface with NO interior sinks and a strictly-downhill path
 *       from every land cell to water — the precondition for flow routing.
 *
 *    2. D8 FLOW DIRECTIONS. On the filled surface each land cell sends all its
 *       water to its single steepest-descent neighbour (of 8). The epsilon from
 *       step 1 guarantees such a neighbour always exists, so there are no stalls.
 *
 *    3. FLOW ACCUMULATION. Processing cells from high to low, each cell pushes
 *       its own catchment area (cos-lat weighted, in km²) plus everything that
 *       drained into it down to its receiver. A cell's accumulation is the size
 *       of the basin upstream of it — the discharge proxy that sets river width.
 *
 *  EXTRACTION (cheap, re-runs on a threshold change without redoing 1–3):
 *    Cells whose accumulation clears the recipe threshold are river cells. We
 *    trace them into polylines split at confluences, tag each with a `flow`
 *    (km² drained) and a Strahler `order` for width styling, and terminate every
 *    channel where it meets the sea or a lake. Output is plain GeoJSON in lon/lat
 *    so MapLibre's geojson-vt simplifies it per zoom like the coast layer.
 *
 *  COORDINATES match coast.js exactly: a grid cell (x,y) sits at the centre of
 *  its pixel, lon = -180 + (x+0.5)/W*360, lat = 90 - (y+0.5)/H*180. The grid
 *  wraps in x (antimeridian) and clamps in y (poles), same as the flood-fill.
 * ------------------------------------------------------------------ */

const R_KM = 6371; // mean Earth radius, for cos-lat cell areas

// A binary min-heap over (priority: float, payload: int cell index). Plain typed
// arrays — no per-entry objects — so the ~2M-cell priority flood stays fast.
class MinHeap {
  constructor(capacity) {
    this.prio = new Float64Array(capacity);
    this.item = new Int32Array(capacity);
    this.size = 0;
  }
  push(prio, item) {
    let i = this.size++;
    this.prio[i] = prio;
    this.item[i] = item;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.prio[p] <= this.prio[i]) break;
      this._swap(i, p);
      i = p;
    }
  }
  /** Pop the lowest-priority entry, returning its payload (cell index). */
  pop() {
    const top = this.item[0];
    const n = --this.size;
    this.prio[0] = this.prio[n];
    this.item[0] = this.item[n];
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < n && this.prio[l] < this.prio[m]) m = l;
      if (r < n && this.prio[r] < this.prio[m]) m = r;
      if (m === i) break;
      this._swap(i, m);
      i = m;
    }
    return top;
  }
  _swap(a, b) {
    const tp = this.prio[a]; this.prio[a] = this.prio[b]; this.prio[b] = tp;
    const ti = this.item[a]; this.item[a] = this.item[b]; this.item[b] = ti;
  }
}

// Per-row geographic area of one cell (∝ cos lat), in km². Used as each cell's
// own contribution to downstream accumulation so big tropical basins outweigh
// the tiny squeezed-together cells near the poles.
function rowAreaKm2(W, H) {
  const dLon = (2 * Math.PI) / W; // radians of longitude per cell
  const dLat = Math.PI / H;       // radians of latitude per cell
  const k = R_KM * R_KM * dLon * dLat;
  const a = new Float64Array(H);
  for (let y = 0; y < H; y++) {
    const lat = ((90 - ((y + 0.5) / H) * 180) * Math.PI) / 180;
    a[y] = k * Math.cos(lat);
  }
  return a;
}

/**
 * Heavy hydrology pass: priority-flood + D8 + accumulation. Depends only on the
 * water line and inversion, so the worker caches it and re-runs only the cheap
 * extractRivers() when just the threshold changes.
 *
 * @param {{elev: Float32Array, W: number, H: number}} field
 * @param {{water: number, invert: boolean}} opts
 * @returns {{W:number, H:number, recv:Int32Array, acc:Float64Array}}
 *   recv[i] = receiver cell index for land (any neighbour, incl. water mouth),
 *             or -1 for water cells (sinks). acc[i] = km² drained through i.
 */
export function computeFlow(field, { water, invert }) {
  const { elev, W, H } = field;
  const N = W * H;
  const level = water;

  // eff = the surface the shader thresholds. Land where eff > level.
  const eff = new Float32Array(N);
  if (invert) for (let i = 0; i < N; i++) eff[i] = -elev[i];
  else eff.set(elev);

  // --- 1. priority-flood + epsilon -----------------------------------------
  // Seed the heap with every water cell at the waterline; flood inland, raising
  // each land cell to max(its own height, parent's filled + ε). `order` records
  // land cells in pop order = increasing filled height, for the accumulation pass.
  const filled = new Float32Array(N);
  const closed = new Uint8Array(N);
  const order = new Int32Array(N); // land cells, increasing filled height
  let nLand = 0;
  const heap = new MinHeap(N);
  const EPS = 1e-3; // metres; just enough to guarantee a downhill gradient

  for (let i = 0; i < N; i++) {
    if (eff[i] <= level) { closed[i] = 1; filled[i] = eff[i]; heap.push(level, i); }
  }

  while (heap.size) {
    const c = heap.pop();
    const x = c % W, y = (c / W) | 0;
    if (eff[c] > level) order[nLand++] = c; // a land cell, now finalised
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= H) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = (x + dx + W) % W; // longitude wraps
        const n = ny * W + nx;
        if (closed[n]) continue;
        closed[n] = 1;
        filled[n] = Math.max(eff[n], filled[c] + EPS);
        heap.push(filled[n], n);
      }
    }
  }

  // --- 2. D8 receivers ------------------------------------------------------
  // Steepest descent on the filled surface. Every land cell has a strictly lower
  // neighbour (guaranteed by the epsilon flood), so recv is always set for land.
  const recv = new Int32Array(N).fill(-1);
  for (let k = 0; k < nLand; k++) {
    const c = order[k];
    const x = c % W, y = (c / W) | 0;
    const hc = filled[c];
    let best = -1, bestDrop = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const ny = y + dy;
      if (ny < 0 || ny >= H) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = (x + dx + W) % W;
        const n = ny * W + nx;
        // diagonal steps are longer, so weight the drop by 1/distance
        const dist = dx && dy ? Math.SQRT1_2 : 1;
        const drop = (hc - filled[n]) * dist;
        if (drop > bestDrop) { bestDrop = drop; best = n; }
      }
    }
    recv[c] = best;
  }

  // --- 3. flow accumulation -------------------------------------------------
  // Own area first, then drain high→low so a cell is fully summed before it
  // hands its total to its receiver. Water receivers (river mouths) just absorb.
  const rowA = rowAreaKm2(W, H);
  const acc = new Float64Array(N);
  for (let k = 0; k < nLand; k++) acc[order[k]] = rowA[(order[k] / W) | 0];
  for (let k = nLand - 1; k >= 0; k--) {
    const c = order[k];
    const r = recv[c];
    if (r >= 0) acc[r] += acc[c];
  }

  return { W, H, recv, acc };
}

// recipe threshold (0..1) → minimum drained area (km²) to count as a river.
// Geometric so a small drag near 0 already thins the network: at this ~0.18°
// field one equatorial cell is ~380 km², so 0 keeps streams of a dozen cells and
// 1 keeps only continental trunks.
function riverThresholdKm2(threshold) {
  const s = Math.min(1, Math.max(0, threshold));
  return 4000 * Math.pow(250, s); // 0 → 4k, 0.5 → ~63k, 1 → 1e6
}

/**
 * Cheap extraction: pick river cells over the threshold, trace them into
 * polylines split at confluences, and tag each with flow + Strahler order.
 *
 * @param {{W:number,H:number,recv:Int32Array,acc:Float64Array}} flow
 * @param {{threshold:number}} opts
 * @returns {{rivers: object, stats: {rivers:number}}}
 */
export function extractRivers(flow, { threshold }) {
  const { W, H, recv, acc } = flow;
  const N = W * H;
  const thr = riverThresholdKm2(threshold);

  const isRiver = new Uint8Array(N);
  const rivers = [];
  for (let i = 0; i < N; i++) if (recv[i] >= 0 && acc[i] >= thr) { isRiver[i] = 1; rivers.push(i); }

  if (!rivers.length) {
    return { rivers: { type: "FeatureCollection", features: [] }, stats: { rivers: 0 } };
  }

  // in-degree among river cells: how many river tributaries flow into each cell.
  // 0 → a source (channel head); ≥2 → a confluence (where we split segments).
  const indeg = new Int32Array(N);
  for (const c of rivers) {
    const r = recv[c];
    if (r >= 0 && isRiver[r]) indeg[r]++;
  }

  // Strahler order, computed donors-before-parent by walking river cells in
  // ascending accumulation (a receiver always drains a strictly larger area than
  // any one donor, so ascending acc guarantees every donor is done first).
  const byAcc = rivers.slice().sort((a, b) => acc[a] - acc[b]);
  const order = new Int32Array(N);
  const maxDonorOrder = new Int32Array(N);
  const maxDonorCount = new Int32Array(N);
  for (const c of byAcc) {
    const o = indeg[c] === 0 ? 1 : maxDonorOrder[c] + (maxDonorCount[c] >= 2 ? 1 : 0);
    order[c] = o;
    const r = recv[c];
    if (r >= 0 && isRiver[r]) {
      if (o > maxDonorOrder[r]) { maxDonorOrder[r] = o; maxDonorCount[r] = 1; }
      else if (o === maxDonorOrder[r]) maxDonorCount[r]++;
    }
  }

  const toLon = (x) => -180 + ((x + 0.5) / W) * 360;
  const toLat = (y) => 90 - ((y + 0.5) / H) * 180;
  const center = (i) => [toLon(i % W), toLat((i / W) | 0)];

  // A segment starts at a source (indeg 0) or at a confluence (indeg ≥2), and
  // runs downstream until the next confluence or the river mouth (water). Each
  // segment is one Feature so MapLibre can size it by its own Strahler order.
  const features = [];
  for (const s of rivers) {
    if (indeg[s] !== 0 && indeg[s] < 2) continue; // mid-channel cell, not a start
    const path = [s];           // the cell-index path of this segment
    let c = s;
    for (;;) {
      const r = recv[c];
      if (r < 0 || !isRiver[r]) {
        // reached the sea / a lake: extend into the mouth cell so the channel
        // visibly touches the shore, then stop.
        if (r >= 0) path.push(r);
        break;
      }
      path.push(r);
      if (indeg[r] >= 2) break;  // hit a confluence: it ends here (a new segment starts there)
      c = r;
    }
    if (path.length < 2) continue;

    // Properties come from the last cell that truly belongs to this tributary —
    // the cell just upstream of the terminating confluence/mouth — so a segment's
    // width reflects its own flow, not the larger channel it merges into.
    const repCell = path[path.length - 2];
    const props = { flow: Math.round(acc[repCell]), strahler: order[repCell] };

    // Flow routing wraps in longitude, so a segment whose receiver sits across
    // the ±180° seam would otherwise draw a line straight across the globe. Split
    // the polyline wherever consecutive points jump >180° in lon (same hairline-
    // gap-at-the-antimeridian compromise the coast layer makes), emitting each
    // run as its own Feature.
    let run = [center(path[0])];
    for (let k = 1; k < path.length; k++) {
      const p = center(path[k]);
      if (Math.abs(p[0] - run[run.length - 1][0]) > 180) {
        if (run.length >= 2) features.push(lineFeature(run, props));
        run = [p];
      } else {
        run.push(p);
      }
    }
    if (run.length >= 2) features.push(lineFeature(run, props));
  }

  return {
    rivers: { type: "FeatureCollection", features },
    stats: { rivers: features.length },
  };
}

function lineFeature(coords, properties) {
  return { type: "Feature", properties, geometry: { type: "LineString", coordinates: coords } };
}
