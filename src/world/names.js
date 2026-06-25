/* ------------------------------------------------------------------ *
 *  Inversia — procedural place names (Phase 9)
 *
 *  Cosmetic but high-delight: every country, city, river and lake gets a STABLE,
 *  deterministic name derived from the world seed. Same seed → same names; change
 *  the seed and the whole atlas is renamed. No network, no LLM — pure syllable
 *  grammar so it works offline and bakes into a self-contained world.
 *
 *  PER-LANGUAGE-FAMILY. Names are not drawn from one global pool: each country is
 *  assigned a LANGUAGE FAMILY (a distinct phonotactic style — clustered onsets,
 *  vowels, codas and place-suffixes), and the assignment is SPATIAL, so countries
 *  that sit near each other tend to share a family and therefore a phonetic feel,
 *  the way real neighbouring nations do. A river or lake takes the family of the
 *  territory it runs through; a city takes the family of its owning country.
 *
 *  WHERE IT RUNS. In the generation worker, right after countries/cities/rivers/
 *  lakes exist, so it has the `owner` grid (cell → country) to read allegiance and
 *  geography straight off the field. It MUTATES each feature, writing `name` (and
 *  `family`) onto its properties, and RETURNS a fresh `countryLabels` point layer —
 *  one label per country at its territorial centroid, since the borders source is a
 *  single borders-only line with no per-country features to hang a name on
 *  (see the Phase 6 / Phase 9 notes in docs/world-plan.md).
 *
 *  COORDINATES match the rest of the pipeline exactly: cell (x,y) centres at
 *  lon = -180 + (x+0.5)/W*360, lat = 90 - (y+0.5)/H*180; x wraps, y clamps.
 * ------------------------------------------------------------------ */

import { CONTINENTS, NEW_CONTINENTS, FAMILY_ANCHORS } from "./geo-regions.js";

// ---- language families ----------------------------------------------------
// Each family is a tiny phonotactic grammar: consonant onsets, vowel nuclei,
// syllable-coda consonants, and a set of place-name suffixes, plus how many
// syllables a stem runs to. The clusters are chosen so the families read as
// recognisably different "languages" — a Nordic one bristles with -fjord/-vik
// and hard clusters, an Oceanic one is all open vowels, etc. Purely flavour; the
// generator only ever samples these arrays, so adding a family is additive.
const FAMILIES = [
  {
    key: "verdane", // Romance / Latinate
    onset: ["b", "br", "c", "d", "f", "g", "l", "m", "n", "p", "r", "s", "t", "v", "tr", "gr", "fl"],
    nucleus: ["a", "e", "i", "o", "au", "ia", "io", "e", "a"],
    coda: ["", "n", "r", "l", "s", "", ""],
    suffix: ["ia", "a", "o", "or", "es", "ena", "ova"],
    syl: [2, 3],
  },
  {
    key: "fjordic", // Nordic
    onset: ["sk", "th", "b", "d", "f", "g", "h", "k", "r", "s", "t", "v", "str", "skj", "bj", "fr", "gn"],
    nucleus: ["a", "o", "u", "y", "au", "o", "a", "ei"],
    coda: ["rn", "ld", "ng", "fr", "k", "r", "n", "ss", ""],
    suffix: ["vik", "fell", "heim", "gard", "mark", "ness", "fjord"],
    syl: [1, 2],
  },
  {
    key: "vossk", // Slavic
    onset: ["v", "z", "kr", "br", "gr", "sl", "dr", "pr", "r", "m", "n", "st", "zv", "vl"],
    nucleus: ["a", "o", "e", "i", "u", "ia"],
    coda: ["v", "sk", "r", "n", "l", "sh", ""],
    suffix: ["ov", "sk", "grad", "in", "aya", "itsa"],
    syl: [2, 3],
  },
  {
    key: "qaram", // arid / Semitic
    onset: ["q", "z", "s", "h", "kh", "m", "n", "r", "sh", "b", "d", "gh", "th"],
    nucleus: ["a", "aa", "i", "u", "a", "ai"],
    coda: ["r", "n", "m", "l", "d", "f", ""],
    suffix: ["ah", "im", "an", "ar", "un", "iya"],
    syl: [2, 3],
    article: 0.22, // chance of an "Al " prefix
  },
  {
    key: "manako", // Oceanic / Polynesian — open syllables
    onset: ["m", "n", "k", "l", "t", "p", "h", "v", "w", "r", ""],
    nucleus: ["a", "e", "i", "o", "u", "a", "ai", "oa", "au"],
    coda: [""],
    suffix: ["a", "i", "oa", "ua", "ana"],
    syl: [2, 3],
  },
  {
    key: "shenlu", // East-Asian-ish — short
    onset: ["sh", "ch", "k", "t", "s", "h", "l", "m", "n", "y", "z", "j", "g"],
    nucleus: ["a", "e", "i", "o", "u", "ai", "ei", "ao", "ou"],
    coda: ["ng", "n", "", ""],
    suffix: ["", "u", "o", "an", "ong", "ai"],
    syl: [1, 2],
  },
];

// ---- deterministic PRNG + hashing -----------------------------------------
// mulberry32: same seed → same stream, the whole point of "same seed → same
// names". hash folds a list of parts (seed, role, coords…) into a 32-bit number
// that seeds a name — so a feature's name is a pure function of its identity.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(...parts) {
  const str = parts.join(":");
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const pick = (rng, arr) => arr[(rng() * arr.length) | 0];

// lon/lat → unit vector, so distances and centroids respect the antimeridian and
// the poles (a plain lon average would tear at ±180°).
function ll2v(lon, lat) {
  const a = (lon * Math.PI) / 180, b = (lat * Math.PI) / 180, cb = Math.cos(b);
  return [cb * Math.cos(a), cb * Math.sin(a), Math.sin(b)];
}
const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];

// ---- a single name --------------------------------------------------------
// Build a stem of a few syllables in the family's style, then (usually) a place
// suffix. Seeded by `seedNum`, so the same number always yields the same name.
function makeName(seedNum, fam) {
  const rng = mulberry32(seedNum >>> 0);
  const [smin, smax] = fam.syl;
  const n = smin + ((rng() * (smax - smin + 1)) | 0);
  let s = "";
  for (let i = 0; i < n; i++) {
    const on = pick(rng, fam.onset);
    const nu = pick(rng, fam.nucleus);
    const co = i === n - 1 ? "" : pick(rng, fam.coda);
    s += on + nu + co;
  }
  if (fam.suffix && rng() < 0.85) s += pick(rng, fam.suffix);
  s = s.replace(/(.)\1\1+/g, "$1$1"); // collapse triple letters
  if (s.length < 2) s += pick(rng, fam.nucleus); // never a bare consonant
  let name = cap(s);
  if (fam.article && rng() < fam.article) name = "Al " + name;
  return name;
}

// family key → index into FAMILIES, so the geographic anchors (which name their
// family by key, not position) resolve to the array the generator samples.
const FAMILY_IDX = Object.fromEntries(FAMILIES.map((f, i) => [f.key, i]));

// ---- geographic family assignment -----------------------------------------
// Pin the families to their REAL cultural homelands (see geo-regions.js) and give
// each country its nearest anchor's family. Because the anchors sit at fixed Earth
// coordinates, an Asian-sounding family falls near where Asia is today, a Nordic
// one near Scandinavia, and neighbouring countries share a phonetic feel — the
// language map mirrors Earth instead of reshuffling per seed (the seed still
// drives the actual names, just not which family lands where).
function assignFamilies(reps) {
  const fam = new Map();
  if (!reps.length) return fam;

  const anchors = FAMILY_ANCHORS.map((a) => ({
    v: ll2v(a.lon, a.lat),
    fam: FAMILY_IDX[a.fam] ?? 0,
  }));

  for (const r of reps) {
    const v = ll2v(r.lon, r.lat);
    let best = -Infinity, bf = anchors[0].fam;
    for (const a of anchors) {
      const d = dot(v, a.v);
      if (d > best) { best = d; bf = a.fam; }
    }
    fam.set(r.id, bf);
  }
  return fam;
}

// Continent-scale basins are named after the land they drowned, not given a
// syllabic lake name. The lakes layer filters its labels by this same floor so the
// two never double up (see world.js). 5 Mkm² keeps the true continents (Australia
// up) and leaves big islands (Greenland, Borneo) as ordinary named lakes.
export const CONT_FLOOR_KM2 = 5_000_000;

// ---- the world naming pass ------------------------------------------------
/**
 * Name a whole generated world in place. Mutates `cities`/`rivers`/`lakes`
 * feature properties (adds `name` + `family`) and returns a new `countryLabels`
 * point FeatureCollection (one label per country at its territorial centroid).
 *
 * @param {object} a
 * @param {number} a.seed                world seed (determinism anchor)
 * @param {Int32Array|null} a.owner      cell → country id (-1 = sea/wilderness)
 * @param {Uint8Array} a.isLand          cell → 1 on land
 * @param {number} a.W
 * @param {number} a.H
 * @param {object} a.cities              cities FeatureCollection (mutated)
 * @param {object} a.rivers              rivers FeatureCollection (mutated)
 * @param {object} a.lakes               lakes FeatureCollection (mutated)
 * @returns {{ countryLabels: object }}
 */
export function nameWorld({ seed, owner, isLand, W, H, cities, rivers, lakes }) {
  const N = W * H;
  const toLon = (x) => -180 + ((x + 0.5) / W) * 360;
  const toLat = (y) => 90 - ((y + 0.5) / H) * 180;
  const cellAt = (lon, lat) => {
    let x = Math.round(((lon + 180) / 360) * W - 0.5); x = ((x % W) + W) % W;
    let y = Math.round(((90 - lat) / 180) * H - 0.5); if (y < 0) y = 0; else if (y >= H) y = H - 1;
    return y * W + x;
  };

  // --- per-country representative point: the unit-vector centroid of its owned
  // land cells, mapped back to lon/lat. Robust across the antimeridian/poles and
  // good enough as a label anchor (a true pole-of-inaccessibility is deferred).
  const acc = new Map(); // id → { x, y, z, n }
  if (owner) {
    for (let c = 0; c < N; c++) {
      const o = owner[c];
      if (o < 0 || !isLand[c]) continue;
      const x = c % W, y = (c / W) | 0;
      const v = ll2v(toLon(x), toLat(y));
      let g = acc.get(o);
      if (!g) { g = { x: 0, y: 0, z: 0, n: 0 }; acc.set(o, g); }
      g.x += v[0]; g.y += v[1]; g.z += v[2]; g.n++;
    }
  }
  const reps = [];
  for (const [id, g] of acc) {
    const len = Math.hypot(g.x, g.y, g.z) || 1;
    reps.push({
      id,
      lon: (Math.atan2(g.y, g.x) * 180) / Math.PI,
      lat: (Math.asin(g.z / len) * 180) / Math.PI,
      size: g.n,
    });
  }

  const famByCountry = assignFamilies(reps);

  // nearest country's family, for features sitting on sea/wilderness (owner < 0).
  const repV = reps.map((r) => ({ id: r.id, v: ll2v(r.lon, r.lat) }));
  const nearestFam = (lon, lat) => {
    if (!repV.length) return 0;
    const v = ll2v(lon, lat);
    let best = -Infinity, bf = 0;
    for (const r of repV) {
      const d = dot(v, r.v);
      if (d > best) { best = d; bf = famByCountry.get(r.id) ?? 0; }
    }
    return bf;
  };
  const famAt = (lon, lat) => {
    const o = owner ? owner[cellAt(lon, lat)] : -1;
    if (o >= 0 && famByCountry.has(o)) return famByCountry.get(o);
    return nearestFam(lon, lat);
  };

  // shared uniqueness pool so the world reads as distinct names where it's cheap;
  // re-rolls a few salted variants on a clash, then accepts (a rare repeat is
  // realistic and not worth an unbounded search).
  const used = new Set();
  const uniq = (salt, famIdx) => {
    const f = FAMILIES[famIdx] ?? FAMILIES[0];
    for (let t = 0; t < 8; t++) {
      const nm = makeName(hash(seed, salt, t), f);
      if (!used.has(nm)) { used.add(nm); return nm; }
    }
    const nm = makeName(hash(seed, salt, 99), f);
    used.add(nm);
    return nm;
  };

  // --- country labels ---
  const labelFeatures = [];
  for (const r of reps) {
    const fi = famByCountry.get(r.id) ?? 0;
    const nm = uniq(`C${r.id}`, fi);
    labelFeatures.push({
      type: "Feature",
      properties: { name: nm, country: r.id, family: FAMILIES[fi].key, size: r.size },
      geometry: { type: "Point", coordinates: [r.lon, r.lat] },
    });
  }
  const countryLabels = { type: "FeatureCollection", features: labelFeatures };

  // --- cities: family from the owning country (or nearest, for frontier towns) ---
  for (const f of cities?.features ?? []) {
    const [lon, lat] = f.geometry.coordinates;
    const o = f.properties?.country;
    const fi = o >= 0 && famByCountry.has(o) ? famByCountry.get(o) : nearestFam(lon, lat);
    f.properties = f.properties || {};
    f.properties.name = uniq(`y${Math.round(lon * 50)},${Math.round(lat * 50)}`, fi);
    f.properties.family = FAMILIES[fi].key;
  }

  // --- rivers: family of the territory most of the channel runs through ---
  for (const f of rivers?.features ?? []) {
    const co = f.geometry?.coordinates;
    if (!co?.length) continue;
    const mid = co[(co.length / 2) | 0];
    const tally = new Map();
    const stride = Math.max(1, (co.length / 5) | 0);
    for (let i = 0; i < co.length; i += stride) {
      const o = owner ? owner[cellAt(co[i][0], co[i][1])] : -1;
      if (o >= 0) tally.set(o, (tally.get(o) || 0) + 1);
    }
    let bo = -1, bn = 0;
    for (const [o, n] of tally) if (n > bn) { bn = n; bo = o; }
    const fi = bo >= 0 && famByCountry.has(bo) ? famByCountry.get(bo) : nearestFam(mid[0], mid[1]);
    f.properties = f.properties || {};
    f.properties.name = uniq(`r${Math.round(mid[0] * 50)},${Math.round(mid[1] * 50)}`, fi);
    f.properties.family = FAMILIES[fi].key;
  }

  // --- lakes: family of the surrounding land (nearest country to the centroid) ---
  for (const f of lakes?.features ?? []) {
    const ring = f.geometry?.coordinates?.[0];
    if (!ring?.length) continue;
    let sx = 0, sy = 0;
    for (const p of ring) { sx += p[0]; sy += p[1]; }
    const lon = sx / ring.length, lat = sy / ring.length;
    const fi = famAt(lon, lat);
    f.properties = f.properties || {};
    f.properties.name = uniq(`l${Math.round(lon * 50)},${Math.round(lat * 50)}`, fi);
    f.properties.family = FAMILIES[fi].key;
  }

  // --- ocean labels: name each drowned continent's basin after the land it was ---
  // In the inverted world a continent's footprint is now water, so a label dropped
  // at that footprint names the new sea after the continent AND sits exactly where
  // it lies today. We only place one where the spot is actually water — a normal,
  // un-inverted world has land here, so the loop skips it and emits no ocean names.
  const waterFracAround = (lon, lat) => {
    if (!isLand) return 1;
    let water = 0, total = 0;
    for (let dy = -6; dy <= 6; dy += 3) {
      for (let dx = -6; dx <= 6; dx += 3) {
        total++;
        if (!isLand[cellAt(lon + dx, lat + dy)]) water++;
      }
    }
    return total ? water / total : 0;
  };
  const oceanFeatures = [];
  for (const cont of CONTINENTS) {
    if (waterFracAround(cont.lon, cont.lat) < 0.5) continue;
    oceanFeatures.push({
      type: "Feature",
      properties: { name: `${cont.adj} Ocean`, continent: cont.key },
      geometry: { type: "Point", coordinates: [cont.lon, cont.lat] },
    });
  }
  const oceanLabels = { type: "FeatureCollection", features: oceanFeatures };

  // --- continent labels: the risen oceans, named where each ocean is today ---
  // The exact mirror of the ocean pass: today's ocean floor is the new land, so a
  // label at an ocean's centre names the continent it became. Only placed where the
  // spot is now land (mostly dry around the anchor) — water there means an
  // un-inverted world, and the loop emits nothing.
  const continentFeatures = [];
  for (const cont of NEW_CONTINENTS) {
    if (waterFracAround(cont.lon, cont.lat) > 0.5) continue;
    continentFeatures.push({
      type: "Feature",
      properties: { name: cont.name, continent: cont.key },
      geometry: { type: "Point", coordinates: [cont.lon, cont.lat] },
    });
  }
  const continentLabels = { type: "FeatureCollection", features: continentFeatures };

  return { countryLabels, oceanLabels, continentLabels };
}

// exported for any future debugging / styling per family
export const FAMILY_KEYS = FAMILIES.map((f) => f.key);
