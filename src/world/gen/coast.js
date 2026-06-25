/* ------------------------------------------------------------------ *
 *  Inversia — coastlines + lakes from the global field (Phase 4)
 *
 *  Turns the global elevation field into the first real vector map data:
 *
 *    coastline — marching squares at the water line. Every land/water boundary
 *      (continental shores AND lake shores) becomes a crisp contour line, which
 *      is what fixes "no borders along water": the boundary is now a real vector
 *      the rest of the platform can hang labels and country edges on.
 *
 *    lakes — flood-fill labels every connected WATER region. The single largest
 *      (longitude-wrapping) is the world ocean; everything else is an enclosed
 *      basin → a lake, emitted as a filled polygon and filtered by size. In the
 *      default inverted world this naturally yields several big "inland seas"
 *      (the continents turned to water, cut off from the main basin by the
 *      former oceans turned to land).
 *
 *  WHY THIS FIXES THE ZOOMED-OUT "HORIZONTAL LINES": output is plain GeoJSON in
 *  lon/lat. MapLibre's geojson-vt re-simplifies it per zoom, so there is no fixed
 *  raster to alias into stripes when the globe is small — the geometry just
 *  coarsens smoothly.
 *
 *  COORDINATES: the field is equirectangular. A sample at grid (gx, gy) — gx,gy
 *  may be fractional at an edge crossing — sits at the centre of its pixel:
 *      lon = -180 + (gx + 0.5) / W * 360
 *      lat =  90  - (gy + 0.5) / H * 180
 *  We do NOT wrap the marching-squares cell grid in x (the seam cell at the
 *  antimeridian is skipped), so no polygon ever straddles ±180° — at this
 *  resolution that costs only a hairline gap mid-Pacific. Flood-fill DOES wrap in
 *  x, so the Pacific reads as one ocean.
 * ------------------------------------------------------------------ */

const R_KM = 6371; // mean Earth radius, for the lake size filter

// ---- marching squares -----------------------------------------------------
// Classic 16-case contouring of `values` at iso-level `thr`, returning closed
// (and, where a contour runs off the grid edge, open) rings already in lon/lat.
//
// Edge crossings are deduplicated by an integer edge key so that a crossing
// shared by two neighbouring cells is ONE vertex. That makes every interior
// vertex degree-2, so the segments stitch into rings exactly — no float matching.
//
// Edges of a cell are numbered T=0 (top), R=1 (right), B=2 (bottom), L=3 (left).
const T = 0, RT = 1, B = 2, L = 3;

// case → segments as [edgeA, edgeB] pairs. Saddles (5, 10) are resolved at run
// time from the cell-centre average, so they are left null here.
const CASE_SEGS = {
  0: [], 1: [[B, L]], 2: [[RT, B]], 3: [[RT, L]], 4: [[T, RT]],
  5: null, 6: [[T, B]], 7: [[T, L]], 8: [[T, L]], 9: [[T, B]],
  10: null, 11: [[T, RT]], 12: [[RT, L]], 13: [[RT, B]], 14: [[B, L]], 15: [],
};

function marchingSquares(values, W, H, thr) {
  const idx = (x, y) => y * W + x;

  // Edge-crossing vertices, deduped. Key namespace: (y*W + x)*2 + orient,
  // orient 0 = horizontal edge (x..x+1, y), 1 = vertical edge (x, y..y+1).
  const vmap = new Map();
  const vlon = [];
  const vlat = [];

  const toLon = (gx) => -180 + ((gx + 0.5) / W) * 360;
  const toLat = (gy) => 90 - ((gy + 0.5) / H) * 180;

  function crossH(x, y) {
    const key = (y * W + x) * 2;
    let id = vmap.get(key);
    if (id === undefined) {
      const a = values[idx(x, y)], b = values[idx(x + 1, y)];
      let t = (thr - a) / (b - a);
      if (!Number.isFinite(t)) t = 0.5;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      id = vlon.length;
      vlon.push(toLon(x + t));
      vlat.push(toLat(y));
      vmap.set(key, id);
    }
    return id;
  }
  function crossV(x, y) {
    const key = (y * W + x) * 2 + 1;
    let id = vmap.get(key);
    if (id === undefined) {
      const a = values[idx(x, y)], b = values[idx(x, y + 1)];
      let t = (thr - a) / (b - a);
      if (!Number.isFinite(t)) t = 0.5;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      id = vlon.length;
      vlon.push(toLon(x));
      vlat.push(toLat(y + t));
      vmap.set(key, id);
    }
    return id;
  }

  // edge id (T/R/B/L) of cell (x,y) → shared crossing vertex
  const edgeVert = (edge, x, y) =>
    edge === T ? crossH(x, y) :
    edge === RT ? crossV(x + 1, y) :
    edge === B ? crossH(x, y + 1) :
    /* L */ crossV(x, y);

  const sa = []; // segment endpoints (parallel arrays of vertex ids)
  const sb = [];
  const pushSeg = (segs, x, y) => {
    for (const [ea, eb] of segs) {
      sa.push(edgeVert(ea, x, y));
      sb.push(edgeVert(eb, x, y));
    }
  };

  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const tl = values[idx(x, y)], tr = values[idx(x + 1, y)];
      const br = values[idx(x + 1, y + 1)], bl = values[idx(x, y + 1)];
      const code =
        (tl > thr ? 8 : 0) | (tr > thr ? 4 : 0) | (br > thr ? 2 : 0) | (bl > thr ? 1 : 0);
      if (code === 0 || code === 15) continue;

      let segs = CASE_SEGS[code];
      if (segs === null) {
        // saddle: pair the two below-corners (center above) or above-corners
        const center = (tl + tr + br + bl) * 0.25;
        if (code === 5) {
          // TR + BL above
          segs = center > thr ? [[T, L], [RT, B]] : [[T, RT], [B, L]];
        } else {
          // code === 10 : TL + BR above
          segs = center > thr ? [[T, RT], [B, L]] : [[T, L], [RT, B]];
        }
      }
      pushSeg(segs, x, y);
    }
  }

  return stitch(sa, sb, vlon, vlat);
}

// Stitch undirected segments into rings. Every interior crossing is degree-2, so
// following the unused segment at each vertex traces a chain to its end. Open
// chains (a contour that exits the grid at a pole or the skipped seam) are walked
// first from their degree-1 endpoints; whatever remains is closed loops.
function stitch(sa, sb, vlon, vlat) {
  const nv = vlon.length;
  const adj = Array.from({ length: nv }, () => []);
  for (let i = 0; i < sa.length; i++) {
    adj[sa[i]].push(i);
    adj[sb[i]].push(i);
  }
  const used = new Uint8Array(sa.length);
  const other = (seg, v) => (sa[seg] === v ? sb[seg] : sa[seg]);

  function walk(startSeg, startV) {
    const ids = [startV];
    let v = startV, seg = startSeg;
    while (seg !== -1 && !used[seg]) {
      used[seg] = 1;
      v = other(seg, v);
      ids.push(v);
      seg = -1;
      for (const s of adj[v]) if (!used[s]) { seg = s; break; }
    }
    const ring = new Array(ids.length);
    for (let i = 0; i < ids.length; i++) ring[i] = [vlon[ids[i]], vlat[ids[i]]];
    ring.closed = ids[0] === ids[ids.length - 1];
    return ring;
  }

  const rings = [];
  for (let v = 0; v < nv; v++) {
    if (adj[v].length === 1 && !used[adj[v][0]]) rings.push(walk(adj[v][0], v));
  }
  for (let i = 0; i < sa.length; i++) {
    if (!used[i]) rings.push(walk(i, sa[i]));
  }
  return rings;
}

// ---- water labelling ------------------------------------------------------
// Flood-fill (4-neighbour, longitude wraps) every connected WATER region. Returns
// the per-cell component id (-1 for land) and the id of the largest component by
// cos-lat-weighted area — that one is the world ocean.
function labelWater(eff, W, H, level) {
  const comp = new Int32Array(W * H).fill(-1);
  const area = []; // cos-lat-weighted area per component
  const stack = [];
  let next = 0;

  // precompute row weight (geographic area per cell ∝ cos(lat))
  const rowW = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    const lat = (90 - ((y + 0.5) / H) * 180) * Math.PI / 180;
    rowW[y] = Math.cos(lat);
  }

  for (let s = 0; s < W * H; s++) {
    if (eff[s] > level || comp[s] !== -1) continue; // land or already labelled
    const id = next++;
    let a = 0;
    comp[s] = id;
    stack.push(s);
    while (stack.length) {
      const c = stack.pop();
      const x = c % W, y = (c / W) | 0;
      a += rowW[y];
      // 4 neighbours; x wraps, y clamps
      const nbr = [
        y > 0 ? c - W : -1,
        y < H - 1 ? c + W : -1,
        (x === 0 ? c + W - 1 : c - 1),
        (x === W - 1 ? c - W + 1 : c + 1),
      ];
      for (const n of nbr) {
        if (n >= 0 && comp[n] === -1 && eff[n] <= level) {
          comp[n] = id;
          stack.push(n);
        }
      }
    }
    area.push(a);
  }

  let oceanId = -1, max = -1;
  for (let i = 0; i < area.length; i++) if (area[i] > max) { max = area[i]; oceanId = i; }
  return { comp, oceanId, count: next };
}

// ---- ring geometry helpers ------------------------------------------------
// Planar shoelace in km around the ring's mean latitude — exact enough to size
// a lake for the min-size filter.
function ringAreaKm2(ring) {
  let latSum = 0;
  for (const [, lat] of ring) latSum += lat;
  const lat0 = (latSum / ring.length) * Math.PI / 180;
  const kx = R_KM * Math.cos(lat0) * Math.PI / 180;
  const ky = R_KM * Math.PI / 180;
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    a += x1 * kx * (y2 * ky) - x2 * kx * (y1 * ky);
  }
  return Math.abs(a) / 2;
}

// minSize (0..1) → minimum lake area in km². At a 1° source most inland water is
// already a few huge cells (~12 000 km² each), so the floor climbs steeply: 0
// keeps essentially everything, 1 keeps only inland seas.
function minLakeKm2(minSize) {
  const s = Math.min(1, Math.max(0, minSize));
  return 200 * Math.pow(5000, s); // 0 → 200, 0.2 → ~1100, 0.5 → ~14 000, 1 → 1e6
}

// ---- public API -----------------------------------------------------------
const emptyFC = () => ({ type: "FeatureCollection", features: [] });

/**
 * Generate coastline + lake GeoJSON from the global field for the given world
 * settings. The contour level is the recipe water level; inversion flips the
 * field first, exactly as the live shader does (eff = invert ? -elev : elev).
 *
 * @param {{elev: Float32Array, W: number, H: number}} field
 * @param {{water: number, invert: boolean, minSize: number}} opts
 * @returns {{coast: object, lakes: object, stats: {lakes: number}}}
 */
export function generate(field, { water, invert, minSize }) {
  const { elev, W, H } = field;
  const level = water;

  // eff field — what the shader actually thresholds. Land where eff > level.
  const eff = new Float32Array(W * H);
  if (invert) for (let i = 0; i < eff.length; i++) eff[i] = -elev[i];
  else eff.set(elev);

  // --- coastline: every land/water boundary at the water line ---
  const coastRings = marchingSquares(eff, W, H, level);
  const coast = {
    type: "FeatureCollection",
    features: coastRings.length
      ? [{
          type: "Feature",
          properties: {},
          geometry: { type: "MultiLineString", coordinates: coastRings.map((r) => r.map((p) => p)) },
        }]
      : [],
  };

  // --- lakes: enclosed water basins (everything but the world ocean) ---
  const { comp, oceanId } = labelWater(eff, W, H, level);
  const lakeMask = new Float32Array(W * H);
  for (let i = 0; i < lakeMask.length; i++) {
    lakeMask[i] = comp[i] !== -1 && comp[i] !== oceanId ? 1 : 0;
  }

  const lakeRings = marchingSquares(lakeMask, W, H, 0.5);
  const minKm2 = minLakeKm2(minSize);
  const lakes = emptyFC();
  for (const ring of lakeRings) {
    // close open rings (a basin touching a pole / the skipped seam) so they fill
    const r = ring.closed ? ring : [...ring, ring[0]];
    const km2 = ringAreaKm2(r);
    if (km2 < minKm2) continue;
    lakes.features.push({
      type: "Feature",
      properties: { area_km2: Math.round(km2) },
      geometry: { type: "Polygon", coordinates: [r] },
    });
  }

  return { coast, lakes, stats: { lakes: lakes.features.length } };
}
