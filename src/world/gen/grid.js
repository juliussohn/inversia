/* ------------------------------------------------------------------ *
 *  Inversia — shared grid + GeoJSON primitives for the generation passes
 *
 *  Small building blocks the worker's gen modules (coast, hydro, countries,
 *  cities, biome) all stand on: an equirectangular cell grid where longitude
 *  wraps and latitude clamps. Kept here as one source of truth so the passes
 *  can't drift apart.
 * ------------------------------------------------------------------ */

// Mean Earth radius (km) — for cos-latitude cell areas and the lake size filter.
export const R_KM = 6371;

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export const emptyFC = () => ({ type: "FeatureCollection", features: [] });

// Multi-source BFS in cell steps. `isSource(c)` seeds distance 0; expansion is
// confined to cells where `passable(c)` holds (pass `() => true` to flood every
// cell). Returns Float64 distances (cells), Infinity where unreached. x wraps, y
// clamps — same topology as the floods. Neighbour order is irrelevant: BFS on an
// unweighted grid yields the same distances however the front is visited.
export function bfsDistance(N, W, H, isSource, passable) {
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

// Stitch undirected segments into rings. Every interior crossing is degree-2, so
// following the unused segment at each vertex traces a chain to its end. Open
// chains (a contour that exits the grid at a pole or the skipped seam) are walked
// first from their degree-1 endpoints; whatever remains is closed loops. Shared by
// the coastline contour and the country-border tracer (both marching-squares).
export function stitch(sa, sb, vlon, vlat) {
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
